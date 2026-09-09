import { compareNames, lookup, resolve, walkTree } from './fs.js'
import { encodeUtf8, utf8Decoder } from './util.js'

// Only the overlay owns mutable bytes. The mounted source map and its
// directory index remain separate and are never copied into this map.
export function writableFs(base) {
  const files = new Map()
  let observer
  const root = base.listDir('/')
  const rootEntries = { dirs: [...root.dirs, 'tmp'].sort(compareNames), files: root.files }
  let tmpEntries = null
  const put = (path, inode) => {
    if (!path.startsWith('/tmp/')) throw new Error('writable overlay paths must start with /tmp/')
    if (!files.has(path)) tmpEntries = null
    files.set(path, inode)
  }
  const fs = {
    observeIo: (value) => { observer = value },
    fileIdentity: (path) => files.get(path),
    readIdentity: (inode) => { observer?.read(inode); return utf8Decoder.decode(inode.bytes) },
    isFile: (path) => files.has(path) || base.isFile(path),
    isDir: (path) => path === '/tmp' || base.isDir(path),
    readFile: (path) => {
      const inode = files.get(path)
      observer?.read(inode ?? path)
      return inode ? utf8Decoder.decode(inode.bytes) : base.readFile(path)
    },
    listDir: (path) => {
      if (path === '/') return rootEntries
      if (path !== '/tmp') return base.listDir(path)
      return tmpEntries ??= { dirs: [], files: [...files.keys()].map((key) => key.slice('/tmp/'.length)).sort(compareNames) }
    },
    *walkFiles(path) {
      for (const entry of walkTree(fs, path)) if (entry.kind === 'file') yield entry.path
    },
    openWritable(cwd, path, append = false) {
      const absolute = resolve(cwd, path)
      if (absolute !== '/tmp' && !absolute.startsWith('/tmp/')) return null
      checkTarget(fs, cwd, path)
      let inode = files.get(absolute)
      if (!inode) { inode = { bytes: new Uint8Array() }; put(absolute, inode) }
      else if (!append) { observer?.write(inode); inode.bytes = new Uint8Array() }
      return writeHandle(absolute, inode, append, () => observer?.write(inode))
    },
    replaceWritable(cwd, path, content, backupPath) {
      const absolute = resolve(cwd, path)
      const backup = backupPath === undefined ? null : resolve(cwd, backupPath)
      if (!absolute.startsWith('/tmp/') || backup !== null && !backup.startsWith('/tmp/')) return false
      checkTarget(fs, cwd, path)
      const inode = files.get(absolute)
      if (!inode) throw new Error(`${path}: No such file or directory`)
      if (backup !== null) checkTarget(fs, cwd, backupPath)
      const replacement = { bytes: encodeUtf8(content) }
      if (backup !== null) put(backup, inode)
      // Renaming a replacement keeps already-open descriptors on the old file.
      put(absolute, replacement)
      return true
    },
    removeWritable(cwd, path) {
      const absolute = resolve(cwd, path)
      if (absolute !== '/tmp' && !absolute.startsWith('/tmp/')) return false
      const found = lookup(cwd, path, fs)
      if (found.error) throw new Error(`${path}: ${found.error}`)
      if (fs.isDir(found.path)) throw new Error(`${path}: Is a directory`)
      // Open handles retain the unlinked inode until their last writer ends.
      files.delete(found.path)
      tmpEntries = null
      return true
    },
  }
  return fs
}

function checkTarget(fs, cwd, path) {
  const found = lookup(cwd, path, fs)
  if (found.path !== null) {
    if (fs.isDir(found.path)) throw new Error(`${path}: Is a directory`)
    return
  }
  if (found.error !== 'No such file or directory' || path.includes('\0') || path.endsWith('/')) throw new Error(`${path}: ${found.error}`)
  // Preserve components until lookup has checked them: file/../new and
  // missing/../new cannot create a sibling by lexical normalization alone.
  const slash = path.lastIndexOf('/')
  const parent = slash < 0 ? '.' : path.slice(0, slash) || '/'
  const directory = lookup(cwd, parent, fs)
  if (directory.error) throw new Error(`${path}: ${directory.error}`)
  if (!fs.isDir(directory.path)) throw new Error(`${path}: Not a directory`)
}

function writeHandle(path, inode, append, check) {
  let offset = 0
  return {
    path,
    identity: inode,
    get position() { return append ? inode.bytes.length : offset },
    write(text) {
      if (text === '') return
      check()
      const bytes = encodeUtf8(text)
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
    },
  }
}
