// What gawk makes of the text of a constant: the escapes in a string, and
// the value of a number as its lexer reads one. -v values, assignment
// operands and -F go through the same escape processing.

import { AwkError } from './common.js'
import { decodeUtf8, encodeUtf8Loose } from '../util.js'

// Decode one backslash escape starting at `src[i]` (the backslash).
// Returns the decoded text and the index just past the escape. The
// recognized set is awk's: the C control escapes, `\"` `\\`, octal
// `\ddd` and hex `\xHH`. Anything else is the plain character with a
// warning — gawk's reading, which matters for a string used as a
// dynamic regex: `"a\.b"` is the regex `a.b`.
const SIMPLE_ESCAPES = { __proto__: null, n: '\n', t: '\t', r: '\r', a: '\u0007', b: '\b', f: '\f', v: '\v', '"': '"', '\\': '\\' }

// gawk warns of `\x` with no digits each time, and of any other unknown
// escape once per character in a run (`once` names it).
function readEscape(src, i, warn) {
  const c = src[i + 1]
  if (c in SIMPLE_ESCAPES) return { text: SIMPLE_ESCAPES[c], end: i + 2 }
  if (c >= '0' && c <= '7') {
    let j = i + 1
    while (j < i + 4 && src[j] >= '0' && src[j] <= '7') j++
    return { byte: Number.parseInt(src.slice(i + 1, j), 8) & 255, end: j }
  }
  if (c === 'x') {
    if (!/[0-9a-fA-F]/u.test(src[i + 2] ?? '')) {
      warn?.("no hex digits in `\\x' escape sequence")
      return { text: 'x', end: i + 2 }
    }
    let j = i + 2
    while (j < i + 4 && /[0-9a-fA-F]/u.test(src[j] ?? '')) j++
    return { byte: Number.parseInt(src.slice(i + 2, j), 16), end: j }
  }
  if (c.codePointAt(0) > 127) throw new AwkError('non-ASCII characters after an escape are not supported', null, 'non-ASCII string escape')
  warn?.(`escape sequence \`\\${c}' treated as plain \`${c}'`, `string \\${c}`)
  return { text: c, end: i + 2 }
}

// The value of string text with its escapes decoded. A backslash ending the
// text, or one before a newline, is dropped as gawk drops it from a -v
// value — and kept from -F's (`keep`); a string constant reaches here with
// its line continuations already taken out.
export function unescapeAwkString(src, warn = null, keep = false) {
  const bytes = []
  for (let i = 0; i < src.length;) {
    const c = src[i]
    if (c === '\\' && (src[i + 1] === '\n' || i + 1 === src.length)) {
      if (keep) bytes.push(92)
      i += 2
      continue
    }
    if (c === '\\') {
      const r = readEscape(src, i, warn)
      append(bytes, r)
      i = r.end
    } else {
      const point = String.fromCodePoint(src.codePointAt(i))
      append(bytes, { text: point })
      i += point.length
    }
  }
  return decodeUtf8(Uint8Array.from(bytes))
}

function append(bytes, escape) {
  if (escape.byte === undefined) { for (const byte of encodeUtf8Loose(escape.text)) bytes.push(byte) }
  else bytes.push(escape.byte)
}

const isDigit = (c) => c !== undefined && c >= '0' && c <= '9'
const isXdigit = (c) => c !== undefined && /[0-9a-fA-F]/u.test(c)

// How far gawk's lexer reads a numeric constant starting at `src[i]` — its
// loop, quirks and all: `1x5` and `011x` are one token each — and the value
// it gives it: hex after `0x`, octal for a leading 0 of octal digits (`018`
// is 18 all the same), and otherwise what strtod() reads of the text.
export function scanNumber(src, i) {
  let j = i
  let seenPoint = false
  let seenE = false
  let inHex = false
  for (;; j++) {
    const c = src[j]
    if (c === 'x' || c === 'X') {
      if (j - i !== 1) continue
      if (!isXdigit(src[j + 1])) break
      inHex = true
    } else if (c === '.') {
      if (seenPoint || seenE) break
      seenPoint = true
    } else if (c === 'e' || c === 'E') {
      if (inHex) continue
      if (seenE) break
      seenE = true
      if ((src[j + 1] === '-' || src[j + 1] === '+') && isDigit(src[j + 2])) j += 2
      else if (!isDigit(src[j + 1])) break
    } else if (/[a-fA-F]/u.test(c ?? '')) {
      if (!inHex) break
    } else if (!isDigit(c)) break
  }
  return { value: numberValue(src.slice(i, j)), end: j }
}

// gawk's get_numbase() and nondec2awknum(), then atof() for the rest.
function numberValue(text) {
  if (text.length >= 2 && text[0] === '0') {
    if (text[1] === 'x' || text[1] === 'X') {
      const digits = /^[0-9a-fA-F]*/u.exec(text.slice(2))[0]
      return digits === '' ? 0 : Number.parseInt(digits, 16)
    }
    const decimal = /[.eE]/u.test(/^[0-9.eE]*/u.exec(text)[0]) || !isDigit(text[1]) || text[1] === '8' || text[1] === '9'
    if (!decimal) {
      let value = 0
      for (const c of text) {
        if (!isDigit(c)) return value
        if (c === '8' || c === '9') return strtod(text)
        value = value * 8 + Number(c)
      }
      return value
    }
  }
  return strtod(text)
}

function strtod(text) {
  const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/u.exec(text)
  return m === null ? 0 : Number(m[0])
}
