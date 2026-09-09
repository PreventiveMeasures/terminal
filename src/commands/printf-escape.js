import { UnsupportedError } from '../unsupported.js'
import { utf8 } from '../util.js'

const SIMPLE = { a: 7, b: 8, e: 27, E: 27, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92 }

// Return bytes without decoding: adjacent escapes and fields can together
// form one UTF-8 character. Only %b gives \c its stopping behavior.
export function printfEscape(text, at, argument, state) {
  const c = text[at + 1]
  let end = at + 2
  if (c === undefined) return { bytes: [92], end: at + 1 }
  if (argument && c === 'c') return { bytes: [], end, stop: true }
  if (Object.hasOwn(SIMPLE, c)) return { bytes: [SIMPLE[c]], end }
  if (!argument && "'\"?".includes(c)) return { bytes: [c.codePointAt(0)], end }
  if (/[0-7]/u.test(c)) {
    const limit = argument && c === '0' ? 4 : 3
    while (end < at + 1 + limit && /[0-7]/u.test(text[end] ?? '')) end++
    return { bytes: [parseInt(text.slice(at + 1, end), 8) & 255], end }
  }
  const digits = c === 'x' ? 2 : c === 'u' ? 4 : c === 'U' ? 8 : 0
  if (digits) {
    while (end < at + 2 + digits && /[\da-fA-F]/u.test(text[end] ?? '')) end++
    if (end === at + 2) {
      state.stderr += `printf: missing hexadecimal digit for \\${c}\n`
    } else {
      const code = parseInt(text.slice(at + 2, end), 16)
      if (c === 'x') return { bytes: [code], end }
      if (code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) {
        throw new UnsupportedError('feature', 'Unicode escape', 'escapes outside Unicode scalar values are not supported')
      }
      if (state.byteLocale && code > 127) {
        throw new UnsupportedError('feature', 'Unicode escape in C locale', 'non-ASCII Unicode escapes in the C locale are not supported')
      }
      return { bytes: utf8.encode(String.fromCodePoint(code)), end }
    }
  }
  return { bytes: utf8.encode('\\' + c), end }
}

export function printfBytes(text, state) {
  const bytes = []
  for (let at = 0; at < text.length;) {
    if (text[at] === '\\') {
      const escaped = printfEscape(text, at, true, state)
      for (const b of escaped.bytes) bytes.push(b)
      at = escaped.end
      if (escaped.stop) { state.stop = true; break }
    } else {
      const next = text.indexOf('\\', at)
      const end = next < 0 ? text.length : next
      for (const b of utf8.encode(text.slice(at, end))) bytes.push(b)
      at = end
    }
  }
  return Uint8Array.from(bytes)
}
