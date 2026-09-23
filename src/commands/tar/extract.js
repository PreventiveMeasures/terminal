// Entries written out of an archive into the writable overlay, as GNU tar
// 1.35 writes them over whatever is already there: a file or a link in the
// way is unlinked, never written through; an empty directory in the way is
// removed, a full one is "File exists"; a directory already there is kept,
// though a link to one is replaced; a missing parent is made. `-k` leaves a
// name that is already taken alone, and says so. A link on the way to a
// name is followed, as the kernel follows one, since only the last name is
// ever unlinked.
//
// The overlay holds no permissions and no times — `ls -l` shows every entry
// of this tree the one way — so what an entry says of those is not kept; it
// holds no hard links and no devices either, and an entry that would make
// one is a gap. So is a name outside /tmp, which is the read-only filesystem
// every other write here meets.

import { dirname, lookup, resolve } from '../../fs.js'
import { inOverlay } from '../../writable.js'
import { quoteColon, quoteLocale } from './names.js'

const WRITTEN = new Set(['file', 'contiguous-file', 'directory', 'symlink'])

// Where the entry goes once the leading components are stripped off it, or
// null where stripping leaves nothing — an entry GNU passes over whole.
export function strippedName(stored, strip) {
  const parts = stored.split('/').filter((part) => part !== '')
  return parts.length <= strip ? null : parts.slice(strip).join('/')
}

// Where a name lands: the directory `-C` led to, and the name under it.
export const landing = (dir, name) => resolve(dir, name)

// `name` is what GNU calls the entry in what it says of it: the name it is
// extracted under, stripped and with no slash after it; `path` is where it
// goes. True where the entry was written; ends the run on a gap, and
// reports a name it cannot take as GNU does, going on to the next. `made` is
// told how many directories above the name were made for it.
export function extractEntry(entry, name, path, state, keepOld, made = () => {}) {
  const { ctx } = state
  const named = quoteColon(name, ctx)
  if (!WRITTEN.has(entry.type)) {
    const what = entry.type === 'link' ? 'hard links' : 'special files'
    return state.refuse('feature', entry.type, `${named}: extracting ${what} is not supported`)
  }
  const verb = entry.type === 'directory' ? 'mkdir' : 'open'
  const readOnly = () => state.refuse('feature', 'read-only target', `${named}: Cannot ${verb}: Read-only file system`)
  if (!ctx.writable || !inOverlay(path)) return readOnly()
  const parents = makeParents(dirname(path), state)
  if (parents === 'read-only') return readOnly()
  if (typeof parents === 'string') return state.error(`${named}: Cannot ${verb}: ${parents}`)
  if (parents > 0) made(parents)
  if (entry.type === 'directory') return makeDirectory(path, named, state)
  const refusal = entry.type === 'symlink' ? `Cannot create symlink to ${quoteLocale(entry.linkname, ctx)}` : 'Cannot open'
  const taken = lookup('/', path, ctx.fs, { follow: false }).path !== null
  if (taken && (keepOld || !clear(path, ctx.fs))) return state.error(`${named}: ${refusal}: File exists`)
  if (entry.type === 'symlink') return ctx.fs.makeWritableLink('/', path, entry.linkname) || readOnly()
  const handle = ctx.fs.openWritable('/', path)
  if (!handle) return readOnly()
  handle.writeBytes(entry.data)
  return true
}

// Every directory above the name, made where it is missing, and how many
// were. What stops it is said as the reason the entry cannot be opened; a
// directory the overlay cannot hold is the read-only filesystem.
function makeParents(path, state) {
  const { fs } = state.ctx
  const missing = []
  for (let at = path; ; at = dirname(at)) {
    const found = lookup('/', at, fs)
    if (found.path !== null) {
      if (!fs.isDir(found.path)) return 'Not a directory'
      break
    }
    // A link leading nowhere is a name taken, which no directory can be.
    if (lookup('/', at, fs, { follow: false }).path !== null) return 'File exists'
    missing.push(at)
  }
  for (const dir of missing.toReversed()) {
    if (!inOverlay(dir) || !fs.makeWritableDir('/', dir)) return 'read-only'
  }
  return missing.length
}

function makeDirectory(path, named, state) {
  const { fs } = state.ctx
  const found = lookup('/', path, fs, { follow: false })
  if (found.path !== null && fs.isDir(found.path) && !fs.isLink?.(found.path)) return true
  if (found.path !== null && !clear(path, fs)) return state.error(`${named}: Cannot mkdir: File exists`)
  fs.makeWritableDir('/', path)
  return true
}

// Takes away what stands at the name: a file or a link unlinked, an empty
// directory removed. A directory with anything in it stays.
function clear(path, fs) {
  const found = lookup('/', path, fs, { follow: false })
  if (fs.isDir(found.path) && !fs.isLink?.(found.path)) {
    const { dirs, files, links } = fs.listDir(found.path)
    if (dirs.length || files.length || links.length) return false
    fs.removeWritableDir('/', path)
    return true
  }
  fs.removeWritable('/', path)
  return true
}
