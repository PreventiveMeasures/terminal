import { compareNames, dirname, lookup, walkPath, walkTree, writeTarget } from './fs.js'
import { decodeUtf8, encodeUtf8 } from './util.js'

// The overlay is mounted at /tmp, so what may be written is what falls inside
// it. Commands ask before acting, where the answer decides more than whether a
// write would succeed.
export const inOverlay = (absolute) => absolute === '/tmp' || absolute.startsWith('/tmp/')


// Only the overlay owns mutable bytes. The mounted source map and its
// directory index remain separate and are never copied into this map.
export function writableFs(base) {
  const files = new Map()
  // Directories the overlay holds. `/tmp` is there from the start and the rest
  // are made deliberately, by `cp -r`; a file's parent is always one of them,
  // since nothing may be written where no directory is.
  const dirs = new Set(['/tmp'])
  let observer
  const root = base.listDir('/')
  const rootEntries = { dirs: [...root.dirs, 'tmp'].sort(compareNames), files: root.files, links: root.links ?? [] }
  const listings = overlayListings(dirs, files)
  const reshaped = listings.reshaped
  const put = (path, inode) => {
    if (!path.startsWith('/tmp/')) throw new Error('writable overlay paths must start with /tmp/')
    if (!files.has(path)) reshaped()
    files.set(path, inode)
  }
  const fs = {
    observeIo: (value) => { observer = value },
    fileIdentity: (path) => files.get(path),
    fileSize: (path) => files.get(path)?.bytes.length ?? base.fileSize(path),
    readIdentity: (inode) => { observer?.read(inode); return decodeUtf8(inode.bytes) },
    isFile: (path) => files.has(path) || base.isFile(path),
    isDir: (path) => dirs.has(path) || base.isDir(path),
    // Nothing here makes a link, so the sources own every one there is.
    isLink: (path) => base.isLink?.(path) === true,
    readLink: (path) => base.readLink?.(path),
    readFile: (path) => {
      const inode = files.get(path)
      observer?.read(inode ?? path)
      return inode ? decodeUtf8(inode.bytes) : base.readFile(path)
    },
    sameFileContents: (a, b) => sameFileContents(base, files, a, b),
    listDir: (path) => {
      if (path === '/') return rootEntries
      return dirs.has(path) ? listings.of(path) : base.listDir(path)
    },
    *walkFiles(path) {
      for (const entry of walkTree(fs, path)) if (entry.kind === 'file') yield entry.path
    },
    openWritable(cwd, path, append = false) {
      const absolute = writeTarget(fs, cwd, path)
      if (absolute !== '/tmp' && !absolute.startsWith('/tmp/')) return null
      checkTarget(fs, cwd, path)
      let inode = files.get(absolute)
      if (!inode) { inode = { bytes: new Uint8Array() }; put(absolute, inode) }
      else if (!append) { observer?.write(inode); inode.bytes = new Uint8Array() }
      return writeHandle(absolute, inode, append, () => observer?.write(inode))
    },
    makeWritableDir: (cwd, path) => addDirectory(fs, { dirs, files, reshaped }, cwd, path),
    removeWritableDir: (cwd, path) => dropDirectory(fs, { dirs, reshaped }, cwd, path),
    copyWritable(cwd, source, target) {
      const absolute = writeTarget(fs, cwd, target)
      if (!absolute.startsWith('/tmp/')) return false
      checkTarget(fs, cwd, target)
      const inode = files.get(source)
      if (source === absolute || inode && inode === files.get(absolute)) throw new Error('source and destination are the same file')
      observer?.read(inode ?? source)
      // An overlay may contain byte sequences that have no string equivalent.
      // Copy them directly while keeping truncation and writes observable.
      const bytes = inode ? inode.bytes : encodeUtf8(base.readFile(source))
      fs.openWritable(cwd, target).writeBytes(bytes)
      return true
    },
    replaceWritable: (cwd, path, content, backup) => replaceFile(fs, { files, put }, cwd, path, content, backup),
    removeWritable(cwd, path) {
      const absolute = writeTarget(fs, cwd, path, false)
      if (absolute !== '/tmp' && !absolute.startsWith('/tmp/')) return false
      const found = lookup(cwd, path, fs)
      if (found.error) throw pathError(path, found.error)
      if (fs.isDir(found.path)) throw new Error(`${path}: Is a directory`)
      // Open handles retain the unlinked inode until their last writer ends.
      files.delete(found.path)
      reshaped()
      return true
    },
  }
  return fs
}

// `cp -r` is the one thing that makes a directory here, and it makes each one
// before what goes inside it, so a parent is never missing by the time a child
// is asked for. `false` says the path is not the overlay's to make, which is
// the read-only filesystem every other write meets outside /tmp/.
function addDirectory(fs, overlay, cwd, path) {
  // `mkdir` never follows a link in the final position: a name already there
  // is `File exists` whatever it leads to, so only the way to it resolves.
  const absolute = writeTarget(fs, cwd, path, false)
  if (absolute !== '/tmp' && !absolute.startsWith('/tmp/')) return false
  if (overlay.dirs.has(absolute)) return true
  checkTarget(fs, cwd, path)
  // checkTarget passes a name already taken by a file, which is not a name a
  // directory can take.
  if (overlay.files.has(absolute)) throw new Error(`${path}: File exists`)
  overlay.dirs.add(absolute)
  overlay.reshaped()
  return true
}

