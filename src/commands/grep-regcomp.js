// glibc's regcomp, as far as it decides whether a -G or -E pattern is one
// at all and which of its messages it gives when not: GNU grep hands it each
// pattern line on its own and names every line it rejects. This follows
// regcomp.c's parser — peek_token down to parse_bracket_symbol — keeping of
// its state only what an error depends on, and builds no matcher.
import { encodeUtf8Loose } from '../util.js'

// glibc's RE_DUP_MAX: no interval bound may exceed it.
export const DUP_MAX = 0x7fff

const MESSAGES = {
  BADPAT: 'Invalid regular expression',
  ECOLLATE: 'Invalid collation character',
  ECTYPE: 'Invalid character class name',
  EESCAPE: 'Trailing backslash',
  ESUBREG: 'Invalid back reference',
  EBRACK: 'Unmatched [, [^, [:, [., or [=',
  EPAREN: 'Unmatched ( or \\(',
  EBRACE: 'Unmatched \\{',
  BADBR: 'Invalid content of \\{\\}',
  ERANGE: 'Invalid range end',
  ESIZE: 'Regular expression too big',
  ERPAREN: 'Unmatched ) or \\)',
}

// An error of glibc's or the dfa's, which the caller reports in their words.
export function regError(message) {
  const e = new Error(message)
  e.gnuRegex = true
  return e
}
const fail = (code) => { throw regError(MESSAGES[code]) }

// The classes glibc knows by name. GNU's `[:word:]` is not one of them.
const CLASS_NAMES = new Set(['alpha', 'upper', 'lower', 'digit', 'xdigit', 'space', 'print', 'punct', 'graph', 'cntrl', 'blank', 'alnum'])

// glibc reads the pattern a byte at a time, and a byte past ASCII is never
// syntax: it is part of a character, which in a multibyte locale a bracket
// takes whole.
export const utf8Width = (lead) => (lead < 0xc0 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4)

const BRE_ESCAPES = { '|': 'ALT', '(': 'OPEN_SUB', ')': 'CLOSE_SUB', '+': 'DUP', '?': 'DUP', '{': 'OPEN_DUP', '}': 'CLOSE_DUP' }
const ERE_SPECIALS = { '|': 'ALT', '+': 'DUP', '?': 'DUP', '{': 'OPEN_DUP', '}': 'CLOSE_DUP', '(': 'OPEN_SUB', ')': 'CLOSE_SUB' }

// One token as peek_token reads it at `at`. `caret` is RE_CARET_ANCHORS_HERE,
// which the parser passes where an expression begins.
function peek(s, at, ext, caret) {
  if (at >= s.length) return { type: 'END', len: 0 }
  const c = s[at]
  if (c === 0x5c) {
    if (at + 1 >= s.length) return { type: 'BACK_SLASH', len: 1 }
    const c2 = s[at + 1]
    const ch = String.fromCodePoint(c2)
    let type = 'CHAR'
    if (/[1-9]/u.test(ch)) type = 'BACKREF'
    else if ('<>bB`\''.includes(ch)) type = 'ANCHOR'
    else if (!ext) type = BRE_ESCAPES[ch] ?? 'CHAR'
    return { type, c: c2, len: 2 }
  }
  const ch = String.fromCodePoint(c)
  let type = 'CHAR'
  if (c === 0x2a) type = 'DUP'
  else if (c === 0x5b) type = 'OPEN_BRACKET'
  else if (ext && ERE_SPECIALS[ch]) type = ERE_SPECIALS[ch]
  else if (c === 0x5e) type = ext || caret || at === 0 ? 'ANCHOR' : 'CHAR'
  else if (c === 0x24) {
    const next = at + 1 === s.length ? null : peek(s, at + 1, ext, false)
    type = ext || next === null || next.type === 'ALT' || next.type === 'CLOSE_SUB' ? 'ANCHOR' : 'CHAR'
  }
  return { type, c, len: 1 }
}

// The parser, from parse_reg_exp down: where it is, the token it holds, how
// many groups it has opened, and which of the first nine it has closed, which
// is what a backreference may name. With -i glibc reads the pattern
// upper-cased, so that is what a range in a bracket is ordered by.
class Parser {
  constructor(s, ext, multibyte, icase) {
    Object.assign(this, { s, ext, multibyte, icase, i: 0, tok: null, nsub: 0, completed: 0 })
  }

  fetch(caret = false) {
    this.tok = peek(this.s, this.i, this.ext, caret)
    this.i += this.tok.len
  }

