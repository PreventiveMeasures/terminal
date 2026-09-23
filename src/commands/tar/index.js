// tar, as GNU tar 1.35 answers it, over @preventive/archive's tar reader and
// writer: `-c` to make an archive, `-t` to list one and `-x` to extract it,
// with gzip (`-z`, or what the archive's first bytes or name say) through the
// runtime's streams. Every diagnostic and every listing here was recorded
// from GNU tar 1.35 in the C.UTF-8 locale.
//
// What it writes goes to the writable overlay or to stdout, the archive's
// bytes as they are; everything else a write would touch is the read-only
// filesystem, which is a gap. So is whatever the package will not read or
// write, and every option this terminal does not carry. What an archive's
// headers hold that the package does not hand out — each name as stored,
// the pax records GNU reads — is read back out of them (headers.js).

import { storedName } from '../stored-names.js'
import { createArchive } from './create.js'
import { extractEntry, landing, strippedName } from './extract.js'
import { longLines, quoteEscape } from './list.js'
import { enterDirectory, memberNames, quoteColon, reportMissing } from './names.js'
import { parseTar } from './options.js'
import { readArchive } from './read.js'
import { tarResult, tarState } from './state.js'

export async function tar(_stdin, tokens, ctx) {
  const opts = parseTar(tokens, ctx)
  if (opts.usage) return { stdout: '', stderr: opts.usage.text, exitCode: opts.usage.status }
  const state = tarState(ctx)
  if (opts.mode === 'create') await createArchive(opts, state)
  else await readMembers(opts, state)
  return tarResult(state)
}

// -t and -x: the entries in the order the archive holds them, those the
// operands name, each from where the `-C` before its operand leads.
async function readMembers(opts, state) {
  const { ctx } = state
  // GNU's clock starts before it opens the archive.
  const began = Date.now()
  const read = await readArchive(opts, state)
  if (!read) return
  const names = memberNames(opts.items)
  const extracting = opts.mode === 'extract'
  // What -O writes goes to stdout, which moves the names to stderr.
  if (extracting && opts.toStdout) state.listTo = 2
  const verbose = extracting ? opts.verbose : opts.verbose + 1
  const line = verbose > 1 ? longLines(ctx, opts) : null
  const places = new Map()
  for (const [i, entry] of read.entries.entries()) {
    // What GNU says of an entry's header it says as it reads it, whatever
    // becomes of the entry.
    for (const warning of read.warnings[i]) state.warn(warning)
    const shown = storedName(entry)
    const hit = names.match(shown)
    if (hit === null) continue
    const dir = placeOf(hit, places, state)
    if (dir === null) return
    const name = extracting ? strippedName(shown, opts.strip) : shown
    if (name === null) continue
    if (verbose > 0) state.list(line ? line(entry) : quoteEscape(shown, ctx))
    if (extracting && opts.toStdout) {
      if (entry.type === 'file' || entry.type === 'contiguous-file') state.bytes(entry.data)
    } else if (extracting && extractEntry(entry, name, landing(dir, name), state, opts.keepOld)) dated(read.mtimes[i], name, began, state)
    if (state.stopped) return
  }
  // gzip's status is waited for when the archive is closed, which GNU does
  // before it looks for what it did not find.
  if (read.child) return state.fatal(`Child returned status ${read.child}`)
  reportMissing(names, state)
}

// GNU sets the time of each entry it writes, and warns of one before 1970 or
// after the run began, the latter counted to the nanosecond from when it
// began. The overlay keeps no times, so an entry dated either way is a gap.
function dated(mtime, name, began, state) {
  if (mtime >= 0 && mtime * 1000 <= began) return
  state.refuse('feature', 'archive times', `${quoteColon(name, state.ctx)}: extracting an entry dated before 1970 or in the future is not supported`)
}

// Where the `-C` directories before an operand lead, entered the first time
// an entry the operand names comes up, each from where the one before left
// it. One that cannot be entered ends the run.
function placeOf(hit, places, state) {
  if (places.has(hit)) return places.get(hit)
  let dir = state.ctx.cwd
  for (const step of hit.dirs) {
    dir = enterDirectory(dir, step, state)
    if (dir === null) return null
  }
  places.set(hit, dir)
  return dir
}