// A whole-file rewrite, as `sed -i` and `patch` make one, optionally keeping
// what was there under a backup name.
function replaceFile(fs, overlay, cwd, path, content, backupPath) {
  // A whole-file rewrite replaces the name, as `sed -i` replaces a link with
  // the file it wrote rather than writing what the link named.
  const absolute = writeTarget(fs, cwd, path, false)
  const backup = backupPath === undefined ? null : writeTarget(fs, cwd, backupPath, false)
  if (!absolute.startsWith('/tmp/') || backup !== null && !backup.startsWith('/tmp/')) return false
  checkTarget(fs, cwd, path)
  const inode = overlay.files.get(absolute)
  if (!inode) throw pathError(path, 'No such file or directory')
  if (backup !== null) checkTarget(fs, cwd, backupPath)
  const replacement = { bytes: encodeUtf8(content) }
  if (backup !== null) overlay.put(backup, inode)
  // Renaming a replacement keeps already-open descriptors on the old file.
  overlay.put(absolute, replacement)
  return true
}

// Removing a directory is removing it alone: `rm -r` clears what is inside it
// first, so anything left here is a caller's mistake. `/tmp` is where the
// overlay is mounted rather than something inside it, and a mount point is not
// the tree below it to remove — which is the busy device Linux reports.
function dropDirectory(fs, overlay, cwd, path) {
  const absolute = writeTarget(fs, cwd, path, false)
  if (absolute !== '/tmp' && !absolute.startsWith('/tmp/')) return false
  const found = lookup(cwd, path, fs)
  if (found.error) throw pathError(path, found.error)
  if (!overlay.dirs.has(found.path)) throw new Error(`${path}: Not a directory`)
  if (found.path === '/tmp') throw new Error(`${path}: Device or resource busy`)
  const { dirs, files } = fs.listDir(found.path)
  if (dirs.length || files.length) throw new Error(`${path}: Directory not empty`)
  overlay.dirs.delete(found.path)
  overlay.reshaped()
  return true
}

// A directory's listing, built when it is asked for and dropped whole when the
// overlay changes shape: a scratch tree is cheaper to rebuild than to keep in
// step entry by entry. Names are sorted as the source tree sorts its own.
function overlayListings(dirs, files) {
  let cache = new Map()
  const children = (paths, prefix) => [...paths]
    .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    .map((path) => path.slice(prefix.length)).sort(compareNames)
  return {
    reshaped: () => { cache = new Map() },
    of(path) {
      const cached = cache.get(path)
      if (cached) return cached
      const entries = { dirs: children(dirs, path + '/'), files: children(files.keys(), path + '/'), links: [] }
      cache.set(path, entries)
      return entries
    },
  }
}

// Informational comparisons must not register command input reads or decode
// overlay bytes: malformed UTF-8 must not turn a missing-path hint into an error.
function sameFileContents(base, files, a, b) {
  const first = files.get(a), second = files.get(b)
  if (!first && !second) return base.sameFileContents(a, b)
  const bytes = (path, inode) => {
    if (inode) return inode.bytes
    const text = base.readFile(path)
    return text.isWellFormed() ? encodeUtf8(text) : null
  }
  const left = bytes(a, first), right = bytes(b, second)
  return left !== null && right !== null && left.length === right.length && left.every((byte, i) => byte === right[i])
}

// What a name can be written as, asked of the walk rather than of the spelling:
// components are checked where they are, so `file/../new` and `missing/../new`
// cannot make a sibling by lexical normalization alone, and the name a link
// leads to answers for its own parent — a link into a directory that is not
// there names a file nothing can make, where the spelling's parent is fine.
function checkTarget(fs, cwd, path) {
  const found = walkPath(cwd, path, fs)
  if (found.error === null) {
    if (fs.isDir(found.path)) throw new Error(`${path}: Is a directory`)
    // A trailing slash names a directory, and what is there is not one.
    if (path.endsWith('/')) throw pathError(path, 'Not a directory')
    return
  }
  // Only the last name may be missing, and only where it is a name a file can
  // take: a trailing slash names a directory, and a NUL names nothing.
  if (found.rest.length > 0 || path.endsWith('/') || path.includes('\0')) throw pathError(path, found.error)
  if (!fs.isDir(dirname(found.path))) throw pathError(path, 'No such file or directory')
}

function pathError(path, fsError) {
  return Object.assign(new Error(`${path}: ${fsError}`), { path, fsError })
}

function writeHandle(path, inode, append, check) {
  let offset = 0
  const store = (bytes) => {
    const current = inode.bytes
    const start = append ? current.length : offset
    const length = Math.max(current.length, start + bytes.length)
    let buffer = current.buffer
    // Reuse capacity so commands writing one record at a time stay linear.
    if (buffer.byteLength < length) {
      buffer = new ArrayBuffer(Math.max(length, buffer.byteLength * 2))
      new Uint8Array(buffer).set(current)
    }
    const next = new Uint8Array(buffer, 0, length)
    next.set(bytes, start)
    inode.bytes = next
    offset = start + bytes.length
  }
  return {
    path,
    identity: inode,
    get position() { return append ? inode.bytes.length : offset },
    write(text) {
      if (text === '') return
      check()
      store(encodeUtf8(text))
    },
    writeBytes(bytes) {
      if (bytes.length === 0) return
      check()
      store(bytes)
    },
  }
}
