// Shared ERE grammar for the NFA and JS matchers (see ./regex.js).
//
// AST nodes: char/code, any, set/negate/items (code point ranges), assert/kind,
// group/index/node, cat or alt/nodes, and rep/node/min/max (null is unbounded).
// Empty concatenations match empty text. GNU syntax treats leading quantifiers
// and unmatched closing brackets as literals; intervals require a valid closing
// brace. Unknown escapes warn and become literals.
//
// Under `ignoreCase` the AST is the folded pattern: a letter is the set of
// characters it stands for, a range the ranges it takes once upper-cased,
// and [:upper:] and [:lower:] read as [:alpha:], all by the locale's tables
// (fold and foldRange in ../locale.js), so the matchers run case-sensitively.

import { AwkError } from './common.js'
import { LOCALE, classTables, foldedClass } from '../locale.js'
import { codePointSize } from '../unicode.js'

const CONTROL = { __proto__: null, n: 10, t: 9, r: 13, f: 12, v: 11, a: 7, b: 8 }
// The escapes gawk passes to GNU regex without a warning.
const KNOWN_ESCAPES = '<>`\'BywWsS{}()|*+?.^$\\[]/-'
const MAX_INTERVAL = 1000
const isHex = (c) => c !== undefined && /[0-9a-fA-F]/u.test(c)
const isOctal = (c) => c !== undefined && c >= '0' && c <= '7'

class EreParser {
  constructor(src, warn, tables, ignoreCase) {
    this.src = src
    this.i = 0
    this.warn = warn
    this.tables = tables
    this.ignoreCase = ignoreCase
    this.groups = 0
  }

  // What GNU regex says of a pattern it refuses (`gnu`), in gawk's runtime
  // words; a refusal GNU's words are not known for is reported as ours.
  fail(msg, gnu = null) {
    if (gnu === null) throw new AwkError(`invalid regex /${this.src}/: ${msg}`, null, 'regex error message')
    const e = new AwkError(`invalid regexp: ${gnu}: /${this.src}/`)
    e.gnu = gnu
    throw e
  }
  peek() { return this.src[this.i] }
  // Next code point as a char node, surrogate pairs kept whole.
  literal() {
    const code = this.src.codePointAt(this.i)
    this.i += codePointSize(code)
    return this.charNode(code)
  }

  // One character, or the set it stands for under case folding.
  charNode(code) {
    const set = this.ignoreCase ? this.tables.fold(code) : [code]
    return set.length === 1 ? { type: 'char', code } : { type: 'set', negate: false, items: set.map((c) => [c, c]) }
  }

  parse() {
    return this.alternation(0)
  }

  alternation(depth) {
    const nodes = [this.concatenation(depth)]
    while (this.peek() === '|') {
      this.i++
      nodes.push(this.concatenation(depth))
    }
    return nodes.length === 1 ? nodes[0] : { type: 'alt', nodes }
  }

  concatenation(depth) {
    const nodes = []
    while (!this.endsConcatenation(depth)) {
      nodes.push(this.quantified(this.atom(nodes.length === 0, depth)))
    }
    return nodes.length === 1 ? nodes[0] : { type: 'cat', nodes }
  }

  // A concatenation runs to the end of the source, a `|`, or a `)`
  // that closes an open group; a `)` with no group open is a literal
  // (GNU regex), so `depth` says whether one is.
  endsConcatenation(depth) {
    const c = this.peek()
    return c === undefined || c === '|' || (c === ')' && depth > 0)
  }

  quantified(atom) {
    let node = atom
    for (;;) {
      const c = this.peek()
      if (c === '*') { this.i++; node = { type: 'rep', node, min: 0, max: null }; continue }
      if (c === '+') { this.i++; node = { type: 'rep', node, min: 1, max: null }; continue }
      if (c === '?') { this.i++; node = { type: 'rep', node, min: 0, max: 1 }; continue }
      if (c === '{') {
        const m = /^\{(\d*)(?:(,)(\d*))?\}/u.exec(this.src.slice(this.i))
        // A `{...}` of digits and commas that is not a well-formed
        // interval is an error, as in GNU regex; a `{` that never
        // closes (`a{1`) is a literal.
        if (!m && /^\{[\d,]*\}/u.test(this.src.slice(this.i))) this.fail('invalid content of {}', 'Invalid content of \\{\\}')
        if (!m || (m[1] === '' && m[2] === undefined)) return node
        const min = m[1] === '' ? 0 : Number(m[1])
        const max = m[2] === undefined ? min : m[3] === '' ? null : Number(m[3])
        if (max !== null && max < min) this.fail(`invalid interval {${min},${max}}`, 'Invalid content of \\{\\}')
        if (min > MAX_INTERVAL || (max !== null && max > MAX_INTERVAL)) throw new AwkError(`interval count above ${MAX_INTERVAL} is not supported`, null, 'regex interval limit')
        this.i += m[0].length
        node = { type: 'rep', node, min, max }
        continue
      }
      return node
    }
  }

