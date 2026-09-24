// The terminal's filesystem: one @preventive/vfs tree, built from the sources
// and read through the methods every command asks of a filesystem, which the
// /tmp overlay (writable.js) writes into as well.

import { Vfs, VfsError } from '@preventive/vfs'
import { fromBase64 } from '@exodus/bytes/base64.js'
import { encodeUtf8 } from './bytes.js'
import { joinPath, normalize, sameBytes, textOfFile, walkFiles } from './fs.js'

// The tree the sources declare, under `mount`, as the filesystem a command
// reads.
export function createFs(sources, mount = '/') {
  const vfs = new Vfs()
  try { vfs.mkdir(mount, { recursive: true }) } catch (e) { throw asTypeError(e, `mount ${JSON.stringify(mount)}`) }
  const built = { declared: new Map(), made: new Set(['/', mount]) }
  for (const [k, v] of sourceEntries(sources)) {
    const key = String(k)
    if (key.includes('\0')) throw new TypeError('createTerminal: source paths must not contain NUL characters')
    const entry = sourceEntry(v, key)
    // Normalize inside the source root before mounting; leading / and ..
    // in a source key cannot place a file outside its mount.
    const path = normalize('/' + key)
    place(vfs, built, mount === '/' ? path : path === '/' ? mount : mount + path, entry, key)
  }
  return vfsFs(vfs)
}

// One name is one entry, as @preventive/vfs builds a tree from a map: a
// repeat is skipped where it declares exactly what is there — `a/f` and
// `a/./f` spell one name — and refused where it declares anything else,
// rather than letting declaration order pick a winner. A name is declared
// where it stands, so nothing is declared under a file or through a link:
// a link declared on the way would put an entry wherever the link leads.
function place(vfs, built, at, entry, key) {
  const before = built.declared.get(at)
  if (before !== undefined) {
    if (before === entry.type && sameEntry(vfs, at, entry)) return
    throw new TypeError(`createTerminal: source ${JSON.stringify(key)} names the same path as an earlier source, which declared something else there`)
  }
  built.declared.set(at, entry.type)
  const parent = at.slice(0, at.lastIndexOf('/')) || '/'
  if (!built.made.has(parent)) {
    try { vfs.mkdir(parent, { recursive: true }) } catch (e) {
      // mkdir -p makes nothing where a link leads, which is the one way a
      // directory it was asked for can be missing afterwards.
      if (e?.code === 'ENOENT') throw throughLink(key)
      throw asTypeError(e?.code === 'EEXIST' ? new VfsError('ENOTDIR', parent) : e, `source ${JSON.stringify(key)}`)
    }
    if (vfs.realpath(parent) !== parent) throw throughLink(key)
    built.made.add(parent)
  }
  try {
    if (entry.type === 'file') vfs.writeFile(at, entry.data)
    else if (entry.type === 'symlink') vfs.symlink(entry.target, at)
    else {
      try { vfs.mkdir(at) } catch (e) { if (e?.code !== 'EEXIST' || vfs.lstat(at).type !== 'directory') throw e }
      built.made.add(at)
    }
  } catch (e) { throw asTypeError(e, `source ${JSON.stringify(key)}`) }
}

const throughLink = (key) => new TypeError(`createTerminal: source ${JSON.stringify(key)} is declared through a symbolic link; declare it where the link leads`)

// What the Vfs refused, said as the source that asked for it.
function asTypeError(error, what) {
  if (!(error instanceof VfsError)) return error
  return new TypeError(`createTerminal: ${what}: ${error.message}`, { cause: error })
}

// Whether a repeated declaration is the one already there: a directory is,
// a link holding the same target is, and a file holding the same bytes is.
function sameEntry(vfs, at, entry) {
  if (entry.type === 'directory') return true
  if (entry.type === 'symlink') return vfs.readlink(at) === entry.target
  return sameBytes(vfs.readFile(at), typeof entry.data === 'string' ? encodeUtf8(entry.data) : entry.data)
}

