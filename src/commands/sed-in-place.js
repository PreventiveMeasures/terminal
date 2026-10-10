import { lookupWithNote, missingPathNote } from '../notes.js'
import { dirname, lookup } from '../fs.js'
import { appendOutput, emptyOutput } from '../shell/output.js'
import { markUnsupported, unsupported, unsupportedFrom, unsupportedNote } from '../unsupported.js'
import { err, readFailure } from '../util.js'
import { runSed } from './sed-run.js'

// Each input is edited on its own: GNU writes it to a temporary file beside
// it, renames the input to its backup, if a suffix asks for one, and the
// temporary file over the input. A failure of any of that is a panic, which
// ends the run with status 4.
export function runInPlace(program, ctx, suffix) {
  const result = emptyOutput()
  let badInput = false
  for (const name of program.files) {
    const found = inPlaceInput(name, ctx)
    if (found.error) {
      // A later input can be stderr's file, so report before opening it.
      appendOutput(result, ctx.flushOutput(found.error))
      if (found.error.exitCode !== 2) return copyNote(result, found.error)
      badInput = true
      continue
    }
    // F names the input as it was given.
    const next = runSed({ ...program, files: [found.path], labels: [name], separate: true }, ctx, true)
    const { content, ...output } = next
    appendOutput(result, output)
    if (next.failed || unsupportedNote(next)) return copyNote(result, next)
    const backup = backupName(name, suffix)
    let replaced
    try { replaced = ctx.fs.replaceWritable(ctx.cwd, name, content, backup) } catch (e) {
      missingPathNote(ctx, 'sed', e?.path, e?.fsError)
      const reason = backup !== undefined && e.message.startsWith(`${backup}: `) ? renameError(ctx, backup, e.message.slice(backup.length + 2)) : null
      const failed = reason ? err(`sed: cannot rename ${name}: ${reason}`, 4) : unsupportedFrom(e, 'sed', `sed: ${e.message}`, 4)
      appendOutput(result, failed)
      return copyNote(result, failed)
    }
    if (!replaced) {
      const failed = refused(backup ?? name)
      appendOutput(result, failed)
      return copyNote(result, failed)
    }
    if (next.quit) break
  }
  if (badInput) result.exitCode = 2
  // sed closes stdout as it finishes, whatever it wrote there.
  if (ctx.outputFds?.[1] === 'closed') appendOutput(result, err("sed: couldn't close stdout: Bad file descriptor", 4))
  return result
}

// What rename(2) says of the backup name: a name with a trailing slash in
// a directory that is there asks for a directory the input is not.
function renameError(ctx, backup, reason) {
  if (reason !== 'No such file or directory' || !backup.endsWith('/')) return reason
  const parent = lookup(ctx.cwd, dirname(backup.replace(/\/+$/u, '')), ctx.fs)
  return !parent.error && ctx.fs.isDir(parent.path) ? 'Not a directory' : reason
}

function inPlaceInput(name, ctx) {
  if (name === '/dev/null' || name === '/dev/stdin' && !ctx.stdinFile
    || name === '/dev/stdout' && !ctx.outputFds[1]?.path || name === '/dev/stderr' && !ctx.outputFds[2]?.path) {
    return { error: err(`sed: couldn't edit ${name}: not a regular file`, 4) }
  }
  if (name === '/dev/stdin' || name === '/dev/stdout' || name === '/dev/stderr') return { error: refused(name) }
  const found = lookupWithNote(ctx, 'sed', name)
  if (found.error) return { error: err(readFailure('sed', name, found.error).trimEnd(), 2) }
  if (ctx.fs.isDir(found.path)) return { error: err(`sed: couldn't edit ${name}: not a regular file`, 4) }
  // The file read is the one the name leads to; the file written takes the
  // name itself, so it is the name's own directory that has to be writable.
  const own = lookup(ctx.cwd, name, ctx.fs, { follow: false }).path
  if (!ctx.writable || !own.startsWith('/tmp/')) return { error: refused(name) }
  return found
}

function backupName(name, suffix) {
  if (suffix === '' || suffix === '*') return
  return suffix.includes('*') ? suffix.replaceAll('*', () => name) : name + suffix
}

// GNU makes its temporary file, under a random name, beside the input and
// would say it could not where that is read-only; it panics, status 4.
function refused(name) {
  return unsupported('feature', 'sed', '-i', `sed: ${name}: file system is read-only`, 4)
}

function copyNote(result, next) {
  const note = unsupportedNote(next)
  return note ? markUnsupported(result, note.kind, note.command, note.detail, note.message) : result
}
