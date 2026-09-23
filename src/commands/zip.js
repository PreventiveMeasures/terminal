// zip, as Info-ZIP Zip 3.0 answers it, writing the archive with
// @preventive/archive's zip writer: each file deflated through the runtime's
// stream and kept deflated only where that made it smaller, as Info-ZIP
// keeps it. What it says of each entry — "stored 0%", "deflated 53%" — is
// what this archive holds, worked out with Info-ZIP's own rounding from the
// deflated size the same stream gives; the bytes are the runtime's deflate
// rather than Info-ZIP's, so a file can come out a few bytes apart from
// what Info-ZIP would have made of it.
//
// The entries are this tree as `ls -l` describes it: files `-rw-------`,
// directories `drwx------`, links `lrwxrwxrwx`, all dated to the moment the
// terminal was made. Names are stored as Info-ZIP stores them, a leading `/`
// or `./` taken off; one it would store with a `.` or `..` in it, or twice
// the slash, is one the package would not store as it stands, and is a gap,
// as is adding to an archive that is already there.

import { compress } from '@preventive/archive/compression.js'
import { ArchiveError, zip as writeZip } from '@preventive/archive/zip.js'
import { basename, compareNames, joinPath, lookup, resolve } from '../fs.js'
import { readBytesOf, stdoutIsTerminal } from '../util.js'
import { inOverlay } from '../writable.js'
import { UnsupportedError, markUnsupported } from '../unsupported.js'

const MODES = { file: 0o600, directory: 0o700, symlink: 0o777 }
const FLAGS = { __proto__: null, r: 'recurse', q: 'quiet', j: 'junk', 0: 'store', y: 'symlinks', D: 'noDirectories' }

// Info-ZIP takes its options wherever they stand; the first word that is
// not one names the archive, and the rest are what goes in it.
function parseZip(tokens) {
  const opts = { recurse: false, quiet: false, junk: false, store: false, symlinks: false, noDirectories: false, archive: null, names: [] }
  for (const word of tokens) {
    if (word.startsWith('--')) throw new UnsupportedError('option', word.split('=')[0], `unknown option: ${word.split('=')[0]}`)
    if (word.startsWith('-') && word.length > 1) {
      for (const letter of word.slice(1)) {
        if (!FLAGS[letter]) throw new UnsupportedError('option', `-${letter}`, `unknown option: -${letter}`)
        opts[FLAGS[letter]] = true
      }
    } else if (opts.archive === null) opts.archive = word
    else opts.names.push(word)
  }
  return opts
}

export async function zip(_stdin, tokens, ctx) {
  const opts = parseZip(tokens)
  // Without an archive to write, or with `-` for one, zip is a filter from
  // stdin to stdout, whose archive has to say its sizes after the data. With
  // nothing on the line at all it prints its help instead; given anything,
  // it will not write to a terminal, and says so on stderr, where a filter's
  // messages go.
  if (opts.archive === null || opts.archive === '-') {
    if (tokens.length > 0 && stdoutIsTerminal(ctx)) {
      return { stdout: '', stderr: '\nzip error: Invalid command arguments (cannot write zip file to terminal)\n', exitCode: 16 }
    }
    throw new UnsupportedError('feature', 'streamed archive', 'writing an archive to stdout is not supported')
  }
  const say = { events: [], status: 0 }
  const out = (text) => say.events.push({ fd: 1, text })
  // Info-ZIP puts `.zip` on a name that has no suffix of its own.
  const name = basename(opts.archive).includes('.') ? opts.archive : `${opts.archive}.zip`
  const target = lookup(ctx.cwd, name, ctx.fs, { follow: false })
  if (target.path !== null) return refuse(say, 'feature', 'existing archive', `${name}: adding to an archive that is already there is not supported`)
  const walk = { ctx, opts, entries: [], seen: new Set(), out, gap: null }
  for (const given of opts.names) {
    addOperand(given, walk)
    if (walk.gap) return refuse(say, ...walk.gap)
  }
  if (walk.entries.length === 0) {
    out(`\nzip error: Nothing to do! (${name})\n`)
    return finish(say, 12)
  }
  const repeated = repeats(walk)
  if (repeated) {
    out(repeated)
    return finish(say, 16)
  }
  const lines = await Promise.all(walk.entries.map((entry) => addingLine(entry, opts)))
  let archive
  try { archive = await writeZip(walk.entries, { method: opts.store ? 'store' : 'deflate' }) } catch (error) {
    if (!(error instanceof ArchiveError)) throw error
    return refuse(say, 'feature', 'archive', `this archive cannot be written here: ${error.message}`)
  }
  const path = resolve(ctx.cwd, name)
  const handle = ctx.writable && inOverlay(path) ? openArchive(ctx, name) : null
  if (handle === null) return refuse(say, 'feature', 'read-only target', `${name}: Read-only file system`)
  if (handle.error) {
    out(`zip I/O error: ${handle.error}\nzip error: Could not create output file (${name})\n`)
    return finish(say, 15)
  }
  if (!opts.quiet) for (const line of lines) out(line)
  handle.writeBytes(archive)
  return finish(say, 0)
}

function openArchive(ctx, name) {
  try { return ctx.fs.openWritable(ctx.cwd, name) } catch (error) {
    return { error: error.fsError ?? 'No such file or directory' }
  }
}

