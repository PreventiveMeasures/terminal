// gawk's lexer (yylex() in awkgram.y), reading on demand: the grammar's
// actions change how it reads what comes next, so it reads a token only
// when the parser asks for one, as gawk's does.
//
// - A `/` is an operator token; once the grammar has taken it as the start
//   of a regex (state.wantRegexp), the next token is the regex body.
// - Inside `print` and `printf` (state.inPrint), outside parentheses, `>`
//   and `|` are redirections (IO_OUT); elsewhere a `|` is IO_IN, the pipe
//   into getline.
// - Every `}` comes after a NEWLINE token of its own, which ends the
//   statement before it; a `]` not followed at once by `[` is followed by a
//   SUBSCRIPT token; and newlines (and comments) after `&&`, `||` and, in a
//   `?:`, `?` and `:` are skipped.
// - `for`, `while`, `do` and `switch` raise the count of loops `break` and
//   `continue` may leave, which the grammar lowers when it has read the
//   statement; a `break` or `continue` read while that count is zero is an
//   error there and then.
//
// Each source ends with a NEWLINE (a program operand's text is read as if
// it ended in one) and a LEX_EOF; the grammar moves the lexer on to the
// next. Tokens are { type, value, line, pos, src }: the grammar's name for
// it, its value, the line gawk counts it on, and where it starts.
//
// What gawk prints for a syntax error is yyerror()'s: the line holding the
// last token read and a caret under it (syntaxError below). The state's
// `warn` and `error` take what the lexer has to say along the way.

import { AT_GAP, AwkError } from './common.js'
import { operator, regexp, string, word } from './lex-read.js'

export { unescapeAwkString } from './strings.js'

// Control characters gawk will not read in program text outside strings:
// all but the C escapes \a \b \t \n \v \f \r.
const isBadChar = (c) => { const n = c.codePointAt(0); return n <= 6 || (n >= 14 && n <= 31) || n === 127 }

const utf8Length = (ch) => { const c = ch.codePointAt(0); return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4 }

const NEWLINE_MESSAGE = 'unexpected newline or end of string'
const EOF_MESSAGE = 'source files / command-line arguments must contain complete functions or rules'

// The lexer reads `sources` as ./index.js gives them ({ name, text }, the
// name null for the program operand) and reads and updates the parser's
// `state` as gawk's lexer does its globals (./parse.js)
export class Lexer {
  constructor(sources, state) {
    this.sources = sources
    this.state = state
    this.didNewline = false
    this.qmColCount = 0
    this.open(0)
  }

  // gawk reads its program through a buffer, and what a syntax error shows
  // is what that buffer holds. A program operand is read as if it ended in
  // a newline: at the end of the text, gawk carries on in a copy of the
  // line it is in with a newline added (`refill`), and until the next token
  // starts, that copy is the line a syntax error shows (`thisline`). Its
  // search for the line's start stops short of the buffer's first
  // character, so a program that opens with an empty line shows that
  // newline as well. A -f file read to its end keeps the line it is in the
  // same way, unless that line is done, when the buffer is left empty
  // (`end`) — a syntax error there shows no line at all (fileEnd below).
  open(index) {
    this.src = index
    const { name, text } = this.sources[index]
    const refill = name === null && text !== '' && !text.endsWith('\n')
    this.text = refill ? `${text}\n` : text
    this.refillAt = refill ? text.length : -1
    this.isFile = name !== null
    this.end = this.text.length
    this.begin = 0
    this.thisline = null
    this.i = 0
    this.line = 1
    this.lexeme = 0
    this.lexeof = false
    this.lasttok = null
  }

  // The grammar has read a source's LEX_EOF: go on to the next, if any.
  nextSource() {
    if (this.src + 1 < this.sources.length) this.open(this.src + 1)
  }

  get name() { return this.sources[this.src].name ?? 'cmd. line' }

  nextc(checkBad = true) {
    if (this.i === this.refillAt) {
      this.refillAt = -1
      let scan = this.lexeme
      while (scan > 0 && this.text[scan] !== '\n') scan--
      if (scan > 0) scan++
      this.begin = scan
      this.thisline = scan
    }
    if (this.i >= this.text.length) {
      if (!this.lexeof && this.isFile) this.fileEnd()
      this.lexeof = true
      return null
    }
    const c = this.text[this.i++]
    if (checkBad && isBadChar(c)) this.fatal(`error: invalid character '\\${c.codePointAt(0).toString(8).padStart(3, '0')}' in source code`)
    return c
  }

  pushback() { if (!this.lexeof) this.i-- }

  fileEnd() {
    let scan = this.lexeme
    while (scan > this.begin) {
      if (this.text[scan] === '\n') { scan++; break }
      scan--
    }
    if (scan < this.text.length) {
      this.begin = scan
      this.thisline = scan
    } else {
      this.lexeme = this.begin
      this.end = this.begin
      this.thisline = null
    }
  }

  token(type, value = null, last = true) {
    if (last) this.lasttok = type
    return { type, value, line: this.line, pos: this.lexeme, src: this.src }
  }

