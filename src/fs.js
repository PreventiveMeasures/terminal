// Path resolution over any filesystem shaped like the terminal's own, which
// filesystem.js builds. All internal lookups use normalized absolute paths.

// The byte codec directly rather than through util.js, which reaches back
// here for its own lookups.
import { decodeUtf8Maybe } from './bytes.js'
import { UnsupportedError } from './unsupported.js'

export function normalize(path) {
  const absolute = path.startsWith('/')
  const segs = path.split('/').filter(Boolean)
  const out = []
  for (const seg of segs) {
    if (seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out.at(-1) !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(seg)
  }
  if (absolute) return '/' + out.join('/')
  return out.length === 0 ? '.' : out.join('/')
}

export function resolve(cwd, path) {
  if (path.startsWith('/')) return normalize(path)
  return normalize(cwd + '/' + path)
}

// Linux gives one resolution 40 links before it calls the path a loop.
const LINK_LIMIT = 40

// The two lengths Linux holds a name to. A path is copied in from the caller
// whole before anything is looked up, into PATH_MAX bytes that end with its
// NUL, so one of 4096 bytes or more is too long before any component of it is
// asked about; and a directory answers for a component past NAME_MAX bytes,
// when the walk looks it up there, that no name that long can be in it. Both
// are bytes, as the kernel counts them: a marker is the one byte it stands
// for, and a character past ASCII the UTF-8 it encodes to.
const PATH_MAX = 4096
const NAME_MAX = 255
const TOO_LONG = 'File name too long'

// A name of `limit / 3` UTF-16 units or fewer cannot be `limit` bytes long,
// which is nearly every name, so only a longer one is counted.
function bytesAtLeast(text, limit) {
  if (text.length * 3 < limit) return false
  let bytes = 0
  for (let at = 0; at < text.length; at++) {
    const code = text.codePointAt(at)
    if (code < 0x80 || code >= 0xdc80 && code <= 0xdcff) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code < 0x10000) bytes += 3
    else { bytes += 4; at++ }
  }
  return bytes >= limit
}

// Whether a path is past what the kernel takes as one: the path itself is too
// long to be handed over, or a component of it too long to be looked up.
export const pathTooLong = (path) => bytesAtLeast(path, PATH_MAX)
export const nameTooLong = (name) => bytesAtLeast(name, NAME_MAX + 1)

// Only a filesystem carrying declared links answers this at all: the writable
// overlay and the view a wired command is handed pass it through, while a
// stand-in filesystem may leave it out entirely.
const isLink = (fs, path) => fs.isLink?.(path) === true

// Filesystem lookup must validate each component BEFORE collapsing `..`.
// Otherwise `missing/../file` or `file/../other` can read an unrelated file.
// Lexical helpers (dirname, basename, the public resolve API) stay separate.
//
// A link is replaced by what it names, component by component, as the kernel
// replaces it: the target is read from the directory the link sits in, and a
// target that is itself a link is followed in turn. `follow: false` stops at a
// link in the final position instead — what `lstat` answers, and what `find`,
// `ls -l`, `stat` and `du` ask of a name they are about to describe.
export function lookup(cwd, path, fs, { follow = true } = {}) {
  const found = walkPath(cwd, path, fs, { follow })
  if (found.error) return { path: null, error: found.error }
  if (path.endsWith('/') && !fs.isDir(found.path)) return { path: null, error: 'Not a directory' }
  return { path: found.path, error: null }
}