// What Info-ZIP says of an entry as it adds it: stored, or deflated by the
// share it saved, rounded as Info-ZIP's percent() rounds it.
async function addingLine(entry, opts) {
  const shown = entry.type === 'directory' ? `${entry.name}/` : entry.name
  if (opts.store || entry.type !== 'file' || entry.data.length === 0) return `  adding: ${shown} (stored 0%)\n`
  const packed = await compress(entry.data, 'deflate-raw')
  if (packed.length >= entry.data.length) return `  adding: ${shown} (stored 0%)\n`
  return `  adding: ${shown} (deflated ${percent(entry.data.length, packed.length)}%)\n`
}

function percent(n, m) {
  let [from, to] = [n, m]
  if (from > 0xffffff) {
    from = Math.floor((from + 0x80) / 256)
    to = Math.floor((to + 0x80) / 256)
  }
  return from > to ? Math.floor((1 + Math.floor((200 * (from - to)) / from)) / 2) : 0
}

// The name Info-ZIP stores: its leading slashes taken off, and then any
// `./` in front — and no more, so `.//src` is stored as `/src`. What is
// left of `.` is the directory the names are under, which is no entry of
// its own. -j keeps no directory at all.
function storedName(given, opts) {
  if (opts.junk) return basename(given)
  let name = given.replace(/^\/+/u, '')
  while (name.startsWith('./')) name = name.slice(2)
  return name === '.' ? '' : name
}

function addOperand(given, walk) {
  const { ctx, opts } = walk
  const found = lookup(ctx.cwd, given, ctx.fs, { follow: !opts.symlinks })
  if (found.error) {
    walk.out(`\tzip warning: name not matched: ${given}\n`)
    return
  }
  const spelled = given.length > 1 ? given.replace(/\/+$/u, '') : given
  const name = storedName(spelled, opts)
  // The name it was found by, which Info-ZIP tells repeats apart by: the
  // operand as typed, or nothing for the directory `.` names.
  addPath(found.path, name, !opts.junk && name === '' ? '' : spelled, walk)
}

// One entry, and with -r everything under a directory, in the order this
// tree lists them. A link is followed unless -y keeps it a link; a
// directory reached twice through links is a loop Info-ZIP would walk.
function addPath(path, name, full, walk) {
  const { ctx, opts } = walk
  const { fs } = ctx
  const link = opts.symlinks && fs.isLink?.(path) === true
  const dir = !link && fs.isDir(path)
  if (dir && fs.isFile(path)) return fail(walk, 'ambiguous file type', `${name}: a path that is both a file and a directory cannot be zipped`)
  if (name !== '' && name.split('/').some((part) => part === '.' || part === '..' || part === '')) {
    return fail(walk, 'dot-segment names', `${name}: names with \`.', \`..' or empty segments are not supported`)
  }
  const type = link ? 'symlink' : dir ? 'directory' : 'file'
  if (name !== '' && (!dir || !(opts.junk || opts.noDirectories))) {
    walk.entries.push({
      name, full: dir ? `${full}/` : full, type, mode: MODES[type], mtime: Math.floor(ctx.createdAt / 1000),
      linkname: link ? fs.readLink(path) : '', data: type === 'file' ? readBytesOf(fs, path) : undefined,
    })
  }
  if (!dir || !opts.recurse) return
  // Only a directory inside itself is a loop; one reached again by
  // another way is walked again, as Info-ZIP walks it.
  if (walk.seen.has(path)) return fail(walk, 'link loop', `${name}: a directory inside itself through a link is not supported`)
  walk.seen.add(path)
  const { dirs, files, links = [] } = fs.listDir(path)
  for (const child of [...new Set([...dirs, ...files, ...links])].sort(compareNames)) {
    const childPath = joinPath(path, child)
    const found = lookup('/', childPath, fs, { follow: !opts.symlinks })
    if (found.error) walk.out(`\tzip warning: name not matched: ${name}/${child}\n`)
    else addPath(found.path, opts.junk || name === '' ? child : `${name}/${child}`, full === '' ? child : `${full}/${child}`, walk)
    if (walk.gap) break
  }
  walk.seen.delete(path)
}

// Info-ZIP sorts what it found by the name each goes in under, and by the
// name it was found by: the same file named the same way twice goes in
// once, and two names that would go in under one are refused, the first
// such pair named as they sort.
function repeats(walk) {
  const sorted = walk.entries.toSorted((a, b) => compareNames(a.name, b.name) || compareNames(a.full, b.full))
  const kept = []
  for (const entry of sorted) {
    const last = kept.at(-1)
    if (last?.name !== entry.name) kept.push(entry)
    else if (last.full !== entry.full) {
      const shown = entry.type === 'directory' ? `${entry.name}/` : entry.name
      const junk = walk.opts.junk ? '                     this may be a result of using -j\n' : ''
      return `\tzip warning:   first full name: ${last.full}\n                      second full name: ${entry.full}\n                     name in zip file repeated: ${shown}\n${junk}\nzip error: Invalid command arguments (cannot repeat names in zip file)\n`
    }
  }
  const once = new Set(kept)
  walk.entries = walk.entries.filter((entry) => once.has(entry))
  return null
}

function fail(walk, detail, message) {
  walk.gap ??= ['feature', detail, message]
}

function refuse(say, kind, detail, message) {
  say.events.push({ fd: 2, text: `zip: ${message}\n` })
  return markUnsupported(finish(say, 1), kind, 'zip', detail, `zip: ${message}`)
}

function finish(say, status) {
  const text = (fd) => say.events.filter((event) => event.fd === fd).map((event) => event.text).join('')
  return { stdout: text(1), stderr: text(2), exitCode: status, events: say.events }
}
