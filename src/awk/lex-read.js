// The tokens ./lex.js reads character by character, as gawk's yylex()
// reads them: operators, names and keywords, strings and regex bodies.

import { AT_GAP, AwkError, BUILTINS } from './common.js'
import { scanNumber, unescapeAwkString } from './strings.js'

// The words gawk reads after `@` as a directive or `@eval`.
const AT_WORDS = new Set(['include', 'load', 'namespace', 'eval'])

const KEYWORDS = {
  __proto__: null,
  BEGIN: 'LEX_BEGIN', BEGINFILE: 'LEX_BEGINFILE', END: 'LEX_END', ENDFILE: 'LEX_ENDFILE', break: 'LEX_BREAK',
  case: 'LEX_CASE', continue: 'LEX_CONTINUE', default: 'LEX_DEFAULT', delete: 'LEX_DELETE', do: 'LEX_DO',
  else: 'LEX_ELSE', exit: 'LEX_EXIT', for: 'LEX_FOR', func: 'LEX_FUNCTION', function: 'LEX_FUNCTION',
  getline: 'LEX_GETLINE', if: 'LEX_IF', in: 'LEX_IN', length: 'LEX_LENGTH', next: 'LEX_NEXT',
  nextfile: 'LEX_NEXTFILE', print: 'LEX_PRINT', printf: 'LEX_PRINTF', return: 'LEX_RETURN', switch: 'LEX_SWITCH',
  while: 'LEX_WHILE',
}

// gawk's extensions, whose names a function's parameters may take.
const GAWK_ONLY = new Set([
  'BEGINFILE', 'ENDFILE', 'and', 'asort', 'asorti', 'bindtextdomain', 'case', 'compl', 'dcgettext',
  'dcngettext', 'default', 'gensub', 'isarray', 'lshift', 'mkbool', 'mktime', 'or', 'patsplit', 'rshift',
  'strftime', 'strtonum', 'switch', 'systime', 'typeof', 'xor',
])

const isDigit = (c) => c !== null && c >= '0' && c <= '9'
const isNameChar = (c) => c !== null && /[A-Za-z0-9_]/u.test(c)

// An operator's token, its second character read only if it can be one;
// null for a character that starts no operator.
export function operator(lx, c) {
  const next = (d) => { if (lx.nextc() === d) return true; lx.pushback(); return false }
  const print = lx.state.inPrint && lx.state.inParens === 0
  switch (c) {
    case '*':
      if (next('=')) return lx.token('ASSIGNOP', '*=')
      if (!next('*')) return lx.token('*')
      // `**=` is the one token gawk returns without noting it as the last.
      return next('=') ? lx.token('ASSIGNOP', '^=', false) : lx.token('^')
    case '/':
      if (lx.nextc(false) === '=') { lx.pushback(); return lx.token('SLASH_BEFORE_EQUAL') }
      lx.pushback()
      return lx.token('/')
    case '%': return next('=') ? lx.token('ASSIGNOP', '%=') : lx.token('%')
    case '^': return next('=') ? lx.token('ASSIGNOP', '^=') : lx.token('^')
    case '+': return next('=') ? lx.token('ASSIGNOP', '+=') : next('+') ? lx.token('INCREMENT', '++') : lx.token('+')
    case '-': return next('=') ? lx.token('ASSIGNOP', '-=') : next('-') ? lx.token('DECREMENT', '--') : lx.token('-')
    case '!': return next('=') ? lx.token('RELOP', '!=') : next('~') ? lx.token('MATCHOP', '!~') : lx.token('!')
    case '<': return next('=') ? lx.token('RELOP', '<=') : lx.token('<')
    case '=': return next('=') ? lx.token('RELOP', '==') : lx.token('ASSIGN', '=')
    case '>':
      if (next('=')) return lx.token('RELOP', '>=')
      if (next('>')) return lx.token('IO_OUT', '>>')
      return print ? lx.token('IO_OUT', '>') : lx.token('>')
    case '~': return lx.token('MATCHOP', '~')
    case '&':
      if (!next('&')) return lx.token('&')
      lx.allowNewline()
      return lx.token('LEX_AND')
    case '|':
      if (next('|')) { lx.allowNewline(); return lx.token('LEX_OR') }
      if (next('&')) return lx.token(print ? 'IO_OUT' : 'IO_IN', '|&')
      return lx.token(print ? 'IO_OUT' : 'IO_IN', '|')
    case '.': {
      const d = lx.nextc()
      lx.pushback()
      if (!isDigit(d)) return lx.token('.')
      return number(lx)
    }
    default: return isDigit(c) ? number(lx) : null
  }
}

