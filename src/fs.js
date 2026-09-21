// Read-only source map with a directory index derived from file paths.
// All internal lookups use normalized absolute paths.

// The byte codec directly rather than through util.js, which reaches back
// here for its own lookups.
import { decodeUtf8Maybe, encodeUtf8, encodeUtf8Loose } from './bytes.js'
import { fromBase64 } from '@exodus/bytes/base64.js'
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
  // A file declared in base64 is decoded the first time its bytes are asked
  // for, and is those bytes from then on; what can be answered without them
  // — its size, whether it is empty, whether it is bytes at all — reads the
  // map as it is.
  const held = (p) => {
    const content = files.get(p)
    if (!(content instanceof Base64Bytes)) return content
    const bytes = content.decode()
    files.set(p, bytes)
    return bytes
  }
  const fs = {
    isFile: (p) => files.has(p),
    isDir: (p) => childMap.has(p),
    isLink: (p) => links.has(p),
    readLink: (p) => links.get(p),
    // A file declared as bytes is read as the text they spell, which is what
    // every command here works in; one whose bytes spell none is said to be
    // what it is, rather than read as something it is not.
    readFile: (p) => {
      const content = held(p)
      return content === undefined || typeof content === 'string' ? content : textOfFile(content, JSON.stringify(p))
    },
    // The file as it is stored, for the commands that work in bytes: what a
    // copy carries, what a dump prints, and what decides that a search has
    // met something it cannot read. A file declared as text has the bytes its
    // text encodes to, and a lone surrogate encodes to none: a caller keeping
    // those bytes is told so, while one only measuring or slicing them reads
    // the replacement character each stands for, which is the byte count
    // `wc -c` and `head -c` have always worked in.
    readBytes: (p, loose = false) => {
      const content = held(p)
      if (typeof content !== 'string') return content
      return loose ? encodeUtf8Loose(content) : encodeUtf8(content)
    },
    // A link is as long as the path it holds, which is what the disk stores
    // of it and what `ls -l`, `du` and `stat` report for one.
    fileSize: (p) => childMap.has(p) ? undefined
      : links.has(p) ? encodeUtf8(links.get(p)).length
        : files.has(p) ? contentSize(files.get(p)) : undefined,
    sameFileContents: (a, b) => sameContents(held(a), held(b)),
    // What a comparison may read of a file without asking it to be text.
    exactBytes: (p) => exactBytes(held(p)),
    // Whether a file is held as bytes rather than as text, which is what says
    // that reading it as text may have no answer. Asking costs nothing, so a
    // command that answers for such a file need not read one to find out.
    isBytes: (p) => typeof files.get(p) === 'object',
    // Whether a file holds nothing at all, which `find -empty` asks of every
    // file it walks: a question about its length, answered without encoding
    // the text it holds or spelling out the bytes.
    isEmptyFile: (p) => { const content = files.get(p); return typeof content === 'string' ? content === '' : content?.length === 0 },
    listDir: (p) => {
      const entry = childMap.get(p)
      if (!entry) throw new Error(`not a directory: ${p}`)
      return entry
    },
    walkFiles: (root) => walkFiles(fs, root),
  }
  return fs
}

// A file's length in bytes, which is what it is stored as when it was
// declared as bytes, what its base64 spells without being decoded, and what
// its text encodes to when it was declared as one.
const contentSize = (content) => typeof content === 'string' ? encodeUtf8(content).length : content.length

// The bytes a file certainly has, for comparing one with another without
// reading either as text: a file declared as bytes has them, and one declared
// as text has what its text encodes to — unless that text holds a lone
// surrogate, which encodes to nothing a comparison could be sure of.
const exactBytes = (content) =>
  typeof content === 'string' ? (content.isWellFormed() ? encodeUtf8(content) : undefined) : content

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

// Informational comparisons must not throw, so two files are compared as the
// bytes they hold rather than as the text they may not spell. Two files of
// text are still compared as text: one whose text has no bytes is not the
// same file as one that is bytes, and saying so needs no encoding at all.
function sameContents(a, b) {
  if (a === undefined || b === undefined) return false
  if (typeof a === 'string' && typeof b === 'string') return a === b
  return sameBytes(exactBytes(a), exactBytes(b))
}

function sourceEntries(sources) {
  // A Map from another realm has the same internal storage but fails instanceof.
  try { return Map.prototype.entries.call(sources) } catch { return Object.entries(sources ?? {}) }
}

// A source value is the file's contents — text, or the bytes of one a string
// cannot spell — or an object saying what the entry is where neither can: a
// symbolic link, `{ type: 'link', target }`, or bytes spelt in base64,
// `{ format: 'base64', data }`, for a tree that arrives serialized as text.
// A value that declares neither stays ignored, as every non-string value was
// before links existed; one that says `type`, `target` or `format` is a
// deliberate declaration, so a misspelled one is refused rather than dropped
// into a tree where the entry would simply not be there.
function sourceEntry(value, key) {
  if (typeof value === 'string') return { content: value }
  // A `Uint8Array` — or any other one-byte view, `Buffer` among them — is the
  // file's bytes. They are copied, so the tree a terminal was made with is
  // the tree it keeps however the caller goes on to use the array.
  if (ArrayBuffer.isView(value)) return { content: byteContent(value, key) }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (value instanceof ArrayBuffer) {
    throw new TypeError(`createTerminal: source ${JSON.stringify(key)} is an ArrayBuffer; declare a file's bytes as a Uint8Array over it`)
  }
  if (value.format !== undefined) return { content: encodedContent(value, key) }
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

// Bytes spelt in base64: RFC 4648's alphabet in whole groups of four, a last
// group of two or three that spells whole bytes and nothing past them, and
// the `=` padding present or left off. The spelling is checked here, where
// every other declaration is, in one pass that allocates nothing; decoding
// it, which allocates the file, waits for the first reader.
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw](?:==)?|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=?)?$/u

function encodedContent(value, key) {
  const name = JSON.stringify(key)
  if (value.format !== 'base64') {
    throw new TypeError(`createTerminal: source ${name} declares format ${JSON.stringify(value.format)}; the only format is { format: 'base64', data }`)
  }
  if (typeof value.data !== 'string') throw new TypeError(`createTerminal: source ${name} must declare its base64 as a string in \`data\``)
  if (!BASE64.test(value.data)) throw new TypeError(`createTerminal: source ${name} declares base64 that does not decode`)
  return new Base64Bytes(value.data)
}

// The base64 of a file, and the length of the bytes it spells — three for
// every four characters, less what the padding stands for — which is what a
// listing, a size and `find -empty` ask without the bytes themselves.
class Base64Bytes {
  constructor(text) {
    this.text = text
    const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
    this.length = Math.floor((text.length - padding) * 3 / 4)
  }
  decode() { return fromBase64(this.text) }
}

// Only a view of single bytes says what a file holds: a wider one would be
// element order, not file order, and which of the two was meant is not this
// map's to guess.
function byteContent(value, key) {
  if (value.BYTES_PER_ELEMENT !== 1) {
    throw new TypeError(`createTerminal: source ${JSON.stringify(key)} is a ${value[Symbol.toStringTag] ?? 'view'}; declare a file's bytes as a Uint8Array`)
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
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
