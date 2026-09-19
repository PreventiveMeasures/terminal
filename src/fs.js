// Read-only source map with a directory index derived from file paths.
// All internal lookups use normalized absolute paths.

import { encodeUtf8 } from './util.js'

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
// after it cancels it and a link past it is expanded as ever.
export function walkPath(cwd, path, fs, { follow = true, lenient = false } = {}) {
  if (path === '' || path.includes('\0')) return { path: '/', error: 'No such file or directory', rest: [] }
  const rest = (path.startsWith('/') ? path : cwd + '/' + path).split('/').filter(Boolean)
  // A trailing slash names a directory, which is the target's to be and not
  // the link's: `ls link/` lists what `link` points at however it was asked.
  const followFinal = follow || path.endsWith('/')
  let budget = LINK_LIMIT
  let at = '/'
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
    if (part !== '.') at = joinPath(at, part)
    // A name that is both a directory and a link stays the directory, as a
    // name that is both a file and a directory does: the index answers first.
    if (!isLink(fs, at) || fs.isDir(at) || (rest.length === 0 && !followFinal)) continue
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

// What creating `name` would fail with, before anything tries: path resolution
// reports a missing or non-directory parent ahead of whatever the filesystem
// would say about being read-only, and a name that resolves needs no answer.
export function creationError(cwd, name, fs, found = lookup(cwd, name, fs)) {
  if (found.path !== null) return null
  if (name === '' || name.includes('\0') || name.endsWith('/') || found.error !== 'No such file or directory') return found.error
  // The parent is the resolved name's rather than the spelling's: a link
  // leading into a directory that is not there names a file nothing can make,
  // where the spelling's own parent is fine. Asking the walk keeps every
  // component checked where it stands, so `file/../new` and `missing/../new`
  // cannot make a sibling by lexical normalization alone.
  const walk = walkPath(cwd, name, fs)
  if (walk.rest.length > 0) return walk.error
  return fs.isDir(dirname(walk.path)) ? null : 'Not a directory'
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

// Ignore non-string contents. Map keys and object keys share normalization;
// the directory index is built once for repeated listings and traversal.
export function createFs(sources, mount = '/') {
  const files = new Map()
  const links = new Map()
  for (const [k, v] of sourceEntries(sources)) {
    const key = String(k)
    const entry = sourceEntry(v, key)
    if (entry === null) continue
    // Normalize inside the source root before mounting; leading / and ..
    // in a source key cannot place a file outside its mount.
    if (key.includes('\0')) throw new TypeError('createTerminal: source paths must not contain NUL characters')
    const path = normalize('/' + key)
    const at = mount === '/' ? path : path === '/' ? mount : mount + path
    // One name is one entry: a later declaration replaces an earlier one
    // whichever of the two each of them was.
    if (entry.link === undefined) { files.set(at, entry.content); links.delete(at) }
    else { links.set(at, entry.link); files.delete(at) }
  }
  const childMap = new Map([['/', { dirs: [], files: [], links: [] }]])
  ensureDir(childMap, mount)
  for (const [list, entries] of [['files', files], ['links', links]]) {
    for (const f of entries.keys()) {
      // Keys are already normalized, so split without normalizing again.
      const split = f.lastIndexOf('/')
      const parent = f.slice(0, split) || '/'
      ensureDir(childMap, parent)
      childMap.get(parent)[list].push(f === '/' ? '/' : f.slice(split + 1))
    }
  }
  for (const entry of childMap.values()) {
    entry.dirs.sort(compareNames)
    entry.files.sort(compareNames)
    entry.links.sort(compareNames)
  }
  const fs = {
    isFile: (p) => files.has(p),
    isDir: (p) => childMap.has(p),
    isLink: (p) => links.has(p),
    readLink: (p) => links.get(p),
    readFile: (p) => files.get(p),
    // A link is as long as the path it holds, which is what the disk stores
    // of it and what `ls -l`, `du` and `stat` report for one.
    fileSize: (p) => childMap.has(p) ? undefined
      : links.has(p) ? encodeUtf8(links.get(p)).length
        : files.has(p) ? encodeUtf8(files.get(p)).length : undefined,
    sameFileContents: (a, b) => files.get(a) === files.get(b),
    listDir: (p) => {
      const entry = childMap.get(p)
      if (!entry) throw new Error(`not a directory: ${p}`)
      return entry
    },
    walkFiles: (root) => walkFiles(fs, root),
  }
  return fs
}

function sourceEntries(sources) {
  // A Map from another realm has the same internal storage but fails instanceof.
  try { return Map.prototype.entries.call(sources) } catch { return Object.entries(sources ?? {}) }
}

// A source value is the file's contents, or an object saying what the entry is
// where a string cannot spell it — today a symbolic link, `{ type: 'link',
// target }`. A value that declares neither stays ignored, as every non-string
// value was before links existed; one that says `type` or `target` is a
// deliberate declaration, so a misspelled one is refused rather than dropped
// into a tree where the entry would simply not be there.
function sourceEntry(value, key) {
  if (typeof value === 'string') return { content: value }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.type === undefined && value.target === undefined) return null
  const name = JSON.stringify(key)
  if (value.type !== 'link') {
    throw new TypeError(`createTerminal: source ${name} declares type ${JSON.stringify(value.type ?? null)}; the only declaration is { type: 'link', target }`)
  }
  const { target } = value
  if (typeof target !== 'string' || target === '' || target.includes('\0')) {
    throw new TypeError(`createTerminal: link ${name} must declare a non-empty target without NUL characters`)
  }
  return { link: target }
}

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
    const { dirs, files, links = [] } = fs.listDir(entry.path)
    // Every list is sorted. Push in reverse order, a colliding directory
    // last of the three, so it and its descendants are visited before the
    // file or the link that shares its name.
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
function* walkFiles(fs, root) {
  for (const entry of walkTree(fs, root)) if (entry.kind === 'file') yield entry.path
}

// Build missing ancestors from the top down without recursive stack growth.
function ensureDir(map, path) {
  const toCreate = []
  let p = path
  while (p !== '/' && !map.has(p)) {
    toCreate.push(p)
    p = p.slice(0, p.lastIndexOf('/')) || '/'
  }
  for (let i = toCreate.length - 1; i >= 0; i--) {
    const child = toCreate[i]
    map.set(child, { dirs: [], files: [], links: [] })
    const split = child.lastIndexOf('/')
    map.get(child.slice(0, split) || '/').dirs.push(child.slice(split + 1))
  }
}
