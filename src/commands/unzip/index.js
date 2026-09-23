// unzip, as Info-ZIP UnZip 6.00 answers it (Debian's build, which dates its
// listings year first), over @preventive/archive's zip reader, which reads
// the whole archive and checks every header, size and checksum in it before
// anything is done with it. Every message here was recorded from UnZip over
// the same archives.
//
// What the reader hands back is each entry's name, type, data and time,
// which answers `-l`, `-t` and `-p` and a quiet extraction in full. Two
// things it does not say are how an entry was stored and whether its time
// is an exact one: a listing prints an exact time in local time and a DOS
// time as it stands, and an extraction that is not quiet names each file
// "extracting" or "inflating" by how it was stored. So `-l` answers where
// the two readings of every time agree, which they always do under TZ=UTC;
// an extraction that is not quiet goes as far as the first file it would
// have to name, and `-c` and `-v`, which name how each entry is stored, are
// gaps.

import { ArchiveError, unzip as readZip } from '@preventive/archive/zip.js'
import { lookupWithNote } from '../../notes.js'
import { encodeUtf8, readBytesOf } from '../../util.js'
import { markUnsupported } from '../../unsupported.js'
import { formatDate } from '../extra.js'
import { refusalOf, storedName, zipRewritten } from '../stored-names.js'
import { extractMembers } from './extract.js'
import { matches, parseUnzip } from './options.js'

const NO_DIRECTORY = [
  '  End-of-central-directory signature not found.  Either this file is not',
  '  a zipfile, or it constitutes one disk of a multi-part archive.  In the',
  '  latter case the central directory and zipfile comment will be found on',
  '  the last disk(s) of this archive.',
].join('\n') + '\n'

export async function unzip(_stdin, tokens, ctx) {
  const opts = parseUnzip(tokens)
  if (opts.usage) return { stdout: '', stderr: opts.usage.text, exitCode: opts.usage.status }
  // -t says everything on stdout, errors and all; -p keeps stdout for the
  // members, and is as quiet as -q.
  const run = unzipRun(ctx, opts)
  // A place to extract to means nothing to a run that extracts nothing.
  if (opts.exdir !== null && opts.mode !== 'extract') run.say(2, 'caution:  not extracting; -d ignored\n')
  if (opts.mode === 'crt' || opts.mode === 'verbose') {
    return run.refuse('option', opts.mode === 'crt' ? '-c' : '-v', 'how each entry is stored is not known here, which this listing prints')
  }
  const found = findArchive(opts.archive, ctx)
  if (!found) {
    run.say(2, `unzip:  cannot find or open ${opts.archive}, ${opts.archive}.zip or ${opts.archive}.ZIP.\n`)
    return run.end(9)
  }
  const bytes = readBytesOf(ctx.fs, found.path)
  let entries
  try { entries = await readZip(bytes) } catch (error) {
    if (!(error instanceof ArchiveError)) throw error
    if (hasEndRecord(bytes)) return run.refuse('feature', 'archive', `this archive is not one this terminal reads: ${error.message}`)
    run.heading(found.name, true)
    run.say(2, NO_DIRECTORY)
    if (opts.mode !== 'pipe') run.say(2, `unzip:  cannot find zipfile directory in one of ${opts.archive} or\n        ${opts.archive}.zip, and cannot find ${opts.archive}.ZIP, period.\n`)
    return run.end(9)
  }
  // Where the package hands a name out otherwise than the archive stores it,
  // the name is not one to print or match (see ../stored-names.js).
  const stored = zipRewritten(bytes, entries)
  if (stored !== null) {
    const [detail, message] = refusalOf(stored)
    return run.refuse('feature', detail, `${stored}: ${message}`)
  }
  if (entries.length === 0) {
    run.heading(found.name, false)
    run.say(2, `warning [${found.name}]:  zipfile is empty\n`)
    return run.end(1)
  }
  const chosen = choose(entries, opts)
  if (opts.mode === 'list') return list(chosen, found.name, run)
  run.heading(found.name, false)
  if (opts.mode === 'test') test(chosen, found.name, run)
  else if (opts.mode === 'pipe') for (const entry of chosen.entries) run.bytes(entry.type === 'symlink' ? encodeUtf8(entry.linkname) : entry.data)
  else if (!extractMembers(chosen.entries, opts, run)) return run.end(run.gap ? 1 : run.status)
  cautions(chosen, run)
  if (opts.mode === 'test') summary(chosen, found.name, run)
  return run.end(chosen.missed ? 11 : run.status)
}

// The archive by the name given, or with `.zip` or `.ZIP` put after it.
function findArchive(name, ctx) {
  for (const candidate of [name, `${name}.zip`, `${name}.ZIP`]) {
    const found = candidate === name ? lookupWithNote(ctx, 'unzip', candidate) : lookupWithNote({ ...ctx, notes: null }, 'unzip', candidate)
    if (!found.error && !ctx.fs.isDir(found.path)) return { name: candidate, path: found.path }
  }
  return null
}