// The walk itself, for the one caller that wants more than an answer: where
// the resolution got to, what stopped it, and the components it never reached.
// `realpath` prints what a name that is not there yet would be, which is that
// furthest point plus what is left of the name. `lenient` is what `realpath -m`
// asks for, where none of the path need be there: a component the filesystem
// cannot answer for is kept as it was spelled and the walk goes on, so a `..`
// after it cancels it and a link past it is expanded as ever — a name too
// long to be there among them, since a lenient walk asks where a name would
// be rather than whether the kernel would take it.
export function walkPath(cwd, path, fs, { follow = true, lenient = false } = {}) {
  if (path === '' || path.includes('\0')) return { path: '/', error: 'No such file or directory', rest: [] }
  const rest = (path.startsWith('/') ? path : cwd + '/' + path).split('/').filter(Boolean)
  if (!lenient && pathTooLong(path)) return { path: '/', error: TOO_LONG, rest }
  // A trailing slash names a directory, which is the target's to be and not
  // the link's: `ls link/` lists what `link` points at however it was asked.
  const followFinal = follow || path.endsWith('/')
  let budget = LINK_LIMIT
  let at = '/'
  // The filesystem answers for a directory by its name alone, never through a
  // link, so where the spelling up to its last name is a plain run of names
  // that is a directory, walking it would cross nothing but directories and
  // end there. The walk starts there instead: asking again about every
  // directory above would cost a deep tree its depth at every name in it.
  const plain = rest.findIndex((part) => part === '.' || part === '..')
  const skip = Math.min(plain < 0 ? rest.length : plain, rest.length - 1)
  if (skip > 1) {
    const prefix = '/' + rest.slice(0, skip).join('/')
    if (fs.isDir(prefix)) { at = prefix; rest.splice(0, skip) }
  }
  while (rest.length > 0) {
    const part = rest.shift()
    if (!fs.isDir(at)) {
      if (!lenient) {
        const error = fs.isFile(at) || isLink(fs, at) ? 'Not a directory' : 'No such file or directory'
        return { path: at, error, rest: [part, ...rest] }
      }
      // Nothing under a name that is not a directory can be a link, so the
      // components below it are the ones they spell and nothing else.
      if (part === '..') at = dirname(at)
      else if (part !== '.') at = joinPath(at, part)
      continue
    }
    if (part === '..') { at = dirname(at); continue }
    if (!lenient && part !== '.' && nameTooLong(part)) return { path: at, error: TOO_LONG, rest: [part, ...rest] }
    if (part !== '.') at = joinPath(at, part)
    if (!isLink(fs, at) || (rest.length === 0 && !followFinal)) continue
    if (budget-- === 0) return { path: at, error: 'Too many levels of symbolic links', rest: [...rest] }
    const target = fs.readLink(at)
    at = target.startsWith('/') ? '/' : dirname(at)
    // A target written with a trailing slash names a directory, which is what
    // a `.` of its own asks of it: no walk consumes one where none is.
    rest.unshift(...target.split('/').filter(Boolean), ...(target.endsWith('/') ? ['.'] : []))
  }
  const missing = !fs.isDir(at) && !fs.isFile(at) && !isLink(fs, at)
  return { path: at, error: missing ? 'No such file or directory' : null, rest: [] }
}

// Which file a write lands on, and so which side of a boundary it falls. The
// kernel resolves every component of a name before it opens anything, so a
// link on the way decides — and at the end too, where opening a link opens
// what it names and a link to nothing is that name made. Unlinking a name and
// replacing it act on the name itself, as `lstat` reads one, and pass
// `follow: false`. A component that is not there is kept as it was spelled,
// since the file being made is the one being asked about.
// A name no resolution can start on — empty, or holding a NUL — keeps the
// spelling it came with, so it is answered for where it was aimed and the
// diagnostic is the one that name earns.
export const writeTarget = (fs, cwd, path, follow = true) => path === '' || path.includes('\0')
  ? resolve(cwd, path)
  : walkPath(cwd, path, fs, { follow, lenient: true }).path

// What creating `name` would fail with, before anything tries: path resolution
// reports a missing or non-directory parent ahead of whatever the filesystem
// would say about being read-only, and a name that resolves needs no answer.
// A trailing slash asks for a directory, which open(2) never makes: once the
// way to the last name is walked, that is EISDIR, whatever the last name is.
export function creationError(cwd, name, fs, found = lookup(cwd, name, fs)) {
  if (found.path !== null) return null
  if (name.endsWith('/') && !pathTooLong(name)) {
    const bare = name.replace(/\/+$/u, '')
    const cut = bare.lastIndexOf('/') + 1
    return (cut === 0 ? null : lookup(cwd, bare.slice(0, cut), fs).error) ?? 'Is a directory'
  }
  const slashed = slashedTarget(cwd, name, fs)
  if (slashed !== null) return slashed
  if (name === '' || name.includes('\0') || found.error !== 'No such file or directory') return found.error
  // The parent is the resolved name's rather than the spelling's: a link
  // leading into a directory that is not there names a file nothing can make,
  // where the spelling's own parent is fine. Asking the walk keeps every
  // component checked where it stands, so `file/../new` and `missing/../new`
  // cannot make a sibling by lexical normalization alone.
  const walk = walkPath(cwd, name, fs)
  if (walk.rest.length > 0) return walk.error
  return fs.isDir(dirname(walk.path)) ? null : 'Not a directory'
}

// The same for a name whose last component is a link: open(2) follows it to
// the name its target spells, and a target written with a trailing slash is
// that slash's to answer for — EISDIR, as for a name spelled with one, once
// the way to what it names is walked. Nothing, where no such link is there.
export function slashedTarget(cwd, name, fs) {
  if (name === '' || name.includes('\0') || pathTooLong(name)) return null
  let at = lookup(cwd, name, fs, { follow: false })
  for (let budget = LINK_LIMIT; at.error === null && isLink(fs, at.path) && budget > 0; budget--) {
    const target = fs.readLink(at.path)
    const from = dirname(at.path)
    if (target.endsWith('/')) {
      const bare = target.replace(/\/+$/u, '')
      const cut = bare.lastIndexOf('/') + 1
      return (cut === 0 ? null : lookup(from, bare.slice(0, cut), fs).error) ?? 'Is a directory'
    }
    at = lookup(from, target, fs, { follow: false })
  }
  return null
}

