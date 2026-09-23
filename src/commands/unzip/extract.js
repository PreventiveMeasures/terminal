// An extraction, as UnZip 6.00 makes one into the writable overlay: into the
// current directory, or the `-d` one, which it makes if its parent is there;
// every missing parent made on the way; a directory already there kept; a
// name already taken replaced with `-o`, kept with `-n`, and asked about
// otherwise — on stdin, where this terminal has nothing to answer with, so
// the first question meets its end, and UnZip reads that as "None" for the
// rest. A link is made last, once everything else is written, as UnZip
// defers them: until then its name holds a placeholder, a file of its
// target, which is what a later entry of that name meets.
//
// The overlay is the one place a file can be written; a name anywhere else
// is the read-only filesystem, and a gap.

import { basename, dirname, lookup, resolve } from '../../fs.js'
import { encodeUtf8, readBytesOf } from '../../util.js'
import { inOverlay } from '../../writable.js'

// How UnZip names the file it is writing: under the `-d` directory as it was
// typed, one trailing slash dropped, or as the archive names it.
const shownUnder = (exdir, name) => (exdir === null ? name : `${exdir.endsWith('/') ? exdir.slice(0, -1) : exdir}/${name}`)

export function extractMembers(entries, opts, run) {
  const base = extractionDirectory(opts.exdir, run)
  if (base === null) return false
  const links = []
  const done = extractEntries(entries, base, links, opts, run)
  for (const link of links) finishLink(link, run)
  return done
}

function extractEntries(entries, base, links, opts, run) {
  const { ctx } = run
  for (const entry of entries) {
    const directory = entry.type === 'directory'
    if (opts.junk && directory) continue
    const name = opts.junk ? basename(entry.name) : entry.name
    const path = resolve(base, name)
    const shown = shownUnder(opts.exdir, directory ? `${name}/` : name)
    const parents = writable(path, ctx) ? makeParents(dirname(path), ctx) : 'read-only'
    if (parents === 'read-only') return readOnly(shown, run)
    if (parents !== null) {
      run.refuse('feature', 'name taken', `${shown}: extracting under a name that is not a directory is not supported`)
      return false
    }
    if (directory) {
      if (!makeDirectory(path, shown, run)) return false
      continue
    }
    // Each file an extraction writes is named "extracting" or "inflating" by
    // how it was stored, which the reader does not say — so an extraction
    // that names them goes no further than the first; a directory is
    // "creating" whatever it is.
    if (run.quiet === 0) {
      run.refuse('feature', 'extraction listing', 'whether each file was stored or deflated is not known here, and an extraction that is not quiet names it (-q extracts without it)')
      return false
    }
    const decision = conflict(path, shown, opts, run)
    if (decision === null) return false
    if (decision === 'skip') continue
    const handle = ctx.fs.openWritable('/', path)
    if (!handle) return readOnly(shown, run)
    const link = entry.type === 'symlink'
    handle.writeBytes(link ? encodeUtf8(entry.linkname) : entry.data)
    if (link) links.push({ path, shown, target: entry.linkname })
  }
  return true
}

// set_deferred_symlink: the placeholder, read through whatever stands at
// the name, has to hold the target and nothing else; otherwise UnZip warns,
// leaves what is there, and goes on.
function finishLink({ path, shown, target }, run) {
  const { fs } = run.ctx
  const found = lookup('/', path, fs)
  const held = found.path !== null && fs.isFile(found.path) ? readBytesOf(fs, found.path) : null
  const wanted = encodeUtf8(target)
  if (held === null || held.length !== wanted.length || held.some((byte, i) => byte !== wanted[i])) {
    run.say(2, `warning:  deferred symlink (${shown}) failed:\n          invalid placeholder file\n`)
    return
  }
  fs.removeWritable('/', path)
  fs.makeWritableLink('/', path, target)
}

const writable = (path, ctx) => ctx.writable && inOverlay(path)

function readOnly(shown, run) {
  run.refuse('feature', 'read-only target', `${shown}: Read-only file system`)
  return false
}

// UnZip makes the `-d` directory, and that one alone: a parent that is not
// there is its "checkdir" error, and the end of the run.
function extractionDirectory(exdir, run) {
  const { ctx } = run
  if (exdir === null) return ctx.cwd
  const path = resolve(ctx.cwd, exdir)
  const found = lookup('/', path, ctx.fs)
  if (found.path !== null && ctx.fs.isDir(found.path)) return found.path
  if (found.path !== null) {
    run.refuse('feature', 'extraction directory', `${exdir}: an extraction directory that is not a directory is not supported`)
    return null
  }
  const parent = lookup('/', dirname(path), ctx.fs)
  if (parent.error !== null) {
    run.say(2, `checkdir:  cannot create extraction directory: ${exdir}\n           ${parent.error}\n`)
    run.status = 2
    return null
  }
  if (!writable(path, ctx) || !ctx.fs.makeWritableDir('/', path)) {
    readOnly(exdir, run)
    return null
  }
  return path
}

// Every missing parent, made: null once they are there, 'read-only' where
// one falls outside the overlay, and what stopped the walk otherwise.
function makeParents(path, ctx) {
  const missing = []
  let at = path
  for (; lookup('/', at, ctx.fs).path === null; at = dirname(at)) {
    if (lookup('/', at, ctx.fs, { follow: false }).path !== null) return 'File exists'
    missing.push(at)
  }
  if (!ctx.fs.isDir(lookup('/', at, ctx.fs).path)) return 'Not a directory'
  for (const dir of missing.toReversed()) if (!inOverlay(dir) || !ctx.fs.makeWritableDir('/', dir)) return 'read-only'
  return null
}

// A directory is "creating" where UnZip is not quiet, and only where it was
// not there already.
function makeDirectory(path, shown, run) {
  const { fs } = run.ctx
  const found = lookup('/', path, fs, { follow: false })
  if (found.path === null) {
    if (!fs.makeWritableDir('/', path)) return readOnly(shown, run)
    if (run.quiet === 0) run.say(1, `   creating: ${shown}\n`)
    return true
  }
  if (fs.isDir(found.path)) return true
  run.refuse('feature', 'name taken', `${shown}: a directory entry over a file already there is not supported`)
  return false
}

// What becomes of a name already taken: 'write' over it, 'skip' it, or null
// where the run has ended. A quiet UnZip says nothing of a link standing
// there, whatever it goes on to do with it.
function conflict(path, shown, opts, run) {
  const { fs } = run.ctx
  const found = lookup('/', path, fs, { follow: false })
  if (found.path === null) return 'write'
  if (fs.isDir(found.path)) {
    run.refuse('feature', 'name taken', `${shown}: a file entry over a directory already there is not supported`)
    return null
  }
  if (opts.overwrite === null) ask(shown, opts, run)
  if (opts.overwrite === 'none') return 'skip'
  if (opts.overwrite === 'all') fs.removeWritable('/', path)
  return opts.overwrite === 'all' ? 'write' : null
}

// UnZip asks on stdin, and a stdin with nothing on it answers the first
// question with its end, which UnZip takes as "None" from then on. An
// answer typed there is one this terminal does not take.
function ask(shown, opts, run) {
  const { ctx } = run
  if (ctx.stdinLeft !== '' || ctx.stdinBytes !== null) {
    run.refuse('feature', 'overwrite prompt', 'answering the overwrite question from stdin is not supported (-o and -n answer it)')
    return
  }
  run.say(2, `replace ${shown}? [y]es, [n]o, [A]ll, [N]one, [r]ename:  NULL\n(EOF or read error, treating as "[N]one" ...)\n`)
  opts.overwrite = 'none'
  run.status = 1
}
