// POSIX ERE parser for awk regexes. Both matchers consume the AST it
// produces: awk-re.js compiles it to an NFA for the extent-sensitive
// operations (sub, gsub, match, split, FS, RS), which need POSIX
// leftmost-LONGEST matches, and `toJsSource` renders it as an ES regex
// for the yes/no tests (`~`, patterns), where the JS engine's
// leftmost-first answer is the same answer, only faster. One grammar,
// so both engines accept the same language.
//
// Nodes:
//   { type: 'char', code }              one code point
//   { type: 'any' }                     `.` — any character, newline included
//   { type: 'set', negate, items }      bracket expression; items are
//                                       [lo, hi] code point ranges
//   { type: 'assert', kind }            '^' '$' 'y' (word boundary) '<' '>' 'B'
//   { type: 'group', index, node }      `( )`, numbered from 1 in source order
//   { type: 'cat', nodes }              concatenation (empty = matches "")
//   { type: 'alt', nodes }              alternation
//   { type: 'rep', node, min, max }     quantifier; max null = unbounded
//
// gawk's readings of the dubious spots are kept: a quantifier with
// nothing before it (`*a`, `(+)`) is a literal; stacked quantifiers apply
// in turn (`a**`); `{` is literal unless it forms an interval; a bare `}`
// or `]` is literal; `\b` is a backspace and `\d` is a plain `d`, both
// with a warning, because that is what the reference does with them.

import { AwkError } from './awk-common.js'

const CLASSES = {
  __proto__: null,
  alpha: [[65, 90], [97, 122]], digit: [[48, 57]], alnum: [[48, 57], [65, 90], [97, 122]],
  upper: [[65, 90]], lower: [[97, 122]], space: [[9, 13], [32, 32]], blank: [[9, 9], [32, 32]],
  punct: [[33, 47], [58, 64], [91, 96], [123, 126]], print: [[32, 126]], graph: [[33, 126]],
  cntrl: [[0, 31], [127, 127]], xdigit: [[48, 57], [65, 70], [97, 102]],
  word: [[48, 57], [65, 90], [95, 95], [97, 122]],
}
const CONTROL = { __proto__: null, n: 10, t: 9, r: 13, f: 12, v: 11, a: 7, b: 8 }
const SYNTAX = '^$.[]|()*+?{}\\/"'
const MAX_INTERVAL = 1000
const isHex = (c) => c !== undefined && /[0-9a-fA-F]/u.test(c)
const isOctal = (c) => c !== undefined && c >= '0' && c <= '7'

class EreParser {
  constructor(src, warn) {
    this.src = src
    this.i = 0
    this.warn = warn
    this.groups = 0
  }

  fail(msg) { throw new AwkError(`invalid regex /${this.src}/: ${msg}`) }
  peek() { return this.src[this.i] }
  // Next code point as a char node, surrogate pairs kept whole.
  literal() {
    const code = this.src.codePointAt(this.i)
    this.i += code > 0xFFFF ? 2 : 1
    return { type: 'char', code }
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
        if (!m && /^\{[\d,]*\}/u.test(this.src.slice(this.i))) this.fail('invalid content of {}')
        if (!m || (m[1] === '' && m[2] === undefined)) return node
        const min = m[1] === '' ? 0 : Number(m[1])
        const max = m[2] === undefined ? min : m[3] === '' ? null : Number(m[3])
        if (max !== null && max < min) this.fail(`invalid interval {${min},${max}}`)
        if (min > MAX_INTERVAL || (max !== null && max > MAX_INTERVAL)) this.fail(`interval count above ${MAX_INTERVAL} is not supported`)
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
      if (this.peek() !== ')') this.fail('missing `)`')
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
    if (c === undefined) this.fail('trailing backslash')
    this.i++
    if (c === 'y') return { type: 'assert', kind: 'y' }
    if (c === '<' || c === '>' || c === 'B') return { type: 'assert', kind: c }
    if (c === '`') return { type: 'assert', kind: '^' }
    if (c === "'") return { type: 'assert', kind: '$' }
    if (c === 's' || c === 'S') return { type: 'set', negate: c === 'S', items: CLASSES.space }
    if (c === 'w' || c === 'W') return { type: 'set', negate: c === 'W', items: CLASSES.word }
    if (c === 'b') this.warn?.('regexp escape sequence `\\b\' is a backspace here, as in gawk; `\\y\' is the word boundary')
    return { type: 'char', code: this.escapedCode(c, true) }
  }