  next() {
    if (this.lasttok === 'SUBSCRIPT') { this.lasttok = null; return this.token('SUBSCRIPT', null, false) }
    if (this.lasttok === 'LEX_EOF') return this.token('$end', null, false)
    if (this.nextc(!this.state.wantRegexp) === null) return this.newlineEof()
    this.pushback()
    this.lexeme = this.i
    this.thisline = null
    if (this.state.wantRegexp) return regexp(this)
    let c
    for (;;) {
      do c = this.nextc(); while (c === ' ' || c === '\t' || c === '\r')
      this.lexeme = this.i - 1
      this.thisline = null
      if (c !== '\\') break
      // A backslash ends a line to continue it; anything else after one is
      // an error.
      c = this.nextc()
      if (c === '\r') c = this.nextc()
      if (c !== '\n') return this.syntaxError('backslash not last character on line')
      this.line++
    }
    return this.dispatch(c)
  }

  // A source's end: the newline it may lack, then LEX_EOF.
  newlineEof() {
    if (this.lasttok !== 'NEWLINE') {
      this.pushback()
      this.line++
      return this.token('NEWLINE')
    }
    this.line--
    return this.token('LEX_EOF')
  }

  dispatch(c) {
    switch (c) {
      case null: return this.newlineEof()
      case '\n': this.line++; return this.token('NEWLINE')
      case '#': {
        let d
        do d = this.nextc(false); while (d !== null && d !== '\n')
        if (d === null) return this.newlineEof()
        this.line++
        return this.token('NEWLINE')
      }
      case '@':
        // A typed regex, read as one here; an indirect call or a source
        // directive is refused once the grammar has it (./lex-read.js).
        if (this.text[this.i] === '/') throw new AwkError(AT_GAP, this.line, '@ extensions')
        return this.token('@')
      case '?': case ':': return this.questionColon(c)
      case '(': this.state.inParens++; return this.token(c)
      case ')': this.state.inParens--; return this.token(c)
      case '$': case '{': case ';': case ',': case '[': return this.token(c)
      case ']': return this.closeBracket()
      case '}': return this.closeBrace()
      case '"': return string(this)
      default: return operator(this, c) ?? word(this, c)
    }
  }

  questionColon(c) {
    if (c === '?') this.qmColCount++
    if (this.qmColCount > 0) {
      this.allowNewline()
      if (c === ':') this.qmColCount--
    }
    return this.token(c)
  }

  closeBracket() {
    const c = this.nextc()
    this.pushback()
    const t = this.token(']')
    if (c !== '[') this.lasttok = 'SUBSCRIPT'
    return t
  }

  closeBrace() {
    if (this.didNewline) {
      this.didNewline = false
      return this.token('}')
    }
    this.didNewline = true
    this.i--
    return this.token('NEWLINE')
  }

  // Newlines and comments are skipped after `&&`, `||`, and `?` and `:`.
  allowNewline() {
    for (;;) {
      let c = this.nextc()
      if (c === null) { this.pushback(); return }
      if (c === '#') {
        do c = this.nextc(false); while (c !== null && c !== '\n')
        if (c === null) { this.pushback(); return }
      }
      if (c === '\n') this.line++
      if (!/\s/u.test(c)) { this.pushback(); return }
    }
  }

  // Where messages put the program: `cmd. line:N: ` or the -f file's name.
  get at() { return this.line > 0 ? `awk: ${this.name}:${this.line}: ` : 'awk: ' }

  // gawk's yyerror(): the line holding the last token read (a newline token
  // is the end of the line before it, and its message gawk's own; past the
  // end of a source that is not a line at all), and a caret under the
  // token — a tab for a tab, a space for every other byte.
  syntaxError(message = 'syntax error') {
    const { text, lexeme } = this
    let mesg = null
    let cp = this.thisline
    if (cp === null) {
      cp = lexeme
      if (text[cp] === '\n') {
        if (cp > this.begin) cp--
        mesg = NEWLINE_MESSAGE
      }
      while (cp > this.begin && text[cp] !== '\n') cp--
      if (text[cp] === '\n') cp++
    }
    let bp = lexeme < cp ? cp + 1 : lexeme
    while (bp < this.end && text[bp] !== '\n') bp++
    let shown = text.slice(cp, bp)
    if (this.lexeof && mesg === null && message.startsWith('syntax error')) {
      shown = '(END OF FILE)'
      mesg = EOF_MESSAGE
    }
    let caret = ''
    for (const ch of text.slice(cp, lexeme)) caret += ch === '\t' ? '\t' : ' '.repeat(utf8Length(ch))
    const e = new AwkError(message, this.line, null, 'syntax')
    e.text = `${this.at}${shown}\n${this.at}${caret}^ ${mesg ?? message}\n`
    throw e
  }

  // gawk's fatal(), at its place in the program: exit 2.
  fatal(message) {
    const e = new AwkError(message, this.line, null, 'fatal')
    e.text = `${this.at}fatal: ${message}\n`
    throw e
  }
}
