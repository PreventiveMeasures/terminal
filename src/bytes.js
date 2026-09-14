// UTF-8 between strings and bytes, refusing what a string-based terminal
// could not carry back out. Split from util.js so that lexing `$'…'` does
// not pull in command I/O, the filesystem and its notes.

import { UnsupportedError } from './unsupported.js'
import { utf8fromString, utf8toString } from '@exodus/bytes/utf8.js'

export { utf8fromStringLoose as encodeUtf8Loose } from '@exodus/bytes/utf8.js'

// Byte operations encode JS strings as UTF-8. Preserve the BOM and refuse
// slices that cannot be represented losslessly as string output.
export function encodeUtf8(text) {
  try { return utf8fromString(text) } catch (e) {
    if (!(e instanceof TypeError)) throw e
    throw new UnsupportedError('feature', 'unpaired surrogate', 'unpaired UTF-16 surrogates cannot be encoded as UTF-8')
  }
}

export function decodeUtf8(bytes) {
  try { return utf8toString(bytes) } catch {
    throw new UnsupportedError('feature', 'partial UTF-8 byte sequence', 'byte output that is not valid UTF-8 cannot be represented by this string-based terminal')
  }
}
