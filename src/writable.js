import { VfsError } from '@preventive/vfs'
import { dirname, lookup, walkPath, writeTarget } from './fs.js'
import { decodeUtf8, encodeUtf8 } from './util.js'

// The overlay is mounted at /tmp, so what may be written is what falls inside
// it. Commands ask before acting, where the answer decides more than whether a
// write would succeed.
export const inOverlay = (absolute) => absolute === '/tmp' || absolute.startsWith('/tmp/')

const EMPTY = new Uint8Array()

// Writes land in the tree the sources are in, and only under /tmp: every
// method here answers `false` or `null` for a name outside it, which is the
// read-only filesystem every other write meets.
export function writableFs(base) {
  base.vfs.mkdir('/tmp', { recursive: true })
  base.writableAt('/tmp')
  const overlay = overlayOf(base)
  const observe = (path) => overlay.observer?.read(overlay.identity(path) ?? path)
  const fs = {
    ...base,
    observeIo: (value) => { overlay.observer = value },
    fileIdentity: overlay.identity,
    readIdentity: (cell) => { overlay.observer?.read(cell); return decodeUtf8(cellBytes(base.vfs, cell)) },
    readFile: (path) => { observe(path); return base.readFile(path) },
    readBytes: (path) => { observe(path); return base.readBytes(path) },
    openWritable: (cwd, path, append = false) => openFile(fs, overlay, cwd, path, append),
    makeWritableDir: (cwd, path) => addDirectory(fs, overlay, cwd, path),
    makeWritableLink: (cwd, path, target) => addLink(fs, overlay, cwd, path, target),
    removeWritableDir: (cwd, path) => dropDirectory(fs, overlay, cwd, path),
    copyWritable: (cwd, source, target) => copyFile(fs, overlay, cwd, source, target),
    replaceWritable: (cwd, path, content, backup) => replaceFile(fs, overlay, cwd, path, content, backup),
    removeWritable: (cwd, path) => removeFile(fs, overlay, cwd, path),
  }
  return fs
}

// A descriptor holds a file rather than a name, as the kernel's does, so a
// file written through one is the file it opened however its name moves or
// goes. That file is a cell: where its bytes are, `path`, while a name leads
// to them, and the bytes themselves, `detached`, once none does — an open
// descriptor keeps an unlinked file until its last writer ends. A cell is
// also the file's identity, which is what tells a command that its output is
// one of its inputs. Only a file under /tmp has one: nothing else changes,
// so its path is identity enough.
function overlayOf(base) {
  const { vfs } = base
  const cells = new Map()
  return {
    base,
    vfs,
    observer: undefined,
    identity: (path) => {
      if (!inOverlay(String(path)) || !base.isFile(path)) return
      const { ino } = vfs.lstat(path)
      let cell = cells.get(ino)
      if (cell === undefined) cells.set(ino, cell = { path: vfs.realpath(path), detached: undefined })
      return cell
    },
    // A file about to lose its name keeps its bytes in the cell a descriptor
    // may hold, once `release` says the name has gone.
    leaving: (path) => {
      const ino = base.isFile(path) ? vfs.lstat(path).ino : undefined
      const cell = cells.get(ino)
      return cell && { cell, ino, bytes: vfs.readFile(path) }
    },
    release: (left) => {
      if (!left) return
      left.cell.detached = left.bytes
      cells.delete(left.ino)
    },
    // A change to the tree's shape, said as the name that asked for it.
    change: (path, apply) => {
      try { return apply() } catch (e) {
        if (!(e instanceof VfsError)) throw e
        throw pathError(path, strerror(e.code))
      } finally { base.reshaped() }
    },
  }
}

// What the Vfs says of a code, without the path its messages put in front.
const strerror = (code) => new VfsError(code, '').message.slice(2)

// The bytes a cell's file holds: the tree's while a name leads to them, and
// its own once none does.
const cellBytes = (vfs, cell) => cell.detached ?? vfs.readFile(cell.path)

function openFile(fs, overlay, cwd, path, append) {
  const absolute = writeTarget(fs, cwd, path)
  if (!inOverlay(absolute)) return null
  checkTarget(fs, cwd, path)
  let cell = overlay.identity(absolute)
  if (cell === undefined) {
    overlay.change(path, () => overlay.vfs.writeFile(absolute, EMPTY))
    cell = overlay.identity(absolute)
  } else if (!append) {
    overlay.observer?.write(cell)
    overlay.vfs.writeFile(absolute, EMPTY)
  }
  return writeHandle(overlay.vfs, absolute, cell, append, () => overlay.observer?.write(cell))
}

// `cp -r` and `mkdir` make a directory here, each before what goes inside it.
// `false` says the path is not the overlay's to make. `mkdir` never follows a
// link in the final position: a name already there is `File exists` whatever
// it leads to, so only the way to it resolves.
function addDirectory(fs, overlay, cwd, path) {
  const absolute = writeTarget(fs, cwd, path, false)
  if (!inOverlay(absolute)) return false
  if (fs.isDir(absolute)) return true
  checkTarget(fs, cwd, path)
  // checkTarget passes a name already taken by a file or a link, which is not
  // a name a directory can take.
  if (fs.isFile(absolute) || fs.isLink(absolute)) throw new Error(`${path}: File exists`)
  overlay.change(path, () => overlay.vfs.mkdir(absolute))
  return true
}

// `ln -s` is what makes a link here. It is made at the name itself, never
// where a link already there leads, so only the way to the name resolves.
function addLink(fs, overlay, cwd, path, target) {
  const absolute = writeTarget(fs, cwd, path, false)
  if (!absolute.startsWith('/tmp/')) return false
  checkNewName(fs, cwd, path)
  overlay.change(path, () => overlay.vfs.symlink(target, absolute))
  return true
}

