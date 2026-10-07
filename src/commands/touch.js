import { parseArgs } from '../args.js'
import { dirname, lookup, slashedTarget, walkPath } from '../fs.js'
import { err, reason } from '../util.js'
import { markUnsupported, unsupportedNote } from '../unsupported.js'
import { quoteName } from './quote-name.js'
import { missingPathNote } from '../notes.js'
import { inOverlay, writeRefusal } from '../writable.js'

// `touch` makes the empty files it names, which is the half of the command a
// map of paths to contents can answer. The other half has nowhere to go: every
// entry here carries the one time the terminal was made, the time a long
// listing prints, so there is no per-entry clock to move forward. Where a write
// could have happened and only that clock is missing, the gap is reported
// rather than passed off as done — a caller touching a file to make it newer
// than another would otherwise be told it worked.
export function touch(_stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['c'], long: ['no-create'] })
  if (positional.length === 0) return err("touch: missing file operand\nTry 'touch --help' for more information.")
  const noCreate = flags.has('c') || flags.has('no-create')
  const state = { ctx, stderr: '', failed: false, gap: null }
  for (const name of positional) touchPath(name, noCreate, state)
  const result = { stdout: '', stderr: state.stderr, exitCode: state.failed ? 1 : 0 }
  return state.gap ? markUnsupported(result, 'feature', 'touch', 'times', state.gap) : result
}

const MISSING = 'No such file or directory'

// GNU opens a name to create it, unless `-c` says not to, and then sets its
// times by name, through any link, whether the open worked or not. Only
// where the times cannot be set is anything said: what the open failed
// with, unless the name was a directory, which no open for writing takes —
// and then what setting the times failed with, which `-c` keeps quiet about
// for a name that is not there.
function touchPath(name, noCreate, state) {
  const { ctx } = state
  const shown = quoteName(name, ctx)
  if (name === '-') return touchOutput(noCreate, state)
  const found = lookup(ctx.cwd, name, ctx.fs)
  let opening = null
  if (!noCreate) {
    opening = found.error === null ? openError(ctx, found.path) : createError(ctx, name)
    if (opening === null && found.error !== null) {
      try {
        // Append opens without truncating, so nothing is lost to a name that
        // turns out to hold something after all.
        if (ctx.fs.openWritable?.(ctx.cwd, name, true)) return
        opening = writeRefusal(ctx, ctx.cwd)
      } catch (e) {
        if (unsupportedNote(e)) throw e
        missingPathNote(ctx, 'touch', e?.path, e?.fsError)
        const message = reason(e)
        opening = e?.fsError ?? (message.startsWith(name + ': ') ? message.slice(name.length + 2) : message)
      }
    }
  }
  const setting = found.error ?? (ctx.writable && inOverlay(found.path) ? null : writeRefusal(ctx, found.path))
  // A name that is already there, where it could be written: the missing
  // clock is the whole of the reason.
  if (setting === null) return gap(state, shown)
  if (opening !== null && opening !== 'Is a directory') {
    missingPathNote(ctx, 'touch', name, opening)
    return fail(state, `cannot touch ${shown}: ${opening}`)
  }
  if (noCreate && setting === MISSING) return
  missingPathNote(ctx, 'touch', name, setting)
  fail(state, `setting times of ${shown}: ${setting}`)
}

// Opening an entry that is there: a directory is not opened for writing at
// all, and a file is opened where the overlay can write it.
function openError(ctx, absolute) {
  if (ctx.fs.isDir(absolute)) return 'Is a directory'
  return ctx.writable && inOverlay(absolute) ? null : writeRefusal(ctx, absolute)
}

// What open(2) with O_CREAT says of a name that does not resolve: the way to
// it fails as it failed the lookup, a link included, and a link that leads
// nowhere is followed to the name it leads to, which is the one made; a
// trailing slash asks for a directory no open makes, whether the name was
// spelled with one or a link's target was; and the directory the file would
// go in has to be one the overlay can write.
function createError(ctx, name) {
  if (name === '') return MISSING
  const slashed = slashedTarget(ctx.cwd, name, ctx.fs)
  if (slashed !== null) return slashed
  const walk = walkPath(ctx.cwd, name, ctx.fs)
  if (walk.error === null || walk.rest.length === 0 && walk.error === MISSING && name.endsWith('/')) return 'Is a directory'
  if (walk.rest.length > 0 || walk.error !== MISSING) return walk.error
  return ctx.writable && inOverlay(walk.path) ? null : writeRefusal(ctx, dirname(walk.path))
}

// `touch -` sets the times of what standard output is open on: a terminal,
// a pipe or the sink take that without a word, a file has times this
// terminal does not keep, and a closed descriptor is EBADF, which `-c` is
// quiet about.
function touchOutput(noCreate, state) {
  const output = state.ctx.outputFds?.[1]
  if (output === 'closed') {
    if (!noCreate) fail(state, "setting times of '-': Bad file descriptor")
    return
  }
  if (typeof output === 'object' && output !== null) gap(state, quoteName('-', state.ctx))
}

function gap(state, shown) {
  const message = `touch: setting the times of ${shown} is not supported (every entry here carries the one time this filesystem keeps)`
  state.gap ??= message
  state.stderr += message + '\n'
  state.failed = true
}

function fail(state, message) {
  state.stderr += `touch: ${message}\n`
  state.failed = true
}
