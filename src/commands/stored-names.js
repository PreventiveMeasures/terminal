// The names an archive stores, held against what @preventive/archive hands
// out. The package cleans every name it reads — its `.` segments dropped,
// and a directory's trailing slash — and hands out the clean name alone,
// where GNU tar and UnZip print and match the name as it is stored: `./a`,
// `d/./f`, a directory stored as a plain `d`. Printing the clean one would
// be printing a name the archive does not have, so an archive holding a name
// the cleaning changed is refused, and so is one with an entry for its own
// root, which an extraction here does not handle as GNU's does. The stored
// names are read back out of the archive: a zip's from its central
// directory, here, and a tar's from its headers (see tar-headers.js).

import { decodeUtf8, encodeUtf8 } from '../util.js'

// A directory is stored with its slash, which the package drops.
export const storedName = (entry) => (entry.type === 'directory' ? `${entry.name}/` : entry.name)

// Why a stored name cannot be printed, as a gap's detail and message: the
// package drops nothing else.
export const refusalOf = (stored) => (/(?:^|\/)\.(?:\/|$)/u.test(stored)
  ? ['dot-segment names', "names stored with `.' segments are not supported"]
  : ['directory names', 'directories stored without a trailing slash are not supported'])

const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i])

// The stored name or link target the package hands out otherwise, or null.
export function rewritten(entry, name, linkname) {
  if (entry.name === '.' || !sameBytes(name, encodeUtf8(storedName(entry)))) return decodeUtf8(name)
  if (!sameBytes(linkname, encodeUtf8(entry.linkname))) return decodeUtf8(linkname)
  return null
}

// The first name a zip archive stores that the package hands out otherwise,
// or null: the central directory's names, in its order, which is the
// package's. The end record is the last one whose comment runs to the end
// of the archive, found as the package finds it. A symlink's target is its
// data, which the package hands out as it is.
export function zipRewritten(bytes, entries) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = bytes.length - 22
  while (view.getUint32(end, true) !== 0x06054b50 || end + 22 + view.getUint16(end + 20, true) !== bytes.length) end--
  let at = view.getUint32(end + 16, true)
  for (const entry of entries) {
    const length = view.getUint16(at + 28, true)
    const found = rewritten(entry, bytes.subarray(at + 46, at + 46 + length), encodeUtf8(entry.linkname))
    if (found !== null) return found
    at += 46 + length + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
  }
  return null
}
