import { UnsupportedError } from '../unsupported.js'
import { encodeUtf8Loose } from '../util.js'
import { isUnicodeScalar, stepAt } from '../unicode.js'

// The single-letter escapes each printf takes. bash's also reads `\E`, and
// in its format `\'`, `\"` and `\?` as the character alone; coreutils' reads
// `\"` and nothing else of those, in its format and in `%b` alike.
const SIMPLE = { a: 7, b: 8, e: 27, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92 }
const BASH_SIMPLE = { ...SIMPLE, E: 27 }
const COREUTILS_SIMPLE = { ...SIMPLE, '"': 34 }

// Return bytes without decoding: adjacent escapes and fields can together
// form one UTF-8 character. `argument` is a `%b` operand rather than the
// format. bash's printf stops at `\c` only there; coreutils' stops at it
// anywhere, and exits as though nothing had gone wrong.
export function printfEscape(text, at, argument, state) {
  const c = text[at + 1]
  const coreutils = state.program !== null
  let end = at + 2
  if (c === undefined) return { bytes: [92], end: at + 1 }
  if (c === 'c' && (argument || coreutils)) {
    state.stop = coreutils ? 'exit' : true
    return { bytes: [], end, stop: true }
  }
  const simple = coreutils ? COREUTILS_SIMPLE : BASH_SIMPLE
  if (Object.hasOwn(simple, c)) return { bytes: [simple[c]], end }
  if (!coreutils && !argument && "'\"?".includes(c)) return { bytes: [c.codePointAt(0)], end }
  if (/[0-7]/u.test(c)) {
    const limit = argument && c === '0' ? 4 : 3
    while (end < at + 1 + limit && /[0-7]/u.test(text[end] ?? '')) end++
    return { bytes: [parseInt(text.slice(at + 1, end), 8) & 255], end }
  }
  const digits = c === 'x' ? 2 : c === 'u' ? 4 : c === 'U' ? 8 : 0
  if (digits) {
    while (end < at + 2 + digits && /[\da-fA-F]/u.test(text[end] ?? '')) end++
    if (end === at + 2 || (coreutils && c !== 'x' && end !== at + 2 + digits)) return missingDigits(c, at, text, state)
    const code = parseInt(text.slice(at + 2, end), 16)
    if (c === 'x') return { bytes: [code], end }
    if (!isUnicodeScalar(code)) {
      throw new UnsupportedError('feature', 'Unicode escape', 'escapes outside Unicode scalar values are not supported')
    }
    if (state.byteLocale && code > 127) {
      throw new UnsupportedError('feature', 'Unicode escape in C locale', 'non-ASCII Unicode escapes in the C locale are not supported')
    }
    return { bytes: encodeUtf8Loose(String.fromCodePoint(code)), end }
  }
  end = at + 1 + stepAt(text, at + 1)
  return { bytes: encodeUtf8Loose(text.slice(at, end)), end }
}

// An escape with none of the digits it needs. coreutils' writes nothing for
// it and exits there, keeping what it had already written; `\u` and `\U`
// want every one of their digits to it. bash's takes as many as there are,
// and with none at all warns, writes the backslash and carries on from the
// letter, the run's status untouched.
function missingDigits(c, at, text, state) {
  if (state.program !== null) {
    state.stderr += `${state.program}: missing hexadecimal number in escape\n`
    state.failed = true
    state.stop = true
    return { bytes: [], end: text.length, stop: true }
  }
  state.stderr += c === 'x' ? 'printf: missing hex digit for \\x\n' : `printf: missing unicode digit for \\${c}\n`
  return { bytes: [92], end: at + 1 }
}

export function printfBytes(text, state) {
  const bytes = []
  for (let at = 0; at < text.length;) {
    if (text[at] === '\\') {
      const escaped = printfEscape(text, at, true, state)
      for (const b of escaped.bytes) bytes.push(b)
      at = escaped.end
      if (escaped.stop) { state.stop ||= true; break }
    } else {
      const next = text.indexOf('\\', at + 1)
      const end = next < 0 ? text.length : next
      for (const b of encodeUtf8Loose(text.slice(at, end))) bytes.push(b)
      at = end
    }
  }
  return Uint8Array.from(bytes)
}
