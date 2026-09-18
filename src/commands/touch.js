import { parseArgs } from '../args.js'
import { creationError, lookup } from '../fs.js'
import { err, reason } from '../util.js'
import { markUnsupported, unsupportedNote } from '../unsupported.js'
import { quoteName } from './quote-name.js'
import { missingPathNote } from '../notes.js'

// `touch` makes the empty files it names, which is the half of the command a
// map of paths to contents can answer. The other half has nowhere to go: every
// entry here carries the one time the terminal was made, the time a long
// listing prints, so there is no per-entry clock to move forward. Where a write
// could have happened and only that clock is missing, the gap is reported
// rather than passed off as done — a caller touching a file to make it newer
// than another would otherwise be told it worked.
export function touch(_stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['c'], long: ['no-create'] })
  if (positional.length === 0) return err('touch: missing file operand')
  const noCreate = flags.has('c') || flags.has('no-create')
  const state = { ctx, stderr: '', failed: false, gap: null }
  for (const name of positional) touchPath(name, noCreate, state)
  const result = { stdout: '', stderr: state.stderr, exitCode: state.failed ? 1 : 0 }
  return state.gap ? markUnsupported(result, 'feature', 'touch', 'times', state.gap) : result
}

function touchPath(name, noCreate, state) {
  const { ctx } = state
  const shown = quoteName(name, ctx)
  const found = lookup(ctx.cwd, name, ctx.fs)
  if (found.error === null) return existing(name, shown, found.path, state)
  // GNU opens a name to create it, and where it cannot — `-c`, or a trailing
  // slash no open would make a file of — sets times directly instead, naming
  // in the diagnostic which of the two it was doing. `-c` passes over a name
  // that is simply absent; every other failure is still one.
  const setting = noCreate || name.endsWith('/')
  // Nothing is reported for a name `-c` passes over, and a failure nobody is
  // told about is not one to hint about either.
  if (noCreate && found.error === 'No such file or directory') return
  missingPathNote(ctx, 'touch', name, found.error)
  if (setting) return fail(state, `setting times of ${shown}: ${found.error}`)
  const invalid = creationError(ctx.cwd, name, ctx.fs, found)
  if (invalid) return fail(state, `cannot touch ${shown}: ${invalid}`)
  try {
    // Append opens without truncating, so nothing is lost to a name that turns
    // out to hold something after all.
    if (!ctx.fs.openWritable?.(ctx.cwd, name, true)) fail(state, `cannot touch ${shown}: Read-only file system`)
  } catch (e) {
    if (unsupportedNote(e)) throw e
    missingPathNote(ctx, 'touch', e?.path, e?.fsError)
    const message = reason(e)
    fail(state, `cannot touch ${shown}: ${message.startsWith(name + ': ') ? message.slice(name.length + 2) : message}`)
  }
}

// A name that is already there needs no making, so what is left is the time.
// Outside the writable overlay the filesystem answers first, as it does for
// every other write; inside it, the missing clock is the whole of the reason.
function existing(name, shown, path, state) {
  const { ctx } = state
  if (!ctx.writable || path !== '/tmp' && !path.startsWith('/tmp/')) {
    return fail(state, `setting times of ${shown}: Read-only file system`)
  }
  const message = `touch: setting the times of ${shown} is not supported (every entry here carries the one time this filesystem keeps)`
  state.gap ??= message
  state.stderr += message + '\n'
  state.failed = true
}

function fail(state, message) {
  state.stderr += `touch: ${message}\n`
  state.failed = true
}
