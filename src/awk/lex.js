// Tokens are { type, value, line }; print-list backtracking needs a flat array.
// Numbers normalize hex/octal literals; strings decode escapes; regex bodies
// stay verbatim. funcname distinguishes f(x) from the concatenation f (x).
// `/` starts a regex unless the previous token ends an operand.

import { AwkError, BUILTINS, KEYWORDS } from './common.js'
import { utf8, utf8Decoder } from '../util.js'

// Longest first, so `**=` wins over `**` and `*=`, `|&` over `|`, etc.
const OPERATORS = [
  '**=', '**', '++', '--', '+=', '-=', '*=', '/=', '%=', '^=', '==', '!=',
  '<=', '>=', '&&', '||', '!~', '>>', '|&',
  '+', '-', '*', '/', '%', '^', '!', '>', '<', '|', '?', ':', '~', '$',
  '=', '(', ')', '{', '}', '[', ']', ';', ',',
]

const OPERAND_END_TYPES = new Set(['number', 'string', 'name', 'builtin'])
const OPERAND_END_PUNCT = new Set([')', ']', '++', '--'])

const NUMBER = /^(?:0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/u
const isNameStart = (c) => c !== undefined && /[A-Za-z_]/u.test(c)
const isNameChar = (c) => c !== undefined && /[A-Za-z0-9_]/u.test(c)
const isDigit = (c) => c !== undefined && c >= '0' && c <= '9'

// `warn`, when given, receives gawk's warnings about dubious escapes.
export function tokenize(src, warn = null) {
  const toks = []
  let line = 1
  let i = 0
  const push = (type, value) => toks.push({ type, value, line })
  const regexAllowed = () => {
    const t = toks.at(-1)
    if (!t) return true
    if (OPERAND_END_TYPES.has(t.type)) return false
    return !(t.type === 'punct' && OPERAND_END_PUNCT.has(t.value))
  }
  while (i < src.length) {
    const c = src[i]
    if (c === '\n') {
      if (toks.at(-1)?.type !== 'newline') push('newline', '\n')
      line++; i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue }
    // Backslash-newline continues the line. Tolerate a CRLF pair too.
    if (c === '\\' && (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n'))) {
      i += src[i + 1] === '\n' ? 2 : 3
      line++
      continue
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '"') {
      const r = decodeString(src, i + 1, warn, line)
      push('string', r.value); i = r.end
      continue
    }
    if (c === '/' && regexAllowed()) {
      const r = scanRegex(src, i + 1, line)
      push('regex', r.value); i = r.end
      continue
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      const r = scanNumber(src, i)
      push('number', r.value); i = r.end
      continue
    }
    if (isNameStart(c)) {
      let j = i + 1
      while (isNameChar(src[j])) j++
      const word = src.slice(i, j)
      if (src.slice(j, j + 2) === '::') throw new AwkError('namespaces are not supported', line, 'namespaces')
      i = j
      if (KEYWORDS.has(word)) push('keyword', word === 'func' ? 'function' : word)
      else if (BUILTINS.has(word)) push('builtin', word)
      else push(src[j] === '(' ? 'funcname' : 'name', word)
      continue
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i))
    if (c === '@') throw new AwkError('typed regexes, indirect calls and source directives are not supported', line, '@ extensions')
    if (!op) throw new AwkError(`unexpected character \`${c}\``, line)
    push('punct', op); i += op.length
  }
  push('eof', '')
  return toks
}

// A numeric constant in program text. gawk reads `0x1A` as hex and a
// leading-zero constant of octal digits (`011`) as octal; the value is
// normalized to decimal text here.
function scanNumber(src, i) {
  const text = NUMBER.exec(src.slice(i))[0]
  let value = text
  if (/^0[xX]/u.test(text)) value = String(Number.parseInt(text.slice(2), 16))
  else if (/^0[0-7]+$/u.test(text)) value = String(Number.parseInt(text, 8))
  return { value, end: i + text.length }
}

// Decode one backslash escape starting at `src[i]` (the backslash).
// Returns the decoded text and the index just past the escape. The
// recognized set is awk's: the C control escapes, `\"` `\\`, octal
// `\ddd` and hex `\xHH`. Anything else is the plain character with a
// warning — gawk's reading, which matters for a string used as a
// dynamic regex: `"a\.b"` is the regex `a.b`.
const SIMPLE_ESCAPES = { __proto__: null, n: '\n', t: '\t', r: '\r', a: '\u0007', b: '\b', f: '\f', v: '\v', '"': '"', '\\': '\\' }

function readEscape(src, i, warn) {
  const c = src[i + 1]
  if (c === undefined) return { text: '\\', end: i + 1 }
  if (c in SIMPLE_ESCAPES) return { text: SIMPLE_ESCAPES[c], end: i + 2 }
  if (c >= '0' && c <= '7') {
    let j = i + 1
    while (j < i + 4 && src[j] >= '0' && src[j] <= '7') j++
    return { byte: Number.parseInt(src.slice(i + 1, j), 8) & 255, end: j }
  }
  if (c === 'x' && /[0-9a-fA-F]/u.test(src[i + 2] ?? '')) {
    let j = i + 2
    while (j < i + 4 && /[0-9a-fA-F]/u.test(src[j] ?? '')) j++
    return { byte: Number.parseInt(src.slice(i + 2, j), 16), end: j }
  }
  if (c.codePointAt(0) > 127) throw new AwkError('non-ASCII characters after an escape are not supported', null, 'non-ASCII string escape')
  warn?.(`escape sequence \`\\${c}' treated as plain \`${c}'`)
  return { text: c, end: i + 2 }
}

// Literal strings stop at a closing quote and allow backslash-newline.
// Option/operand values have no quote terminator and decode every escape.
function decodeString(src, start, warn, line = null) {
  const bytes = []
  let i = start
  while (i < src.length) {
    const c = src[i]
    if (line !== null) {
      if (c === '"') return { value: utf8Decoder.decode(Uint8Array.from(bytes)), end: i + 1 }
      if (c === '\n') break
      if (c === '\\' && src[i + 1] === '\n') { i += 2; continue }
    }
    if (c === '\\') {
      const r = readEscape(src, i, warn)
      appendEscape(bytes, r); i = r.end
    } else {
      const point = String.fromCodePoint(src.codePointAt(i))
      appendEscape(bytes, { text: point }); i += point.length
    }
  }
  if (line !== null) throw new AwkError('unterminated string', line)
  return { value: utf8Decoder.decode(Uint8Array.from(bytes)), end: i }
}

// The regex body is kept verbatim (escapes included) for ./re-parse.js
// to read. Only the closing `/` matters here: it cannot end the literal
// from inside a bracket expression, and `\/` is an escaped slash.
function scanRegex(src, start, line) {
  let i = start
  let inClass = false
  while (i < src.length) {
    const c = src[i]
    if (c === '\n') break
    if (c === '\\') { i += 2; continue }
    if (inClass) {
      // `[:alpha:]` carries a `]` of its own; skip over the whole name.
      if (c === '[' && src[i + 1] === ':') {
        const close = src.indexOf(':]', i + 2)
        if (close !== -1) { i = close + 2; continue }
      }
      if (c === ']') inClass = false
      i++
      continue
    }
    if (c === '[') {
      inClass = true; i++
      if (src[i] === '^') i++
      if (src[i] === ']') i++
      continue
    }
    if (c === '/') return { value: src.slice(start, i), end: i + 1 }
    i++
  }
  throw new AwkError('unterminated regexp', line)
}

// Apply string-literal escape processing to text that did not come
// through the lexer: `-v var=value` and `var=value` operands, and `-F`.
export function unescapeAwkString(s, warn = null) {
  return decodeString(s, 0, warn).value
}

function appendEscape(bytes, escape) {
  if (escape.byte === undefined) { for (const byte of utf8.encode(escape.text)) bytes.push(byte) }
  else bytes.push(escape.byte)
}