  // Whether the token ends a branch here: an alternation, the end, or the
  // `)` of the group the branch is in.
  endsBranch(nest) {
    return this.tok.type === 'ALT' || this.tok.type === 'END' || (nest > 0 && this.tok.type === 'CLOSE_SUB')
  }

  regExp(nest) {
    const initial = this.completed
    this.branch(nest)
    while (this.tok.type === 'ALT') {
      this.fetch(true)
      if (this.endsBranch(nest)) continue
      const accumulated = this.completed
      this.completed = initial
      this.branch(nest)
      this.completed |= accumulated
    }
  }

  branch(nest) {
    this.expression(nest)
    while (!this.endsBranch(nest)) this.expression(nest)
  }

  expression(nest) {
    const { tok } = this
    if (tok.type === 'OPEN_SUB') this.subExp(nest + 1)
    else if (tok.type === 'OPEN_BRACKET') this.bracket()
    else if (tok.type === 'BACKREF' && !(this.completed & (1 << (tok.c - 0x31)))) fail('ESUBREG')
    else if (tok.type === 'OPEN_DUP' || tok.type === 'DUP') {
      // A repetition with nothing to repeat: an ERE passes over it, and a
      // BRE reads it as the character it is.
      if (this.ext) { this.fetch(); return this.expression(nest) }
    } else if (tok.type === 'CLOSE_SUB' && !this.ext) fail('ERPAREN')
    else if (tok.type === 'ANCHOR') {
      // Nothing repeats an anchor: what follows begins anew.
      this.fetch()
      return
    } else if (tok.type === 'ALT' || tok.type === 'END') return
    else if (tok.type === 'BACK_SLASH') fail('EESCAPE')
    this.fetch()
    while (this.tok.type === 'DUP' || this.tok.type === 'OPEN_DUP') this.dupOp()
  }

  subExp(nest) {
    const index = this.nsub++
    this.fetch(true)
    if (this.tok.type !== 'CLOSE_SUB') {
      this.regExp(nest)
      if (this.tok.type !== 'CLOSE_SUB') fail('EPAREN')
    }
    if (index <= 8) this.completed |= 1 << index
  }

  // An interval that does not read as one is an error in a BRE; an ERE takes
  // its `{` back as a character and reads on from there.
  dupOp() {
    if (this.tok.type === 'OPEN_DUP') {
      const startAt = this.i
      const startTok = this.tok
      let start = this.fetchNumber()
      let end = 0
      if (start === -1) {
        if (this.tok.type === 'CHAR' && this.tok.c === 0x2c) start = 0
        else fail('BADBR')
      }
      if (start !== -2) end = this.tok.type === 'CLOSE_DUP' ? start : this.tok.type === 'CHAR' && this.tok.c === 0x2c ? this.fetchNumber() : -2
      if (start === -2 || end === -2) {
        if (!this.ext) fail(this.tok.type === 'END' ? 'EBRACE' : 'BADBR')
        this.i = startAt
        this.tok = { ...startTok, type: 'CHAR' }
        return
      }
      if ((end !== -1 && start > end) || this.tok.type !== 'CLOSE_DUP') fail('BADBR')
      if (DUP_MAX < (end === -1 ? start : end)) fail('ESIZE')
    }
    this.fetch()
  }

  fetchNumber() {
    let num = -1
    for (;;) {
      this.fetch()
      const { tok } = this
      if (tok.type === 'END') return -2
      if (tok.type === 'CLOSE_DUP' || tok.c === 0x2c) return num
      const digit = tok.type === 'CHAR' && tok.c >= 0x30 && tok.c <= 0x39
      num = !digit || num === -2 ? -2 : num === -1 ? tok.c - 0x30 : Math.min(DUP_MAX + 1, num * 10 + tok.c - 0x30)
    }
  }

  upper(c) { return this.icase && c >= 0x61 && c <= 0x7a ? c - 0x20 : c }

  // parse_bracket_exp and the three below it. In a bracket a backslash is a
  // member like any other. (gnulib's copy reads `---` as one `-`, as V7 grep
  // did; glibc's, which grep is built with, does not.)
  bracketPeek() {
    const { s, i } = this
    if (i >= s.length) return { type: 'END', len: 0 }
    const c = s[i]
    if (c === 0x5b) {
      const type = { 0x2e: 'OPEN_COLL', 0x3d: 'OPEN_EQUIV', 0x3a: 'OPEN_CLASS' }[i + 1 < s.length ? s[i + 1] : 0]
      return type ? { type, c: s[i + 1], len: 2 } : { type: 'CHAR', c, len: 1 }
    }
    const type = { 0x5d: 'CLOSE', 0x5e: 'NON_MATCH', 0x2d: 'RANGE' }[c] ?? 'CHAR'
    return { type, c, len: 1 }
  }

