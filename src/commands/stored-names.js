// The names an archive stores, held against the clean ones
// @preventive/archive reads out of them. The package drops a name's `.`
// segments and a directory's trailing slash, and hands the name as stored
// out beside the clean one; GNU tar and UnZip print and match the name as
// it is stored: `./a`, `d/./f`, a directory stored as a plain `d`. Printing
// the clean one would be printing a name the archive does not have, so an
// archive holding a name the cleaning changed is refused, and so is one with
// an entry for its own root, which an extraction here does not handle as
// GNU's does.

// A directory is stored with its slash, which the package drops.
export const storedName = (entry) => (entry.type === 'directory' ? `${entry.name}/` : entry.name)

// Why a stored name cannot be printed, as a gap's detail and message: the
// package drops nothing else.
export const refusalOf = (stored) => (/(?:^|\/)\.(?:\/|$)/u.test(stored)
  ? ['dot-segment names', "names stored with `.' segments are not supported"]
  : ['directory names', 'directories stored without a trailing slash are not supported'])

// The name or link target an entry stores otherwise than the package's
// clean one reads, or null. Only tar hands out a link target as stored: a
// zip's symlink target is its data, which is never cleaned.
export function rewritten(entry) {
  if (entry.name === '.' || entry.storedName !== storedName(entry)) return entry.storedName
  if (entry.storedLinkname !== undefined && entry.storedLinkname !== entry.linkname) return entry.storedLinkname
  return null
}