  // The code point an escape denotes; used outside and inside brackets.
  escapedCode(c, warnUnknown) {
    if (c in CONTROL) return CONTROL[c]
    if (isOctal(c)) {
      let digits = c
      while (digits.length < 3 && isOctal(this.peek())) digits += this.src[this.i++]
      return Number.parseInt(digits, 8)
    }
    if (c === 'x' && isHex(this.peek())) {
      let digits = ''
      while (digits.length < 2 && isHex(this.peek())) digits += this.src[this.i++]
      return Number.parseInt(digits, 16)
    }
    if (!SYNTAX.includes(c) && warnUnknown) this.warn?.(`regexp escape sequence \`\\${c}' is not a known regexp operator`)
    const code = c.codePointAt(0)
    if (code > 0xFFFF) this.i++
    return code
  }

  bracket() {
    this.i++
    let negate = false
    if (this.peek() === '^') { negate = true; this.i++ }
    const items = []
    let first = true
    for (;;) {
      if (this.i >= this.src.length) this.fail('unterminated bracket expression')
      const c = this.peek()
      if (c === ']' && !first) { this.i++; break }
      first = false
      if (c === '[' && this.src[this.i + 1] === ':') {
        const close = this.src.indexOf(':]', this.i + 2)
        if (close !== -1) {
          const name = this.src.slice(this.i + 2, close)
          if (!(name in CLASSES)) this.fail(`invalid character class \`[:${name}:]\``)
          items.push(...CLASSES[name])
          this.i = close + 2
          continue
        }
      }
      const lo = this.bracketChar()
      if (this.peek() === '-' && this.src[this.i + 1] !== ']' && this.src[this.i + 1] !== undefined) {
        this.i++
        const hi = this.bracketChar()
        if (hi < lo) this.fail('invalid range end')
        items.push([lo, hi])
      } else items.push([lo, lo])
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
        const code = this.src.codePointAt(this.i + 2)
        this.i = close + 2
        return code
      }
    }
    if (c === '\\') {
      this.i++
      if (this.peek() === undefined) this.fail('trailing backslash')
      const e = this.src[this.i++]
      return this.escapedCode(e, false)
    }
    const code = this.src.codePointAt(this.i)
    this.i += code > 0xFFFF ? 2 : 1
    return code
  }
}

// `warn`, when given, receives gawk's warnings about dubious escapes.
export function parseEre(src, warn = null) {
  const p = new EreParser(src, warn)
  return { ast: p.parse(), groups: p.groups }
}

// --- ES rendering ----------------------------------------------------

const hex = (code) => `\\u{${code.toString(16)}}`
// Alphanumerics stay readable; everything else is spelled as a code
// point escape, valid anywhere in a /u regex, bracket expressions included.
const esc = (code) => ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ? String.fromCodePoint(code) : hex(code))

const ASSERT_JS = {
  __proto__: null,
  '^': '^', $: '$', y: '\\b', B: '\\B',
  '<': '(?<!\\w)(?=\\w)', '>': '(?<=\\w)(?!\\w)',
}

export function toJsSource(node) {
  switch (node.type) {
    case 'char': return esc(node.code)
    case 'any': return '.'
    case 'set': return `[${node.negate ? '^' : ''}${node.items.map(([lo, hi]) => (lo === hi ? esc(lo) : `${esc(lo)}-${esc(hi)}`)).join('')}]`
    case 'assert': return ASSERT_JS[node.kind]
    case 'group': return `(${toJsSource(node.node)})`
    case 'cat': return node.nodes.map(toJsSource).join('')
    case 'alt': return `(?:${node.nodes.map(toJsSource).join('|')})`
    case 'rep': {
      const inner = `(?:${toJsSource(node.node)})`
      if (node.max === null) return node.min === 0 ? `${inner}*` : node.min === 1 ? `${inner}+` : `${inner}{${node.min},}`
      if (node.min === 0 && node.max === 1) return `${inner}?`
      return `${inner}{${node.min},${node.max}}`
    }
    default: throw new AwkError(`internal: unknown regex node ${node.type}`)
  }
}
