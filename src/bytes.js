// UTF-8 between strings and bytes, refusing what a string-based terminal
// could not carry back out. Split from util.js so that lexing `$'…'` does
// not pull in command I/O, the filesystem and its notes.

import { UnsupportedError } from './unsupported.js'
import { utf8fromString, utf8toString, utf8toStringLoose } from '@exodus/bytes/utf8.js'

export { utf8fromStringLoose as encodeUtf8Loose } from '@exodus/bytes/utf8.js'

// Byte operations encode JS strings as UTF-8. Preserve the BOM and refuse
// slices that cannot be represented losslessly as string output.
export function encodeUtf8(text) {
  try { return utf8fromString(text) } catch (e) {
    if (!(e instanceof TypeError)) throw e
    throw new UnsupportedError('feature', 'unpaired surrogate', 'unpaired UTF-16 surrogates cannot be encoded as UTF-8')
  }
}

// A lead byte says how many bytes its character takes; anything else starts
// none. The sequence itself is checked by decoding it, which is where UTF-8's
// own rules live — no overlong form, no surrogate, nothing past U+10FFFF.
const SEQUENCE = (byte) => byte < 0x80 ? 1 : byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 0

// Each character the bytes spell, as its code point, and -1 for a byte that
// spells none — which is what a count needs to tell a character it can read
// from one it cannot, where the two are counted differently. A sequence cut
// short at the end is the bytes it is made of, as a reader that never sees
// more must.
export function* utf8CodePoints(bytes) {
  for (let at = 0; at < bytes.length;) {
    const width = WIDTH[bytes[at]]
    const code = width === 1 ? bytes[at] : width === 0 ? -1 : sequenceCode(bytes, at, width)
    yield code
    at += code < 0 ? 1 : width
  }
}

// The lead byte's own bits are what its width leaves it, and every byte after
// it carries six more. What UTF-8 forbids is what is left once they are put
// together: a form longer than the character needs, a surrogate half, and
// anything past the last code point there is.
const SHORTEST = [0, 0, 0x80, 0x800, 0x10000]
function sequenceCode(bytes, at, width) {
  if (at + width > bytes.length) return -1
  let code = bytes[at] & (0x7f >> width)
  for (let i = 1; i < width; i++) {
    if ((bytes[at + i] & 0xc0) !== 0x80) return -1
    code = (code << 6) | (bytes[at + i] & 0x3f)
  }
  return code < SHORTEST[width] || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? -1 : code
}

// Bytes that spell no character, read as the replacement character each of
// them stands for. Only a reading that such a byte cannot change may be taken
// from this — base64's alphabet, which no replacement character is in — never
// the text itself, which is the thing these bytes do not have.
export const decodeUtf8Loose = (bytes) => utf8toStringLoose(bytes)

// The text the bytes spell, or nothing where they spell none: for a command
// that answers for such a file — a search that calls it binary, a comparison
// that says the two differ — rather than refusing to read it at all.
export function decodeUtf8Maybe(bytes) {
  let text
  try { text = utf8toString(bytes) } catch { /* bytes that spell none leave it unset */ }
  return text
}

// The text the bytes spell, with each byte that spells none read as a marker
// of its own: the lone surrogate U+DC00 plus that byte, which no decoder ever
// yields (so strict text holds none) and which says which byte it stands for.
// A byte spells nothing only from 0x80 up, so markers run U+DC80 to U+DCFF.
// This is how a search reads a file its locale cannot read as text: every
// character the bytes do spell is still that character, and each byte that
// is none is still there to be stepped over — and handed back, byte for
// byte, by encodeUtf8Marked.
export function decodeUtf8Marked(bytes) {
  const text = decodeUtf8Maybe(bytes)
  if (text !== undefined) return text
  // One code unit per byte at most, so the units fit in as many; a string is
  // made of them a chunk at a time, which is far cheaper than a string per
  // run where nearly every other byte is a marker.
  const units = new Uint16Array(bytes.length)
  let n = 0
  for (let at = 0; at < bytes.length;) {
    const width = WIDTH[bytes[at]]
    const code = width === 1 ? bytes[at] : width === 0 ? -1 : sequenceCode(bytes, at, width)
    if (code < 0) {
      units[n++] = 0xdc00 + bytes[at++]
      continue
    }
    if (code > 0xffff) {
      units[n++] = 0xd7c0 + (code >> 10)
      units[n++] = 0xdc00 + (code & 0x3ff)
    } else units[n++] = code
    at += width
  }
  let out = ''
  // oxlint-disable-next-line unicorn/prefer-code-point -- these are UTF-16 code units, which fromCharCode takes; spread into a call they walk an iterator, several times slower.
  for (let at = 0; at < n; at += CHUNK) out += String.fromCharCode.apply(null, units.subarray(at, Math.min(n, at + CHUNK)))
  return out
}

const CHUNK = 4096
const WIDTH = Uint8Array.from({ length: 256 }, (_, byte) => SEQUENCE(byte))

// A byte read as a marker, among the characters around it: the range as a
// regex set body, a test for one, and a test for a code point.
export const MARKER_RANGE = '\\uDC80-\\uDCFF'
export const MARKER = new RegExp(`[${MARKER_RANGE}]`, 'u')
export const isMarker = (code) => code >= 0xdc80 && code <= 0xdcff

// The bytes decodeUtf8Marked read: its markers back as the bytes they stand
// for, and everything else as UTF-8, in one pass. A surrogate that is no
// marker has no UTF-8 spelling and is refused as encodeUtf8 refuses it.
export function encodeUtf8Marked(text) {
  if (!MARKER.test(text)) return encodeUtf8(text)
  const out = new Uint8Array(text.length * 3)
  let n = 0
  for (let at = 0; at < text.length; at++) {
    const code = text.codePointAt(at)
    if (code < 0x80) out[n++] = code
    else if (isMarker(code)) out[n++] = code - 0xdc00
    else if (code < 0x800) n = put(out, n, 0xc0 | (code >> 6), code, 1)
    else if (code < 0x10000) {
      if (code >= 0xd800 && code <= 0xdfff) return encodeUtf8(text)
      n = put(out, n, 0xe0 | (code >> 12), code, 2)
    } else {
      n = put(out, n, 0xf0 | (code >> 18), code, 3)
      at++
    }
  }
  return out.slice(0, n)
}

// A lead byte and the continuation bytes carrying the rest of the code point.
function put(out, n, lead, code, rest) {
  out[n++] = lead
  for (let k = rest - 1; k >= 0; k--) out[n++] = 0x80 | ((code >> (6 * k)) & 0x3f)
  return n
}

// One run of bytes out of several, which is what a pipe carrying both text
// and bytes ends up holding.
export function joinBytes(parts) {
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}

export function decodeUtf8(bytes) {
  try { return utf8toString(bytes) } catch {
    throw new UnsupportedError('feature', 'partial UTF-8 byte sequence', 'byte output that is not valid UTF-8 cannot be represented by this string-based terminal')
  }
}