  atom(first, depth) {
    const c = this.peek()
    if (c === '(') {
      this.i++
      const index = ++this.groups
      const node = this.alternation(depth + 1)
      if (this.peek() !== ')') this.fail('missing `)`', 'Unmatched ( or \\(')
      this.i++
      return { type: 'group', index, node }
    }
    if (c === '[') return this.bracket()
    if (c === '\\') return this.escape()
    this.i++
    if (c === '.') return { type: 'any' }
    if (c === '^' || c === '$') return { type: 'assert', kind: c }
    // A quantifier with nothing to repeat is the character itself.
    if ((c === '*' || c === '+' || c === '?') && !first) this.fail(`unexpected \`${c}\``)
    this.i--
    return this.literal()
  }

  escape() {
    this.i++
    const c = this.peek()
    if (c === undefined) this.fail('trailing backslash', 'Trailing backslash')
    this.i++
    if (c === 'y') return { type: 'assert', kind: 'y' }
    if (c === '<' || c === '>' || c === 'B') return { type: 'assert', kind: c }
    if (c === '`') return { type: 'assert', kind: '^' }
    if (c === "'") return { type: 'assert', kind: '$' }
    if (c === 's' || c === 'S') return { type: 'set', negate: c === 'S', items: this.tables.ranges('space') }
    if (c === 'w' || c === 'W') return { type: 'set', negate: c === 'W', items: this.tables.ranges('word') }
    return this.charNode(this.escapedCode(c))
  }

  // The code point an escape denotes; used outside and inside brackets,
  // where gawk reads escapes alike. Its warnings: `\x` with no digits each
  // time, `\8` and `\9` and an escape that is no regex operator once per
  // character in a run.
  escapedCode(c) {
    if (c in CONTROL) return CONTROL[c]
    if (isOctal(c)) {
      let digits = c
      while (digits.length < 3 && isOctal(this.peek())) digits += this.src[this.i++]
      return regexByte(digits, 8)
    }
    if (c === 'x') {
      if (!isHex(this.peek())) {
        this.warn?.("no hex digits in `\\x' escape sequence")
        return 120
      }
      let digits = ''
      while (digits.length < 2 && isHex(this.peek())) digits += this.src[this.i++]
      return regexByte(digits, 16)
    }
    const code = this.src.codePointAt(this.i - 1)
    // gawk escapes the first byte of a multibyte character and names that
    // byte alone in its warning, which is no text this terminal can write.
    if (code > 127) throw new AwkError('non-ASCII characters after a regex escape are not supported', null, 'non-ASCII regex escape')
    if (c === '8' || c === '9') this.warn?.(`regexp escape sequence \`\\${c}' treated as plain \`${c}'`, `regex \\${c} plain`)
    else if (!KNOWN_ESCAPES.includes(c)) this.warn?.(`regexp escape sequence \`\\${String.fromCodePoint(code)}' is not a known regexp operator`, `regex \\${c}`)
    this.i += codePointSize(code) - 1
    return code
  }

