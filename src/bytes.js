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
    const width = SEQUENCE(bytes[at])
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

export function decodeUtf8(bytes) {
  try { return utf8toString(bytes) } catch {
    throw new UnsupportedError('feature', 'partial UTF-8 byte sequence', 'byte output that is not valid UTF-8 cannot be represented by this string-based terminal')
  }
}