function copyFile(fs, overlay, cwd, source, target) {
  const absolute = writeTarget(fs, cwd, target)
  if (!absolute.startsWith('/tmp/')) return false
  checkTarget(fs, cwd, target)
  const cell = overlay.identity(source)
  if (source === absolute || cell !== undefined && cell === overlay.identity(absolute)) throw new Error('source and destination are the same file')
  overlay.observer?.read(cell ?? source)
  // A copy carries bytes, which either side may hold without a string
  // equivalent. Copy them directly while keeping truncation and writes
  // observable.
  fs.openWritable(cwd, target).writeBytes(overlay.base.readBytes(source))
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
  if (!fs.isFile(absolute) && !fs.isLink(absolute)) throw pathError(path, 'No such file or directory')
  if (backup !== null) checkTarget(fs, cwd, backupPath)
  const bytes = encodeUtf8(content)
  const { vfs } = overlay
  overlay.change(path, () => {
    // GNU renames the name aside for the backup and the new file over it, so
    // a link's backup is the link itself, and the name is a regular file
    // after. Renaming a replacement keeps already-open descriptors on the old
    // file, under whichever name it then has.
    if (backup !== null && backup !== absolute) {
      const moved = overlay.leaving(absolute)
      const replaced = overlay.leaving(backup)
      vfs.rename(absolute, backup)
      overlay.release(replaced)
      if (moved) moved.cell.path = backup
    } else {
      const left = overlay.leaving(absolute)
      vfs.unlink(absolute)
      overlay.release(left)
    }
    vfs.writeFile(absolute, bytes)
  })
  return true
}

function removeFile(fs, overlay, cwd, path) {
  const absolute = writeTarget(fs, cwd, path, false)
  if (!inOverlay(absolute)) return false
  // The name itself is what is unlinked: a link is taken away, not followed.
  const found = lookup(cwd, path, fs, { follow: false })
  if (found.error) throw pathError(path, found.error)
  if (fs.isDir(found.path)) throw new Error(`${path}: Is a directory`)
  if (!inOverlay(found.path)) return false
  // Open handles retain the unlinked file until their last writer ends.
  const left = overlay.leaving(found.path)
  overlay.change(path, () => overlay.vfs.unlink(found.path))
  overlay.release(left)
  return true
}

// Removing a directory is removing it alone: `rm -r` clears what is inside it
// first, so anything left here is a caller's mistake. `/tmp` is where the
// overlay is mounted rather than something inside it, and a mount point is not
// the tree below it to remove — which is the busy device Linux reports.
function dropDirectory(fs, overlay, cwd, path) {
  const absolute = writeTarget(fs, cwd, path, false)
  if (!inOverlay(absolute)) return false
  const found = lookup(cwd, path, fs)
  if (found.error) throw pathError(path, found.error)
  if (!inOverlay(found.path) || !fs.isDir(found.path)) throw new Error(`${path}: Not a directory`)
  if (found.path === '/tmp') throw new Error(`${path}: Device or resource busy`)
  const { dirs, files, links } = fs.listDir(found.path)
  if (dirs.length || files.length || links.length) throw new Error(`${path}: Directory not empty`)
  overlay.change(path, () => overlay.vfs.rmdir(found.path))
  return true
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

// What a name about to be made must be, as symlink(2) checks one: not there,
// under a directory that is, and — a trailing slash asking for a directory —
// not a name that could only be a file. A link already there is a name taken,
// wherever it leads, so the final component is never followed.
function checkNewName(fs, cwd, path) {
  if (path === '' || path.includes('\0')) throw pathError(path, 'No such file or directory')
  const found = walkPath(cwd, path, fs, { follow: false })
  if (found.error === null) throw pathError(path, 'File exists')
  if (found.rest.length > 0 || path.endsWith('/')) throw pathError(path, found.error)
  if (!fs.isDir(dirname(found.path))) throw pathError(path, 'Not a directory')
}

function pathError(path, fsError) {
  return Object.assign(new Error(`${path}: ${fsError}`), { path, fsError })
}

// A descriptor's writes: at its offset, or at the end for one opened to
// append. A write at the end is an append, which the tree does in amortized
// linear time, so commands writing one record at a time stay linear; one
// anywhere else rewrites the file with those bytes in place, since bytes the
// tree has handed out are never written into. A file past its last name is
// the cell's to grow the same way.
function writeHandle(vfs, path, cell, append, check) {
  let offset = 0
  const store = (bytes) => {
    const current = cellBytes(vfs, cell)
    const start = append ? current.length : offset
    if (cell.detached !== undefined) cell.detached = written(current, start, bytes)
    else if (start === current.length) vfs.appendFile(cell.path, bytes)
    else vfs.writeFile(cell.path, written(current, start, bytes))
    offset = start + bytes.length
  }
  return {
    path,
    identity: cell,
    get position() { return append ? cellBytes(vfs, cell).length : offset },
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

// `bytes` written into `current` at `start`: past its end into room a
// previous write left, and anywhere else into a copy, so what a reader was
// handed before is never changed under it. A gap before `start` is zeros.
function written(current, start, bytes) {
  const length = Math.max(current.length, start + bytes.length)
  const room = start === current.length && current.byteOffset + length <= current.buffer.byteLength
  const next = room ? new Uint8Array(current.buffer, current.byteOffset, length) : new Uint8Array(Math.max(length, current.length * 2)).subarray(0, length)
  if (!room) next.set(current)
  next.set(bytes, start)
  return next
}
