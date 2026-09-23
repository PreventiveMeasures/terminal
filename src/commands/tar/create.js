// An archive made the way GNU tar 1.35 makes one, written by
// @preventive/archive's tar writer, which puts down byte for byte what GNU
// does for the same entries.
//
// The entries are this tree as `ls -l` describes it: every file `-rw-------`,
// every directory `drwx------`, every link `lrwxrwxrwx`, all of them dated to
// the moment the terminal was made. An archive also records who owns each
// entry, as a number, and this terminal has no numbers for its user — `$UID`
// is refused for the same reason — so the owner and group have to be given:
// `--owner=NAME:UID --group=NAME:GID`, or the ids with `--numeric-owner`,
// which records no names. Without them the archive is refused rather than
// written with numbers made up.
//
// Names are stored as GNU stores them: the operand as it was typed, with
// what would climb out of the archive taken off the front — a leading `/`,
// and everything up to the last `..` — and a warning, once, for each prefix
// so removed. A name GNU would store with a `.` segment in it (anything
// under `.`, say) is one the package would store without, so it is refused
// rather than written as a different archive; so is anything else the
// package will not write.

import { compress, supports } from '@preventive/archive/compression.js'
import { ArchiveError, pack } from '@preventive/archive/tar.js'
import { compareNames, dirname, joinPath, lookup, resolve } from '../../fs.js'
import { readBytesOf } from '../../util.js'
import { inOverlay } from '../../writable.js'
import { longLines } from './list.js'
import { enterDirectory, memberOperand, quoteColon, quoteLocale } from './names.js'
import { refuseCompression, remoteArchive, suffixCompression } from './read.js'

const BLOCK = 512
// The one model of this tree's metadata, which `ls -l` prints (ls-long.js).
const MODES = { file: 0o600, directory: 0o700, symlink: 0o777 }

export async function createArchive(opts, state) {
  const { ctx } = state
  // GNU's pax headers carry each file's access and change times, which this
  // tree does not have; the package writes them without.
  if (opts.format === 'pax') return state.refuse('option', '--format=pax', 'the pax format records access and change times, which this tree does not have')
  const owners = ownersOf(opts, state)
  const gzip = owners && compressionFor(opts, state)
  if (gzip === null || !owners) return
  if (gzip && !supports('gzip')) return state.refuse('option', '-z', 'this runtime has no gzip stream')
  const target = openTarget(opts.archive, state)
  if (!target) return
  if (target.kind === 'stdout') state.listTo = 2
  const walk = {
    state, owners, target, entries: [], verbose: opts.verbose, many: opts.items.filter((item) => item.name !== undefined).length > 1,
    mtime: Math.floor(ctx.createdAt / 1000), members: new Set(), links: new Set(), line: opts.verbose > 1 ? longLines(ctx, opts) : null,
  }
  let dir = ctx.cwd
  let pending = []
  for (const item of opts.items) {
    if (item.dir !== undefined) { pending.push(item.dir); continue }
    for (const step of pending) {
      dir = enterDirectory(dir, step, state)
      if (dir === null) return finish(walk, opts, gzip, true)
    }
    pending = []
    addOperand(item.name, dir, walk)
    if (state.stopped) return
  }
  if (pending.length) {
    state.warn('The following options were used after non-option arguments.  These options are positional and affect only arguments that follow them.  Please, rearrange them properly.')
    for (const step of pending) state.error(`-C ${quoteLocale(step, ctx)} has no effect`)
  }
  await finish(walk, opts, gzip, false)
}

function ownersOf(opts, state) {
  const { owner, group, numericOwner } = opts
  const known = (spec) => spec !== undefined && spec.id !== null && (spec.name !== null || numericOwner)
  if (!known(owner) || !known(group)) {
    state.refuse('feature', 'file owners', 'the files here have no numeric owner or group to record; give them with --owner=NAME:UID and --group=NAME:GID, or as ids with --numeric-owner')
    return null
  }
  return { uid: owner.id, gid: group.id, uname: numericOwner ? '' : owner.name, gname: numericOwner ? '' : group.name }
}

// -z, or -a and a name GNU knows a compressor by; gzip is the one this
// terminal has a stream for.
function compressionFor(opts, state) {
  if (opts.gzip) return true
  const suffix = opts.auto && opts.archive !== '-' ? suffixCompression(opts.archive) : undefined
  if (suffix === undefined) return false
  return suffix === '-z' ? true : refuseCompression(state, suffix)
}

// GNU opens the archive before it reads a single file, truncating what was
// there — so it is there, empty, while the files are walked.
function openTarget(name, state) {
  const { ctx } = state
  if (name === '-') return { kind: 'stdout' }
  if (name === '/dev/null') return { kind: 'null' }
  if (remoteArchive(name)) return state.refuse('feature', 'remote archive', `${name}: remote archives are not supported`)
  if (name.startsWith('/dev/')) return state.refuse('feature', 'special file', `${name}: writing an archive to a device is not supported`)
  const shown = quoteColon(name, ctx)
  const path = resolve(ctx.cwd, name)
  const found = lookup(ctx.cwd, name, ctx.fs)
  if (found.path !== null && ctx.fs.isDir(found.path)) return state.fatal(`${shown}: Cannot open: Is a directory`)
  const parent = lookup(ctx.cwd, dirname(path), ctx.fs)
  if (found.path === null && (parent.error || !ctx.fs.isDir(parent.path))) return state.fatal(`${shown}: Cannot open: ${parent.error ?? 'Not a directory'}`)
  const handle = ctx.writable && inOverlay(found.path ?? path) ? ctx.fs.openWritable(ctx.cwd, name) : null
  if (!handle) return state.refuse('feature', 'read-only target', `${shown}: Cannot open: Read-only file system`)
  return { kind: 'file', handle, path: handle.path }
}

