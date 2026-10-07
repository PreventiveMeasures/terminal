import { VfsError } from '@preventive/vfs'
import { checkNewName, checkTarget, dirname, lookup, pathError, sameBytes, slashedTarget, walkFiles, writeTarget } from './fs.js'
import { cellBytes, writeHandle } from './descriptor.js'
import { decodeUtf8, encodeUtf8 } from './util.js'
import { UnsupportedError } from './unsupported.js'

// The overlay is mounted at /tmp, so what may be written is what falls inside
// it. Commands ask before acting, where the answer decides more than whether a
// write would succeed.
export const inOverlay = (absolute) => absolute === '/tmp' || absolute.startsWith('/tmp/')

// What a write outside the overlay meets, asked of the directory a name is
// made in or taken from, or of the entry whose times would change. The tree
// the sources are in is a read-only mount; `/` and any directory on the way
// down to the mount are the root filesystem's, which is writable, but by root
// and not by the session's user, as `/` is on any Linux system.
export function writeRefusal(ctx, absolute) {
  const { mount = '/' } = ctx
  const mounted = mount === '/' || absolute === mount || absolute.startsWith(mount + '/')
  return mounted ? 'Read-only file system' : 'Permission denied'
}

const EMPTY = new Uint8Array()

// The session's umask, 077: the one that makes every file it creates
// `-rw-------` and every directory `drwx------`, the modes this tree's model
// gives everything (ls-long.js). A tool that carries a mode over — an
// archive's entry extracted, a file copied — takes it off that mode as GNU
// tar and cp do, and a directory one of them makes on the way to a name has
// what it leaves of 0777. One umask, so a name made here reads the same
// whichever command made it.
export const UMASK = 0o077
export const MADE_MODE = 0o777 & ~UMASK

// What a mode an entry keeps denies its owner, who is the one user here:
// reading a file without its read bit, writing one without its write bit,
// making or taking away a name in a directory without its write and search
// bits, listing a directory without its read bit, and looking up any name in
// one — on the way to anything under it — without its search bit. GNU is
// told "Permission denied" there, which each command says in words of its
// own, so such an access is refused rather than made.
const NAMES = 0o300, READ = 0o400, SEARCH = 0o100, WRITE = 0o200
const refusal = (path, doing) => new UnsupportedError('feature', 'permission denied', `${path}: ${doing} where its mode denies it is not supported (GNU says Permission denied)`)
function permitted(overlay, path, bits, doing) {
  const mode = overlay.metadataOf(path)?.mode
  if (mode === undefined || (mode & bits) === bits) return
  throw refusal(path, doing)
}
const naming = (overlay, path) => permitted(overlay, dirname(path), NAMES, 'changing the names in a directory')

// Every directory above a name is searched to reach it, the outermost first,
// which is the one the kernel stops at. Only a directory that keeps a mode
// can deny it, and until one keeps a mode denying search or reading, as an
// archive's entry may, nothing is asked of any.
function reach(overlay, path) {
  if (overlay.closed.size === 0 || !inOverlay(path)) return
  const above = []
  for (let dir = dirname(path); inOverlay(dir); dir = dirname(dir)) above.push(dir)
  for (let i = above.length - 1; i >= 0; i--) {
    const denied = overlay.searchRefusal(above[i])
    if (denied !== null) throw denied
  }
}

// A directory is listed by reading it, once it is reached.
function listable(overlay, path) {
  reach(overlay, path)
  if (overlay.closed.size === 0 || !inOverlay(path)) return
  const mode = overlay.closed.get(overlay.inodeOf(path))
  if (mode !== undefined && (mode & READ) === 0) throw refusal(path, 'listing a directory')
}