// Which of a directory's lists an entry of each type goes in.
const LISTS = { directory: 'dirs', file: 'files', symlink: 'links' }

const parentOf = (path) => path.slice(0, path.lastIndexOf('/')) || '/'
const emptyListing = () => ({ dirs: [], files: [], links: [] })

// The filesystem a Vfs is read as. A path handed to it is absolute and
// normalized, as a lookup leaves one, and a final link is never followed:
// the lookup has followed it already where its caller wanted that. `vfs` is
// the tree itself, for the /tmp overlay to write into.
//
// The tree as it was built is indexed once, in one walk, when it is first
// asked about, as a directory index was built from the sources before: what
// a name is, and what a directory lists, are then a lookup away however deep
// they are, where the Vfs resolves every path from the root. Where the tree
// may change from — `writableAt` names it — names are read from the Vfs as
// they are asked for instead, one directory at a time, and forgotten each
// time a writer says the tree has `reshaped`.
function vfsFs(vfs) {
  let writableRoot = null
  let fixed = null
  let changing = { children: new Map(), types: new Map() }
  const indexed = () => fixed ??= index(vfs, volatile)
  const texts = new WeakMap()
  const volatile = (dir) => writableRoot !== null && (dir === writableRoot || dir.startsWith(writableRoot + '/'))
  // A changing directory's children, each kind sorted, and the type of each
  // by name, read once until the tree changes shape again.
  const childrenOf = (dir) => {
    let children = changing.children.get(dir)
    if (children !== undefined) return children
    children = { listing: emptyListing(), types: new Map() }
    for (const name of vfs.readdir(dir)) {
      const { type } = vfs.lstat(joinPath(dir, name))
      children.types.set(name, type)
      children.listing[LISTS[type]].push(name)
    }
    changing.children.set(dir, children)
    return children
  }
  // What an absolute, normalized path names: the name itself, never where a
  // link there leads, and nothing for a path spelled any other way. A path
  // that names nothing is answered without a lookup failing on it. Under a
  // changing directory the answer is kept, '' for nothing, as a listing is,
  // and the ancestors not yet asked about are answered top down.
  const type = (p) => {
    if (typeof p !== 'string' || !p.startsWith('/')) return
    if (p === '/') return 'directory'
    const pending = []
    let at = p
    while (volatile(parentOf(at)) && !changing.types.has(at)) {
      pending.push(at)
      at = parentOf(at)
    }
    let found = volatile(parentOf(at)) ? changing.types.get(at) : indexed().types.get(at) ?? ''
    for (let i = pending.length - 1; i >= 0; i--) {
      const path = pending[i]
      found = found === 'directory' ? childrenOf(parentOf(path)).types.get(path.slice(path.lastIndexOf('/') + 1)) ?? '' : ''
      changing.types.set(path, found)
    }
    return found || undefined
  }
  const stat = (p) => type(p) === undefined ? undefined : vfs.lstat(p)
  const bytes = (p) => type(p) === 'file' ? vfs.readFile(p) : undefined
  const fs = {
    vfs,
    writableAt: (dir) => {
      writableRoot = dir
      fixed = null
      changing = { children: new Map(), types: new Map() }
    },
    reshaped: () => { changing = { children: new Map(), types: new Map() } },
    isFile: (p) => type(p) === 'file',
    isDir: (p) => type(p) === 'directory',
    isLink: (p) => type(p) === 'symlink',
    readLink: (p) => type(p) === 'symlink' ? vfs.readlink(p) : undefined,
    // Every file is bytes, and is read as the text they spell, which is what
    // every command here works in; one whose bytes spell none is said to be
    // what it is, rather than read as something it is not. The text is kept
    // for as long as the bytes are the file's.
    readFile: (p) => {
      const held = bytes(p)
      let text = held && texts.get(held)
      if (held && text === undefined) texts.set(held, text = textOfFile(held, JSON.stringify(p)))
      return text
    },
    // The file as it is stored, for the commands that work in bytes: what a
    // copy carries, what a dump prints, and what decides that a search has
    // met something it cannot read. They are the tree's own: not to be
    // written into.
    readBytes: (p) => bytes(p),
    // A link is as long as the path it holds, which is what the disk stores
    // of it and what `ls -l`, `du` and `stat` report for one.
    fileSize: (p) => { const s = stat(p); return s === undefined || s.type === 'directory' ? undefined : s.size },
    // Informational comparisons must not throw, so two files are compared as
    // the bytes they hold rather than as the text they may not spell.
    sameFileContents: (a, b) => sameBytes(bytes(a), bytes(b)),
    exactBytes: bytes,
    // Whether reading a file as text may have no answer, which is so of
    // every file: each one holds bytes, which may spell text or may not.
    isBytes: (p) => type(p) === 'file',
    // Whether a file holds nothing at all, which `find -empty` asks of every
    // file it walks: a question about its length, answered without reading it.
    isEmptyFile: (p) => { const s = stat(p); return s?.type === 'file' && s.size === 0 },
    listDir: (p) => {
      if (type(p) !== 'directory') throw new Error(`not a directory: ${p}`)
      return volatile(p) ? childrenOf(p).listing : indexed().children.get(p)
    },
    walkFiles: (root) => walkFiles(fs, root),
  }
  return fs
}