function number(lx) {
  const { value, end } = scanNumber(lx.text, lx.i - 1)
  lx.i = end
  return lx.token('YNUMBER', value)
}

// A name: a keyword, a builtin, a function call (a name followed at once
// by `(`) or a plain name. `_"..."` is a string (gawk's translatable one).
export function word(lx, c) {
  if (c.codePointAt(0) > 127) throw new AwkError(`invalid character \`${String.fromCodePoint(lx.text.codePointAt(lx.i - 1))}' in the program`, lx.line, 'non-ASCII program character')
  if (!/[A-Za-z_]/u.test(c)) return lx.syntaxError(`invalid char '${c}' in expression`)
  if (c === '_' && lx.lasttok !== '$') {
    if (lx.nextc() === '"') return string(lx)
    lx.pushback()
  }
  const start = lx.i - 1
  let d = lx.nextc()
  while (isNameChar(d)) d = lx.nextc()
  if (d === ':' && lx.text[lx.i] === ':') throw new AwkError('namespaces are not supported', lx.line, 'namespaces')
  lx.pushback()
  const name = lx.text.slice(start, lx.i)
  if (lx.lasttok === '@' && AT_WORDS.has(name)) throw new AwkError(AT_GAP, lx.line, '@ extensions')
  const kind = keyword(lx, name)
  if (kind !== null) return lx.token(kind, name)
  return lx.token(lx.text[lx.i] === '(' ? 'FUNC_CALL' : 'NAME', name)
}

// gawk's keyword table lookup. A gawk extension's name is a plain name
// where a function's parameter may hold it: in the parameter list, and in
// the body once a parameter has it.
function keyword(lx, name) {
  const kind = KEYWORDS[name] ?? (BUILTINS.has(name) ? 'LEX_BUILTIN' : null)
  if (kind === null) return null
  const { state } = lx
  if (GAWK_ONLY.has(name)) {
    if (state.wantParamNames === 'header') return null
    if (state.wantParamNames === 'body' && state.isParam(name)) return null
  }
  if (name === 'do' || name === 'for' || name === 'while') { state.breakAllowed++; state.continueAllowed++ }
  if (name === 'switch') state.breakAllowed++
  if (name === 'continue' && state.continueAllowed === 0) state.error("`continue' is not allowed outside a loop", lx.line)
  if (name === 'break' && state.breakAllowed === 0) state.error("`break' is not allowed outside a loop or switch", lx.line)
  return kind
}

// A string constant: continued lines joined, escapes decoded, gawk's
// warnings about them given as it reads them.
export function string(lx) {
  let raw = ''
  for (;;) {
    let c = lx.nextc(false)
    if (c === '"') break
    if (c === '\n') { lx.pushback(); return lx.syntaxError('unterminated string') }
    if (c === '\\') {
      c = lx.nextc()
      if (c === '\r') c = lx.nextc()
      if (c === '\n') { lx.line++; continue }
      raw += '\\'
    }
    if (c === null) { lx.pushback(); return lx.syntaxError('unterminated string') }
    raw += c
  }
  const value = unescapeAwkString(raw, (msg, once) => lx.state.warn(msg, once, lx.line))
  return lx.token('YSTRING', value)
}

// A regex body, up to the `/` that ends it — not one inside brackets, as
// gawk counts them (`[:` opens a class as well as `[` outside any) — with
// continued lines joined and escapes kept for the regex compiler.
export function regexp(lx) {
  lx.state.wantRegexp = false
  let raw = ''
  let depth = 0
  let open = -1
  for (;;) {
    let c = lx.nextc(false)
    const at = raw.length
    if (c === '[') {
      if (lx.nextc(false) === ':' || depth === 0) {
        depth++
        if (depth === 1) open = at
      }
      lx.pushback()
    } else if (c === ']') {
      if (!(depth > 0 && (at === open + 1 || (at === open + 2 && raw.at(-1) === '^')))) {
        depth--
        if (depth === 0) open = -1
      }
    } else if (c === '\\') {
      c = lx.nextc(false)
      if (c === null) { lx.pushback(); return lx.syntaxError("unterminated regexp ends with `\\' at end of file") }
      if (c === '\r') c = lx.nextc()
      if (c === '\n') { lx.line++; continue }
      raw += `\\${c}`
      continue
    } else if (c === '/' && depth <= 0) {
      return lx.token('REGEXP', raw)
    } else if (c === '\n') {
      lx.pushback()
      return lx.syntaxError('unterminated regexp')
    } else if (c === null) {
      lx.pushback()
      return lx.syntaxError('unterminated regexp at end of file')
    }
    raw += c
  }
}