export function dirname(path) {
  const p = normalize(path)
  if (p === '/') return '/'
  const i = p.lastIndexOf('/')
  if (i < 0) return '.'
  return i === 0 ? '/' : p.slice(0, i)
}

export function basename(path) {
  const p = normalize(path)
  if (p === '/') return '/'
  const i = p.lastIndexOf('/')
  return p.slice(i + 1)
}

// UTF-8 byte order is code-point order for valid Unicode. JavaScript's
// default sort compares UTF-16 units and misorders astral characters.
export function compareNames(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a.codePointAt(i) - b.codePointAt(i)
  }
  return a.length - b.length
}

// Inputs are normalized; joining at the root must not introduce '//'.
export function joinPath(dir, name) {
  return dir === '/' ? '/' + name : dir + '/' + name
}

// abs must be a descendant of the normalized ancestor root.
export function relativeTo(root, abs) {
  return root === '/' ? abs.slice(1) : abs.slice(root.length + 1)
}

// The text a file's bytes spell, where they spell one. A file that holds
// bytes spelling no text has no reading as text at all: a command that works
// in bytes asks for those instead, and one that cannot is told which file it
// is rather than handed a mangling of it. Text cut apart mid-character is the
// codec's own gap and stays there. `label` names the file as the caller shows
// one, which is the quoted path here and the operand where a command reads it.
export function textOfFile(bytes, label, doing = 'reading them as text') {
  const text = decodeUtf8Maybe(bytes)
  if (text === undefined) {
    throw new UnsupportedError('feature', 'binary file', `${label} holds bytes that spell no text, and ${doing} is not supported`)
  }
  return text
}

export const sameBytes = (left, right) =>
  left !== undefined && right !== undefined && left.length === right.length && left.every((byte, i) => byte === right[i])

// Iterative depth-first traversal. Yield before consulting shouldDescend so
// find can prune the directory it just evaluated. Sorting makes the virtual
// tree deterministic; native readdir order itself is filesystem-dependent.
export function* walkTree(fs, root, maxDepth = Number.POSITIVE_INFINITY, shouldDescend = () => true) {
  if (fs.isFile(root)) { yield { path: root, kind: 'file', depth: 0 }; return }
  // A walk stops at a link rather than crossing it, which is where `find`,
  // `grep -r` and `rg` all stop without an option asking them to follow.
  if (!fs.isDir(root)) { if (isLink(fs, root)) yield { path: root, kind: 'link', depth: 0 }; return }
  const stack = [{ path: root, kind: 'dir', depth: 0 }]
  while (stack.length) {
    const entry = stack.pop()
    yield entry
    if (entry.kind !== 'dir' || entry.depth >= maxDepth || !shouldDescend(entry.path)) continue
    // A directory is read when the walk goes into it, after whatever the
    // walk did on reaching it — `find -exec rm -r` may have taken it away,
    // or put something else there — and one that cannot be read is said to
    // be what it is rather than read as what it was.
    if (!fs.isDir(entry.path)) {
      const error = fs.isFile(entry.path) || isLink(fs, entry.path) ? 'Not a directory' : 'No such file or directory'
      yield { path: entry.path, kind: 'unreadable', depth: entry.depth, error }
      continue
    }
    const { dirs, files, links = [] } = fs.listDir(entry.path)
    // Every list is sorted. Push the three merged, in reverse order, so the
    // children are visited in name order whatever their kinds.
    let dirIndex = dirs.length - 1
    let fileIndex = files.length - 1
    let linkIndex = links.length - 1
    while (dirIndex >= 0 || fileIndex >= 0 || linkIndex >= 0) {
      let kind = dirIndex >= 0 ? 'dir' : null
      let name = dirIndex >= 0 ? dirs[dirIndex] : null
      if (fileIndex >= 0 && (name === null || compareNames(files[fileIndex], name) >= 0)) { kind = 'file'; name = files[fileIndex] }
      if (linkIndex >= 0 && (name === null || compareNames(links[linkIndex], name) >= 0)) { kind = 'link'; name = links[linkIndex] }
      if (kind === 'dir') dirIndex--
      else if (kind === 'file') fileIndex--
      else linkIndex--
      stack.push({ path: joinPath(entry.path, name), kind, depth: entry.depth + 1 })
    }
  }
}

// Filter the same depth-first order used by find.
export function* walkFiles(fs, root) {
  for (const entry of walkTree(fs, root)) if (entry.kind === 'file') yield entry.path
}
