// ripgrep's patterns are Rust's regex syntax (regex-syntax 0.8, as ripgrep
// 14.1 has it), not PCRE's, and a search here runs them as `grep -P` does.
// The two agree on a core and part ways around it — `\<` is a word edge in
// Rust and a `<` in PCRE, `[a[bc]]` a nested class in one and a class and a
// `]` in the other, `a**` a pattern in one and an error in the other — so a
// pattern is read here against an allow-list of what has been checked to
// mean the same in both, and spelt for PCRE where the spelling differs. Any
// other construct is refused. ripgrep parses its patterns joined as it shows
// them, `(?:p1)|(?:p2)`, and so does this, which keeps a pattern that reaches
// across that joint — `-e ( -e )` — reading as ripgrep reads it.
//
// A pattern Rust rejects gets ripgrep's own report where the fault is one of
// those followed here exactly and the first one Rust meets, with nothing
// before it that this does not understand; it is refused otherwise.

import { err } from '../result.js'
import { unsupported } from '../unsupported.js'

const HINT = '\n\nConsider enabling PCRE2 with the --pcre2 flag, which can handle backreferences\nand look-around.'
const NEWLINE = 'rg: the literal "\\n" is not allowed in a regex\n\nConsider enabling multiline mode with the --multiline flag (or -U for short).\nWhen multiline mode is enabled, new line characters can be matched.\n'

// A count past this is refused: Rust takes far larger ones, and PCRE none
// past 65535.
const MAX_COUNT = 1000

// Why the reading stopped: a fault Rust reports, `[from, to)` in characters
// of the joined pattern, or a construct this does not follow.
const Stop = {
  fault: (message, from, to = from + 1, hint = '') => Object.assign(new Error(message), { stop: true, from, to, hint }),
  gap: (detail) => Object.assign(new Error(detail), { stop: true, detail }),
}

// ASCII other than letters, digits, `<` and `>`, which Rust lets a backslash
// make literal; it keeps letters and digits for syntax of its own, and `<`
// and `>` are word edges.
const escapable = (c) => c.codePointAt(0) < 0x80 && !/[0-9A-Za-z<>]/u.test(c)
const CONTROLS = { a: '\\x{7}', f: '\\x{c}', t: '\\x{9}', r: '\\x{d}', v: '\\x{b}' }
const HEX_WIDTH = { x: 2, u: 4, U: 8 }

// The joined pattern, read left to right as Rust's parser reads it, with its
// PCRE spelling built in `out`.
class Reader {
  constructor(text) {
    this.s = [...text]
    this.i = 0
    this.out = ''
    this.names = new Set()
    this.newline = false
  }

  get c() { return this.s[this.i] }

  // A sequence of alternatives, up to the end or a `)`.
  alternation() {
    for (;;) {
      this.concat()
      if (this.c !== '|') return
      this.out += '|'
      this.i++
    }
  }

  // What a repetition would repeat is the last atom; one after an
  // assertion or another repetition Rust takes and PCRE does not.
  concat() {
    let last = null
    while (this.c !== undefined && this.c !== '|' && this.c !== ')') {
      if ('*+?{'.includes(this.c)) {
        if (last === null) throw Stop.fault('repetition operator missing expression', this.i)
        if (last !== 'atom') throw Stop.gap('a repetition of an assertion or of a repetition')
        this.repetition()
        last = 'repetition'
      } else last = this.atom()
    }
  }

  repetition() {
    if (this.c === '{') {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/u.exec(this.s.slice(this.i, this.i + 24).join(''))
      if (!m) throw Stop.gap('a repetition count')
      const min = Number(m[1])
      const max = m[3] ? Number(m[3]) : null
      // Rust's span of a bad range takes in the `?` that makes it lazy.
      const lazy = this.s[this.i + m[0].length] === '?' ? 1 : 0
      if (max !== null && max < min) throw Stop.fault('invalid repetition count range, the start must be <= the end', this.i, this.i + m[0].length + lazy)
      if (min > MAX_COUNT || max > MAX_COUNT) throw Stop.gap('a repetition count')
      this.out += m[0]
      this.i += m[0].length
    } else this.out += this.s[this.i++]
    if (this.c === '?') { this.out += '?'; this.i++ }
  }