// Every name the tree holds outside the directories `volatile` says may
// change, and every directory's listing, from one walk of the tree.
function index(vfs, volatile) {
  const children = new Map([['/', emptyListing()]])
  const types = new Map([['/', 'directory']])
  // The directory each depth of the walk is in, so a parent is never
  // searched for in the path below it.
  const dirs = ['/']
  for (const { path, type, depth } of vfs.walk('/')) {
    if (depth === 0) continue
    const dir = dirs[depth - 1]
    if (type === 'directory') dirs[depth] = path
    if (volatile(dir)) continue
    if (type === 'directory') children.set(path, emptyListing())
    children.get(dir)[LISTS[type]].push(path.slice(dir.length + (dir === '/' ? 0 : 1)))
    types.set(path, type)
  }
  return { children, types }
}

function sourceEntries(sources) {
  // A Map from another realm has the same internal storage but fails instanceof.
  try { return Map.prototype.entries.call(sources) } catch { return Object.entries(sources ?? {}) }
}

// What each declared type may say besides its type. A mode and an mtime are
// what a Vfs could keep, and this terminal does not yet: every name is dated
// to the terminal's creation, and `ls -l` shows the modes it always has.
const FIELDS = { file: ['data'], directory: [], symlink: ['target'] }
const UNKEPT = new Set(['mode', 'mtime'])