// Writes land in the tree the sources are in, and only under /tmp: every
// method here answers `false` or `null` for a name outside it, which is the
// read-only filesystem every other write meets.
export function writableFs(base) {
  base.vfs.mkdir('/tmp', { recursive: true })
  base.writableAt('/tmp')
  const overlay = overlayOf(base)
  const observe = (path) => {
    reach(overlay, path)
    permitted(overlay, path, READ, 'reading a file')
    overlay.observer?.read(overlay.identity(path) ?? path)
  }
  // What stat(2) or readlink(2) answers of a name, once it is reached.
  const reached = (answer) => (path) => {
    reach(overlay, path)
    return answer(path)
  }
  const fs = {
    ...base,
    observeIo: (value) => { overlay.observer = value },
    // The newest inode any name here was given, which a later one is newer
    // than: what tells a walk an entry was made after it began.
    newestInode: () => overlay.newest,
    fileIdentity: overlay.identity,
    // The text a file holds — or, for one read as the bytes it is, those same
    // bytes back while it still holds them, and what it holds once it does not.
    readIdentity: (cell, held) => {
      overlay.observer?.read(cell)
      const bytes = cellBytes(base.vfs, cell)
      if (held === undefined) return decodeUtf8(bytes)
      return sameBytes(bytes, held) ? held : bytes
    },
    readFile: (path) => { observe(path); return base.readFile(path) },
    readBytes: (path) => { observe(path); return base.readBytes(path) },
    exactBytes: (path) => { observe(path); return base.exactBytes(path) },
    sameFileContents: (a, b) => { reach(overlay, a); reach(overlay, b); return base.sameFileContents(a, b) },
    ...Object.fromEntries(['readLink', 'fileSize', 'isEmptyFile', 'linkCount'].map((name) => [name, reached(base[name])])),
    listDir: (path) => { listable(overlay, path); return base.listDir(path) },
    walkFiles: (root) => walkFiles(fs, root),
    // What a walk asks of each directory it looks a name up in: nothing,
    // where no directory keeps a mode denying search, and otherwise why one
    // is refused, if it is — `doing` says what searching it is for.
    searchGuard: () => (overlay.closed.size === 0 ? null : overlay.searchRefusal),
    openWritable: (cwd, path, append = false) => openFile(fs, overlay, cwd, path, append),
    makeWritableDir: (cwd, path) => addDirectory(fs, overlay, cwd, path),
    makeWritableLink: (cwd, path, target) => addLink(fs, overlay, cwd, path, target),
    removeWritableDir: (cwd, path) => dropDirectory(fs, overlay, cwd, path),
    copyWritable: (cwd, source, target) => copyFile(fs, overlay, cwd, source, target),
    replaceWritable: (cwd, path, content, backup) => replaceFile(fs, overlay, cwd, path, content, backup),
    removeWritable: (cwd, path) => removeFile(fs, overlay, cwd, path),
    // What an entry keeps of its own — a mode, a modification time, or both —
    // where something gave it them, and null where it has the ones every
    // entry here has (ls-long.js). A path is absolute, and a link is itself
    // rather than what it leads to.
    keepMetadata: (path, kept) => overlay.keep(path, kept),
    metadataOf: reached(overlay.metadataOf),
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
  // What entries keep of their own, by inode, which no name change moves.
  // Writing to a file dates it to now, as making or taking away a name in a
  // directory dates the directory, and now is the moment every entry here is
  // dated to: a time kept is dropped where either happens, and a mode stays.
  const kept = new Map()
  // The directories among them whose mode denies search or reading, by
  // inode as well: what every access to a name under one asks about.
  const closed = new Map()
  const dated = (ino) => {
    const own = kept.get(ino)
    if (own?.mtime === undefined) return
    if (own.mode === undefined) kept.delete(ino)
    else kept.set(ino, { mode: own.mode })
  }
  const inodeOf = (path) => {
    try { return vfs.lstat(path).ino } catch (e) {
      if (e instanceof VfsError) return
      throw e
    }
  }
  const overlay = {
    base,
    vfs,
    closed,
    inodeOf,
    observer: undefined,
    // Every name the sources declared was made before /tmp was.
    newest: vfs.lstat('/tmp').ino,
    identity: (path) => {
      if (!inOverlay(String(path)) || !base.isFile(path)) return
      const { ino } = vfs.lstat(path)
      let cell = cells.get(ino)
      if (cell === undefined) cells.set(ino, cell = { path: vfs.realpath(path), detached: undefined, ino })
      return cell
    },
    keep: (path, { mode, mtime }) => {
      const { ino, type } = vfs.lstat(path)
      const own = { ...kept.get(ino) }
      if (mode !== undefined) own.mode = mode
      if (mtime !== undefined) own.mtime = mtime
      kept.set(ino, own)
      if (mode === undefined || type !== 'directory') return
      if ((mode & (READ | SEARCH)) === (READ | SEARCH)) closed.delete(ino)
      else closed.set(ino, mode)
    },
    metadataOf: (path) => (inOverlay(path) ? kept.get(inodeOf(path)) ?? null : null),
    // Why looking a name up in `dir` is refused, or null where it is not.
    searchRefusal: (dir, doing = 'looking up a name in a directory') => {
      const mode = inOverlay(dir) ? closed.get(inodeOf(dir)) : undefined
      return mode === undefined || (mode & SEARCH) !== 0 ? null : refusal(dir, doing)
    },
    written: dated,
    // A name made or taken away at `path`, which is absolute and resolved.
    named: (path) => dated(inodeOf(dirname(path))),
    forget: (path) => {
      const ino = inodeOf(path)
      kept.delete(ino)
      closed.delete(ino)
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
    // A change to the tree's shape, said as the name that asked for it, at
    // the absolute names it makes or takes away.
    change: (path, apply, ...changed) => {
      try { return apply() } catch (e) {
        if (!(e instanceof VfsError)) throw e
        throw pathError(path, strerror(e.code))
      } finally {
        overlay.newest = Math.max(overlay.newest, base.reshaped(...changed) ?? 0)
      }
    },
  }
  return overlay
}

// What the Vfs says of a code, without the path its messages put in front.
const strerror = (code) => new VfsError(code, '').message.slice(2)

function openFile(fs, overlay, cwd, path, append) {
  const absolute = writeTarget(fs, cwd, path)
  if (!inOverlay(absolute)) return null
  // A link whose target asks for a directory is opened as that spelling is.
  const slashed = slashedTarget(cwd, path, fs)
  if (slashed !== null) throw pathError(path, slashed)
  checkTarget(fs, cwd, path)
  let cell = overlay.identity(absolute)
  if (cell === undefined) naming(overlay, absolute)
  else permitted(overlay, absolute, WRITE, 'writing a file')
  if (cell === undefined) {
    overlay.change(path, () => overlay.vfs.writeFile(absolute, EMPTY), absolute)
    overlay.named(absolute)
    cell = overlay.identity(absolute)
  } else if (!append) {
    overlay.observer?.write(cell)
    overlay.vfs.writeFile(absolute, EMPTY)
    overlay.written(cell.ino)
  }
  return writeHandle(overlay.vfs, absolute, cell, append, () => {
    overlay.observer?.write(cell)
    overlay.written(cell.ino)
  })
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
  naming(overlay, absolute)
  overlay.change(path, () => overlay.vfs.mkdir(absolute), absolute)
  overlay.named(absolute)
  return true
}

// `ln -s` is what makes a link here. It is made at the name itself, never
// where a link already there leads, so only the way to the name resolves.
function addLink(fs, overlay, cwd, path, target) {
  const absolute = writeTarget(fs, cwd, path, false)
  if (!absolute.startsWith('/tmp/')) return false
  checkNewName(fs, cwd, path)
  naming(overlay, absolute)
  overlay.change(path, () => overlay.vfs.symlink(target, absolute), absolute)
  overlay.named(absolute)
  return true
}

function copyFile(fs, overlay, cwd, source, target) {
  const absolute = writeTarget(fs, cwd, target)
  if (!absolute.startsWith('/tmp/')) return false
  checkTarget(fs, cwd, target)
  const cell = overlay.identity(source)
  if (source === absolute || cell !== undefined && cell === overlay.identity(absolute)) throw new Error('source and destination are the same file')
  permitted(overlay, source, READ, 'reading a file')
  overlay.observer?.read(cell ?? source)
  const made = overlay.identity(absolute) === undefined
  // A copy carries bytes, which either side may hold without a string
  // equivalent. Copy them directly while keeping truncation and writes
  // observable.
  fs.openWritable(cwd, target).writeBytes(overlay.base.readBytes(source))
  // A file made by the copy takes the mode of the one it copies, less the
  // set-id and sticky bits and what the umask takes, as GNU cp makes one;
  // a file already there keeps its own.
  const mode = made ? overlay.metadataOf(source)?.mode : undefined
  if (mode !== undefined) overlay.keep(absolute, { mode: mode & 0o777 & ~UMASK })
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
  naming(overlay, absolute)
  if (backup !== null) naming(overlay, backup)
  const bytes = encodeUtf8(content)
  const { vfs } = overlay
  // The file written in its place takes its mode, as GNU gives it.
  const mode = overlay.metadataOf(absolute)?.mode
  overlay.change(path, () => {
    // GNU renames the name aside for the backup and the new file over it, so
    // a link's backup is the link itself, and the name is a regular file
    // after. Renaming a replacement keeps already-open descriptors on the old
    // file, under whichever name it then has.
    if (backup !== null && backup !== absolute) {
      const moved = overlay.leaving(absolute)
      const replaced = overlay.leaving(backup)
      overlay.forget(backup)
      vfs.rename(absolute, backup)
      overlay.release(replaced)
      if (moved) moved.cell.path = backup
    } else {
      const left = overlay.leaving(absolute)
      overlay.forget(absolute)
      vfs.unlink(absolute)
      overlay.release(left)
    }
    vfs.writeFile(absolute, bytes)
  }, absolute, ...backup === null ? [] : [backup])
  if (mode !== undefined) overlay.keep(absolute, { mode })
  overlay.named(absolute)
  if (backup !== null) overlay.named(backup)
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
  naming(overlay, found.path)
  // Open handles retain the unlinked file until their last writer ends.
  const left = overlay.leaving(found.path)
  overlay.forget(found.path)
  overlay.change(path, () => overlay.vfs.unlink(found.path), found.path)
  overlay.release(left)
  overlay.named(found.path)
  return true
}

// Removing a directory is removing it alone: `rm -r` clears what is inside it
// first, so anything left here is a caller's mistake. `/tmp` is where the
// overlay is mounted rather than something inside it, and the directory it is
// in is `/`, which the session's user cannot write: Linux refuses that before
// it would get as far as the mount point.
function dropDirectory(fs, overlay, cwd, path) {
  const absolute = writeTarget(fs, cwd, path, false)
  if (!inOverlay(absolute)) return false
  const found = lookup(cwd, path, fs)
  if (found.error) throw pathError(path, found.error)
  if (!inOverlay(found.path) || !fs.isDir(found.path)) throw new Error(`${path}: Not a directory`)
  if (found.path === '/tmp') throw pathError(path, 'Permission denied')
  // Whether it is empty is rmdir(2)'s to find, which reads nothing of it.
  const { dirs, files, links } = overlay.base.listDir(found.path)
  if (dirs.length || files.length || links.length) throw new Error(`${path}: Directory not empty`)
  naming(overlay, found.path)
  overlay.forget(found.path)
  overlay.change(path, () => overlay.vfs.rmdir(found.path), found.path)
  overlay.named(found.path)
  return true
}