  atom() {
    const c = this.c
    if (c === '(') return this.group()
    if (c === '[') return this.cls()
    if (c === '\\') return this.escape(false).kind === 'assertion' ? 'assertion' : 'atom'
    this.i++
    if (c === '^' || c === '$') { this.out += c; return 'assertion' }
    if (c === '\n') throw Stop.gap('a newline in a pattern')
    this.out += c === ']' || c === '}' ? '\\' + c : c
    return 'atom'
  }

  group() {
    const start = this.i
    const rest = this.s.slice(this.i, this.i + 40).join('')
    const look = /^\(\?<?[=!]/u.exec(rest)
    if (look) throw Stop.fault('look-around, including look-ahead and look-behind, is not supported', start, start + look[0].length, HINT)
    const opener = /^\((?:\?:|\?P?<([A-Za-z_][0-9A-Za-z_]*)>)?/u.exec(rest)
    if (opener[0] === '(' && rest[1] === '?') throw Stop.gap('a group with flags')
    const name = opener[1]
    if (name !== undefined) {
      if (this.names.has(name)) throw Stop.gap('a duplicate capture group name')
      this.names.add(name)
    }
    this.out += name === undefined ? opener[0] : `(?<${name}>`
    this.i += opener[0].length
    this.alternation()
    // An open group at the end is the innermost one Rust names.
    if (this.c === undefined) throw Stop.fault('unclosed group', start)
    this.out += ')'
    this.i++
    // The joint's own group, when it is the whole pattern, is left off the
    // spelling, which keeps a literal reading as one.
    if (start === 0 && this.c === undefined) this.out = this.out.slice(3, -1)
    return 'atom'
  }

  // A bracket: Rust's nested classes, its `&&`, `--` and `~~` and its
  // POSIX names are refused, as is a `-` that is not a simple range, nor
  // leading, nor last.
  cls() {
    const start = this.i
    this.out += '['
    this.i++
    if (this.c === '^') { this.out += '^'; this.i++ }
    // Any number of `-` here are members, and failing those a `]` is one;
    // Rust counts them into the bracket's opening.
    const dashes = this.i
    while (this.c === '-') { this.out += '\\-'; this.i++ }
    if (this.i === dashes && this.c === ']') { this.out += '\\]'; this.i++ }
    const open = this.i
    for (;;) {
      const c = this.c
      if (c === undefined) throw Stop.fault('unclosed character class', start, open)
      if (c === ']') break
      if (c === '[') throw Stop.gap('a nested character class')
      if (/^(?:&&|--|~~)$/u.test(c + (this.s[this.i + 1] ?? ''))) throw Stop.gap('a character class operation')
      if (c === '-' && this.s[this.i + 1] !== ']') throw Stop.gap('a `-` in a character class')
      this.classRange()
    }
    this.out += ']'
    this.i++
    return 'atom'
  }

  // Rust reads both ends of a range before it asks whether either is one
  // character.
  classRange() {
    const from = this.i
    const first = this.classItem()
    const firstEnd = this.i
    if (this.c !== '-' || this.s[this.i + 1] === ']' || this.s[this.i + 1] === '-' || this.s[this.i + 1] === undefined) return
    this.out += '-'
    this.i++
    const endAt = this.i
    const last = this.classItem()
    if (first.kind !== 'literal') throw Stop.fault('invalid range boundary, must be a literal', from, firstEnd)
    if (last.kind !== 'literal') throw Stop.fault('invalid range boundary, must be a literal', endAt, this.i)
    if (last.code < first.code) throw Stop.fault('invalid character class range, the start must be <= the end', from, this.i)
  }

  classItem() {
    if (this.c === '\\') {
      const at = this.i
      const item = this.escape(true)
      if (item.kind === 'assertion') throw Stop.gap('an assertion in a character class')
      if (item.kind === 'newline') throw Stop.gap('a newline in a character class')
      return { ...item, at }
    }
    const c = this.s[this.i++]
    this.out += c === ']' || c === '[' || c === '^' ? '\\' + c : c
    return { kind: 'literal', code: c.codePointAt(0) }
  }

  // One escape, as `{ kind, code }`: 'literal', 'class', 'assertion' or
  // 'newline'.
  escape(inClass) {
    const at = this.i
    const c = this.s[this.i + 1]
    if (/^[0-9]$/u.test(c)) throw Stop.fault('backreferences are not supported', at, at + 2, HINT)
    if (c in HEX_WIDTH) return this.hex(c)
    this.i += 2
    if ('dDsSwW'.includes(c)) { this.out += '\\' + c; return { kind: 'class' } }
    if (escapable(c)) { this.out += '\\' + c; return { kind: 'literal', code: c.codePointAt(0) } }
    if (c in CONTROLS) { this.out += CONTROLS[c]; return { kind: 'literal', code: { a: 7, f: 12, t: 9, r: 13, v: 11 }[c] } }
    if (c === 'n') {
      this.newline = true
      this.out += '\\x{a}'
      return { kind: inClass ? 'newline' : 'literal', code: 10 }
    }
    if ('AzB'.includes(c) || (c === 'b' && this.c !== '{')) { this.out += '\\' + c; return { kind: 'assertion' } }
    // Rust's word edges, the start and the end of one, which PCRE has no
    // escape for.
    if (c === '<' || c === '>') {
      this.out += c === '<' ? '(?<!\\w)(?=\\w)' : '(?<=\\w)(?!\\w)'
      return { kind: 'assertion' }
    }
    if ('bpP'.includes(c)) throw Stop.gap(`\\${c}`)
    throw Stop.fault('unrecognized escape sequence', at, at + 2)
  }

  // \xHH, \uHHHH and \UHHHHHHHH, or any of them with braced digits.
  hex(kind) {
    this.i += 2
    const braced = this.c === '{'
    if (braced) this.i++
    const from = this.i
    const width = braced ? Infinity : HEX_WIDTH[kind]
    while (this.c !== undefined && /^[0-9A-Fa-f]$/u.test(this.c) && this.i - from < width) this.i++
    const digits = this.s.slice(from, this.i).join('')
    if (braced ? this.c !== '}' || digits === '' || digits.length > 8 : digits.length < HEX_WIDTH[kind]) {
      if (!braced && this.c !== undefined) throw Stop.fault('invalid hexadecimal digit', this.i)
      throw Stop.gap('a hexadecimal escape')
    }
    const code = parseInt(digits, 16)
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw Stop.fault('hexadecimal literal is not a Unicode scalar value', from, this.i)
    if (braced) this.i++
    this.out += `\\x{${code.toString(16)}}`
    if (code === 10) this.newline = true
    return { kind: code === 10 ? 'newline' : 'literal', code }
  }
}

// What a run makes of its patterns: `{ pattern }`, the one PCRE pattern
// meaning what they mean together, or `{ error }`, ripgrep's report of
// them or a refusal.
export function rgPattern(patterns) {
  const display = patterns.map((p) => `(?:${p})`).join('|')
  const reader = new Reader(display)
  try {
    reader.alternation()
    if (reader.c !== undefined) throw Stop.fault('unopened group', reader.i)
  } catch (e) {
    if (!e.stop) throw e
    if (e.detail) return { error: unsupported('feature', 'rg', 'Rust regex syntax', `rg: ${e.detail} in a pattern is not supported: ripgrep reads it by Rust's regex syntax, not PCRE's`, 2) }
    const carets = ' '.repeat(4 + e.from) + '^'.repeat(Math.max(1, e.to - e.from))
    return { error: err(`rg: regex parse error:\n    ${display}\n${carets}\nerror: ${e.message}${e.hint}\n`, 2) }
  }
  if (reader.newline) return { error: err(NEWLINE, 2) }
  return { pattern: reader.out }
}