// A source value is a file's contents — text, or the bytes of one a string
// cannot spell — or an object saying what the entry is, in the shapes
// @preventive/vfs declares: `{ type: 'file', data }`, `{ type: 'directory' }`
// and `{ type: 'symlink', target }`; or bytes spelt in base64,
// `{ format: 'base64', data }`, for a tree that arrives serialized as text.
// Anything else is refused rather than dropped, so a tree holds every entry
// it was declared with, and nothing a declaration said is left unsaid.
function sourceEntry(value, key) {
  const name = JSON.stringify(key)
  if (typeof value === 'string') return { type: 'file', data: textContent(value, key) }
  // A `Uint8Array` — or any other one-byte view, `Buffer` among them — is the
  // file's bytes. They are copied, so the tree a terminal was made with is
  // the tree it keeps however the caller goes on to use the array.
  if (ArrayBuffer.isView(value)) return { type: 'file', data: byteContent(value, key) }
  if (value instanceof ArrayBuffer) {
    throw new TypeError(`createTerminal: source ${name} is an ArrayBuffer; declare a file's bytes as a Uint8Array over it`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    const what = value === null ? 'null' : Array.isArray(value) ? 'an array' : value === undefined ? 'undefined' : `a ${typeof value}`
    throw new TypeError(`createTerminal: source ${name} is ${what}; a source is text, a Uint8Array, or an object declaring its type`)
  }
  if (value.format !== undefined) return { type: 'file', data: encodedContent(value, key) }
  const { type } = value
  if (type === 'link') throw new TypeError(`createTerminal: source ${name} declares type "link"; a symbolic link is declared as { type: 'symlink', target }`)
  if (type === 'hardlink') throw new TypeError(`createTerminal: source ${name} declares a hard link, which is not supported: each file here has the one name`)
  if (type === undefined) {
    throw new TypeError(`createTerminal: source ${name} declares no type; an object declares { type: 'file' | 'directory' | 'symlink' } or { format: 'base64', data }`)
  }
  if (!Object.hasOwn(FIELDS, type)) {
    throw new TypeError(`createTerminal: source ${name} declares type ${JSON.stringify(type)}; the types are 'file', 'directory' and 'symlink'`)
  }
  for (const field of Object.keys(value)) {
    if (field === 'type' || FIELDS[type].includes(field)) continue
    throw new TypeError(UNKEPT.has(field)
      ? `createTerminal: source ${name} declares \`${field}\`, which this terminal does not keep yet`
      : `createTerminal: source ${name} declares \`${field}\`, which a ${type} does not have`)
  }
  if (type === 'directory') return { type }
  if (type === 'symlink') {
    const { target } = value
    if (typeof target !== 'string' || target === '' || target.includes('\0')) {
      throw new TypeError(`createTerminal: link ${name} must declare a non-empty target without NUL characters`)
    }
    return { type, target }
  }
  const { data = '' } = value
  if (typeof data === 'string') return { type, data: textContent(data, key) }
  if (ArrayBuffer.isView(data)) return { type, data: byteContent(data, key) }
  throw new TypeError(`createTerminal: source ${name} declares \`data\` that is neither text nor a Uint8Array`)
}

// Text is kept as the UTF-8 it encodes to, and text with a lone surrogate
// encodes to none: its bytes are what to declare instead.
function textContent(text, key) {
  if (!text.isWellFormed()) {
    throw new TypeError(`createTerminal: source ${JSON.stringify(key)} holds a lone surrogate, which no UTF-8 spells; declare the file's bytes as a Uint8Array`)
  }
  return text
}

// Bytes spelt in base64: RFC 4648's alphabet, the `=` padding present or
// left off, decoded as the tree is built, so a spelling that does not decode
// is refused with every other declaration that cannot be what it says.
function encodedContent(value, key) {
  const name = JSON.stringify(key)
  if (value.format !== 'base64') {
    throw new TypeError(`createTerminal: source ${name} declares format ${JSON.stringify(value.format)}; the only format is { format: 'base64', data }`)
  }
  const extra = Object.keys(value).find((field) => field !== 'format' && field !== 'data')
  if (extra !== undefined) throw new TypeError(`createTerminal: source ${name} declares \`${extra}\`, which base64 contents do not have`)
  if (typeof value.data !== 'string') throw new TypeError(`createTerminal: source ${name} must declare its base64 as a string in \`data\``)
  try { return fromBase64(value.data) } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
    throw new TypeError(`createTerminal: source ${name} declares base64 that does not decode`, { cause: e })
  }
}

// Only a view of single bytes says what a file holds: a wider one would be
// element order, not file order, and which of the two was meant is not this
// map's to guess.
function byteContent(value, key) {
  if (value.BYTES_PER_ELEMENT !== 1) {
    throw new TypeError(`createTerminal: source ${JSON.stringify(key)} is a ${value[Symbol.toStringTag] ?? 'view'}; declare a file's bytes as a Uint8Array`)
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}