// safer_name_suffix: the prefix a name loses, and the name it keeps — which
// GNU works out, and warns of, before it looks for the file at all.
function memberName(orig, walk) {
  let cut = 0
  for (let at = 0; at < orig.length;) {
    if (orig.startsWith('..', at) && (at + 2 === orig.length || orig[at + 2] === '/')) cut = at + 2
    const slash = orig.indexOf('/', at)
    at = slash === -1 ? orig.length : slash + 1
  }
  while (orig[cut] === '/') cut++
  const prefix = orig.slice(0, cut)
  if (orig === '') walk.state.warn("Substituting `.' for empty member name")
  else if (prefix !== '' && !walk.members.has(prefix)) {
    walk.members.add(prefix)
    walk.state.warn(`Removing leading \`${prefix}' from member names`)
  }
  return { prefix, name: cut === orig.length ? '.' : orig.slice(cut) }
}

function addOperand(given, dir, walk) {
  const { ctx } = walk.state
  const base = memberOperand(given)
  if (base === '/dev' || base.startsWith('/dev/')) {
    walk.state.refuse('feature', 'special file', `${quoteColon(base, ctx)}: archiving special files is not supported`)
    return
  }
  const safe = memberName(base, walk)
  const found = lookup(dir, base, ctx.fs, { follow: false })
  if (found.error) walk.state.error(`${quoteColon(base, ctx)}: Cannot stat: ${found.error}`)
  else addPath(found.path, base, safe, walk)
}

// One entry, and for a directory everything under it, in the order this
// tree lists them — by name, which is GNU's `--sort=name`.
function addPath(path, orig, safe, walk) {
  const { state } = walk
  const { fs } = state.ctx
  const dir = fs.isDir(path)
  const link = !dir && fs.isLink?.(path) === true
  if (dir && fs.isFile(path)) return state.refuse('feature', 'ambiguous file type', `${quoteColon(orig, state.ctx)}: a path that is both a file and a directory cannot be archived`)
  if (walk.target.kind === 'file' && walk.target.path === path) return state.warn(`${quoteColon(orig, state.ctx)}: archive cannot contain itself; not dumped`)
  if (safe.name !== '.' && safe.name.split('/').some((part) => part === '.' || part === '')) {
    return state.refuse('feature', 'dot-segment names', `${quoteColon(orig, state.ctx)}: member names with \`.' or empty segments are not supported`)
  }
  const type = dir ? 'directory' : link ? 'symlink' : 'file'
  const entry = {
    name: safe.name, type, mode: MODES[type], mtime: walk.mtime, ...walk.owners,
    linkname: link ? fs.readLink(path) : '', data: type === 'file' ? readBytesOf(fs, path) : undefined,
  }
  walk.entries.push(entry)
  if (walk.verbose) state.list(walk.line ? walk.line({ ...entry, name: orig, data: entry.data ?? new Uint8Array() }) : dir ? `${orig}/` : orig)
  // Where there are several operands, GNU counts the links of everything
  // but a directory, and warns of the same prefix for hard link targets.
  if (walk.many && !dir && safe.prefix !== '' && !walk.links.has(safe.prefix)) {
    walk.links.add(safe.prefix)
    state.warn(`Removing leading \`${safe.prefix}' from hard link targets`)
  }
  if (!dir) return
  const { dirs, files, links = [] } = fs.listDir(path)
  for (const name of [...new Set([...dirs, ...files, ...links])].sort(compareNames)) {
    const child = orig === '/' ? `/${name}` : `${orig}/${name}`
    addPath(joinPath(path, name), child, memberName(child, walk), walk)
    if (state.stopped) return
  }
}

// The archive, through gzip where asked, written where it was opened. A run
// that ended in a fatal error leaves what GNU had written by then: the
// whole records its entries filled, and no end to them.
async function finish(walk, opts, gzip, fatal) {
  const { state, target } = walk
  let archive
  try { archive = pack(walk.entries, { format: opts.format, blocking: fatal ? 1 : opts.blocking }) } catch (error) {
    if (!(error instanceof ArchiveError)) throw error
    return state.refuse('feature', 'archive', `this archive cannot be written here: ${error.message}`)
  }
  if (fatal) {
    const record = opts.blocking * BLOCK
    archive = archive.subarray(0, Math.floor((archive.length - 2 * BLOCK) / record) * record)
  }
  if (gzip) archive = await compress(archive, 'gzip')
  if (target.kind === 'stdout') state.bytes(archive)
  else if (target.kind === 'file') target.handle.writeBytes(archive)
}