  bracket() {
    this.i++
    let negate = false
    if (this.peek() === '^') { negate = true; this.i++ }
    const items = []
    let first = true
    for (;;) {
      // GNU regex: a list with nothing in it at all is an invalid pattern.
      if (this.i >= this.src.length) this.fail('unterminated bracket expression', first ? 'Invalid regular expression' : 'Unmatched [, [^, [:, [., or [=')
      const c = this.peek()
      if (c === ']' && !first) { this.i++; break }
      first = false
      if (c === '[' && this.src[this.i + 1] === ':') {
        const close = this.src.indexOf(':]', this.i + 2)
        if (close !== -1) {
          const name = this.src.slice(this.i + 2, close)
          const ranges = this.tables.ranges(this.ignoreCase ? foldedClass(name) : name)
          if (ranges === undefined) this.fail(`invalid character class \`[:${name}:]\``, 'Invalid character class name')
          items.push(...ranges)
          this.i = close + 2
          continue
        }
      }
      const lo = this.bracketChar()
      if (this.peek() === '-' && this.src[this.i + 1] !== ']' && this.src[this.i + 1] !== undefined) {
        this.i++
        const hi = this.bracketChar()
        const range = this.ignoreCase ? this.tables.foldRange(lo, hi) : hi < lo ? null : [[lo, hi]]
        if (range === null) this.fail('invalid range end', 'Invalid range end')
        items.push(...range)
      } else if (this.ignoreCase) items.push(...this.tables.fold(lo).map((code) => [code, code]))
      else items.push([lo, lo])
    }
    return { type: 'set', negate, items }
  }

  // One endpoint inside a bracket: a plain character, an escape, or a
  // collating symbol / equivalence class (`[.x.]`, `[=x=]`), which in the
  // C locale name the character itself.
  bracketChar() {
    const c = this.peek()
    if (c === '[' && (this.src[this.i + 1] === '.' || this.src[this.i + 1] === '=')) {
      const close = this.src.indexOf(this.src[this.i + 1] + ']', this.i + 2)
      if (close !== -1 && close > this.i + 2) {
        if (Array.from(this.src.slice(this.i + 2, close)).length !== 1) this.fail('invalid collation character', 'Invalid collation character')
        const code = this.src.codePointAt(this.i + 2)
        this.i = close + 2
        return code
      }
    }
    if (c === '\\') {
      this.i++
      if (this.peek() === undefined) this.fail('trailing backslash', 'Unmatched [, [^, [:, [., or [=')
      const e = this.src[this.i++]
      return this.escapedCode(e)
    }
    const code = this.src.codePointAt(this.i)
    this.i += codePointSize(code)
    return code
  }
}

// `warn`, when given, receives gawk's warnings about dubious escapes.
export function parseEre(src, warn = null, tables = classTables(LOCALE), ignoreCase = false) {
  const p = new EreParser(src, warn, tables, ignoreCase)
  return { ast: p.parse(), groups: p.groups }
}

function regexByte(digits, base) {
  const code = Number.parseInt(digits, base)
  if (code >= 128) throw new AwkError('non-ASCII regex byte escapes are not supported', null, 'regex byte escapes')
  return code
}

const hex = (code) => `\\u{${code.toString(16)}}`
// Alphanumerics stay readable; everything else is spelled as a code
// point escape, valid anywhere in a /u regex, bracket expressions included.
const esc = (code) => ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ? String.fromCodePoint(code) : hex(code))

// Word boundaries are spelt out over the locale's word set: JS's own \\b
// knows ASCII only.
function jsAssertion(kind, tables) {
  if (kind === '^' || kind === '$') return kind
  const js = tables.assertions()
  return kind === 'y' ? js.boundary : kind === 'B' ? js.inside : js[kind]
}

export function toJsSource(node, tables = classTables(LOCALE)) {
  const render = (child) => toJsSource(child, tables)
  switch (node.type) {
    case 'char': return esc(node.code)
    case 'any': return '.'
    case 'set': return `[${node.negate ? '^' : ''}${node.items.map(([lo, hi]) => (lo === hi ? esc(lo) : `${esc(lo)}-${esc(hi)}`)).join('')}]`
    case 'assert': return jsAssertion(node.kind, tables)
    case 'group': return `(${render(node.node)})`
    case 'cat': return node.nodes.map(render).join('')
    case 'alt': return `(?:${node.nodes.map(render).join('|')})`
    case 'rep': {
      const inner = `(?:${render(node.node)})`
      if (node.max === null) return node.min === 0 ? `${inner}*` : node.min === 1 ? `${inner}+` : `${inner}{${node.min},}`
      if (node.min === 0 && node.max === 1) return `${inner}?`
      return `${inner}{${node.min},${node.max}}`
    }
    default: throw new AwkError(`internal: unknown regex node ${node.type}`)
  }
}