  bracket() {
    let t = this.bracketPeek()
    if (t.type === 'END') fail('BADPAT')
    if (t.type === 'NON_MATCH') {
      this.i += t.len
      t = this.bracketPeek()
      if (t.type === 'END') fail('BADPAT')
    }
    if (t.type === 'CLOSE') t = { ...t, type: 'CHAR' }
    for (let first = true; ; first = false) {
      const start = this.bracketElement(t, first)
      t = this.bracketPeek()
      let end = null
      if (start.type !== 'CLASS' && start.type !== 'EQUIV') {
        if (t.type === 'END') fail('EBRACK')
        if (t.type === 'RANGE') {
          this.i += t.len
          const t2 = this.bracketPeek()
          if (t2.type === 'END') fail('EBRACK')
          if (t2.type === 'CLOSE') { this.i -= t.len; t = { ...t, type: 'CHAR' } } else {
            end = this.bracketElement(t2, true)
            t = this.bracketPeek()
          }
        }
      }
      this.bracketMember(start, end)
      if (t.type === 'END') fail('EBRACK')
      if (t.type === 'CLOSE') break
    }
    this.i += 1
  }

  bracketMember(start, end) {
    if (end) return range(start, end)
    if (start.type === 'CLASS') {
      const name = this.icase && (start.name === 'upper' || start.name === 'lower') ? 'alpha' : start.name
      if (!CLASS_NAMES.has(name)) fail('ECTYPE')
    } else if ((start.type === 'EQUIV' || start.type === 'COLL') && start.bytes !== 1) fail('ECOLLATE')
  }

  // A character past ASCII whose upper case is ASCII — `ı`, `ſ` — is that
  // one byte under -i.
  bracketElement(t, acceptHyphen) {
    const { s } = this
    if (this.multibyte && s[this.i] >= 0xc0) {
      const width = utf8Width(s[this.i])
      const character = new TextDecoder().decode(s.subarray(this.i, this.i + width))
      this.i += width
      const folded = this.icase ? character.toUpperCase() : ''
      return folded.length === 1 && folded.codePointAt(0) < 0x80 ? { type: 'SB', c: folded.codePointAt(0) } : { type: 'MB' }
    }
    this.i += t.len
    if (t.type === 'OPEN_COLL' || t.type === 'OPEN_CLASS' || t.type === 'OPEN_EQUIV') return this.bracketSymbol(t)
    if (t.type === 'RANGE' && !acceptHyphen && this.bracketPeek().type !== 'CLOSE') fail('ERANGE')
    return { type: 'SB', c: this.upper(t.c) }
  }

  // [:name:], [.name.] and [=name=], at most 31 bytes of name.
  bracketSymbol(t) {
    const { s } = this
    if (this.i >= s.length) fail('EBRACK')
    const bytes = []
    for (let n = 0; ; n++) {
      if (n >= 32) fail('EBRACK')
      const ch = s[this.i++]
      if (this.i >= s.length) fail('EBRACK')
      if (ch === t.c && s[this.i] === 0x5d) break
      bytes.push(ch)
    }
    this.i++
    const type = { OPEN_COLL: 'COLL', OPEN_EQUIV: 'EQUIV', OPEN_CLASS: 'CLASS' }[t.type]
    return { type, name: String.fromCodePoint(...bytes), bytes: bytes.length, c: this.upper(bytes[0]) }
  }
}

// C.UTF-8 has no collation rules, so a range is ordered by the bytes of a
// single-byte endpoint and cannot have one past ASCII at all.
function range(start, end) {
  if ([start.type, end.type].some((type) => type === 'EQUIV' || type === 'CLASS')) fail('ERANGE')
  const seq = (e) => (e.type === 'SB' || (e.type === 'COLL' && e.bytes === 1) ? e.c : -1)
  if (seq(start) < 0 || seq(end) < 0) fail('ECOLLATE')
  if (seq(start) > seq(end)) fail('ERANGE')
}

// The message glibc gives for one pattern line, or null where it takes it.
export function regcompError(pattern, extended, multibyte = true, icase = false) {
  const parser = new Parser(encodeUtf8Loose(pattern), extended, multibyte, icase)
  try {
    parser.fetch(true)
    parser.regExp(0)
    return null
  } catch (e) {
    if (e.gnuRegex) return e.message
    throw e
  }
}