// Whether the end record's signature is anywhere UnZip looks for it: the
// last 22 bytes and the longest comment before them. Where it is not, UnZip
// says so in words of its own; where it is, what went wrong is past saying.
function hasEndRecord(bytes) {
  for (let at = bytes.length - 4; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (bytes[at] === 0x50 && bytes[at + 1] === 0x4b && bytes[at + 2] === 0x05 && bytes[at + 3] === 0x06) return true
  }
  return false
}

const bytesOf = (text) => encodeUtf8(text)

// The members the patterns name, less those `-x` names: every one of them
// where there are no patterns.
function choose(entries, opts) {
  const include = opts.members.map((text) => ({ text, pattern: bytesOf(text), hit: false }))
  const exclude = opts.excludes.map((text) => ({ text, pattern: bytesOf(text), hit: false }))
  // Every pattern that matches is marked, not just the first, since each is
  // reported on its own where it matched nothing.
  const hit = (patterns, name) => {
    let any = false
    for (const pattern of patterns) {
      if (!matches(pattern.pattern, name)) continue
      pattern.hit = true
      any = true
    }
    return any
  }
  const chosen = entries.filter((entry) => {
    const name = bytesOf(storedName(entry))
    const taken = include.length === 0 || hit(include, name)
    return !hit(exclude, name) && taken
  })
  return { entries: chosen, include, exclude, all: include.length === 0 && exclude.length === 0, missed: include.some((p) => !p.hit) }
}

function cautions(chosen, run) {
  for (const p of chosen.include) if (!p.hit) run.say(2, `caution: filename not matched:  ${p.text}\n`)
  for (const p of chosen.exclude) if (!p.hit) run.say(2, `caution: excluded filename not matched:  ${p.text}\n`)
}

// Padded as C pads, by bytes.
const pad = (text, width) => text + ' '.repeat(Math.max(0, width - bytesOf(text).length))

function test(chosen, name, run) {
  if (run.quiet === 0) for (const entry of chosen.entries) run.say(1, `    testing: ${pad(storedName(entry), 22)}   OK\n`)
}

function summary(chosen, name, run) {
  if (run.quiet > 1) return
  if (chosen.missed) run.say(1, `At least one error was detected in ${name}.\n`)
  else if (chosen.all) run.say(1, `No errors detected in compressed data of ${name}.\n`)
  else run.say(1, `No errors detected in ${name} for the ${chosen.entries.length} file${chosen.entries.length === 1 ? '' : 's'} tested.\n`)
}

// -l: nothing is said of a pattern that matched nothing, and the status
// says only whether anything was listed at all.
function list(chosen, name, run) {
  const { ctx } = run
  const utc = ctx.vars.has('TZ')
  const stamp = (entry) => formatDate(new Date(entry.mtime * 1000), '%Y-%m-%d %H:%M', utc)
  // An exact time is printed in local time and a DOS time as it stands, and
  // the reader says only what the time is: where the two differ, the
  // listing cannot be told.
  if (!utc && chosen.entries.some((entry) => stamp(entry) !== formatDate(new Date(entry.mtime * 1000), '%Y-%m-%d %H:%M', true))) {
    return run.refuse('feature', 'archive times', 'whether an entry\'s time is exact or a DOS time is not known here, and outside UTC the two are listed differently (TZ=UTC answers it)')
  }
  const size = (entry) => (entry.type === 'symlink' ? bytesOf(entry.linkname).length : entry.data.length)
  run.heading(name, false)
  if (run.quiet < 2) run.say(1, '  Length      Date    Time    Name\n---------  ---------- -----   ----\n')
  let total = 0
  for (const entry of chosen.entries) {
    total += size(entry)
    run.say(1, `${String(size(entry)).padStart(9)}  ${stamp(entry)}   ${storedName(entry)}\n`)
  }
  const count = chosen.entries.length
  if (run.quiet < 2) run.say(1, `---------                     -------\n${String(total).padStart(9)}                     ${count} file${count === 1 ? '' : 's'}\n`)
  return run.end(count === 0 && chosen.include.length > 0 ? 11 : 0)
}

function unzipRun(ctx, opts) {
  const everythingOut = opts.mode === 'test'
  const run = {
    ctx, events: [], status: 0, gap: null,
    quiet: opts.mode === 'pipe' ? Math.max(opts.quiet, 1) : opts.quiet,
    say(fd, text) { run.events.push({ fd: everythingOut ? 1 : fd, text }) },
    bytes(bytes) { run.events.push({ fd: 1, bytes }) },
    // "Archive:" before anything else, where UnZip is not quiet; where it
    // is, an error names the archive on a line of its own instead.
    heading(name, failing) {
      if (run.quiet === 0) run.say(1, `Archive:  ${name}\n`)
      else if (failing) run.say(2, `[${name}]\n`)
    },
    refuse(kind, detail, message) {
      run.say(2, `unzip: ${message}\n`)
      run.gap = { kind, detail, message: `unzip: ${message}` }
      return run.end(1)
    },
    end(status = run.status) {
      const text = (fd) => run.events.filter((event) => event.fd === fd && event.text !== undefined).map((event) => event.text).join('')
      const result = { stdout: text(1), stderr: text(2), exitCode: status, events: run.events }
      return run.gap ? markUnsupported(result, run.gap.kind, 'unzip', run.gap.detail, run.gap.message) : result
    },
  }
  return run
}
