// tee writes what it reads twice over: into every file it was given, and on
// to the stream it was going to anyway. A file it cannot open is that file's
// trouble rather than the read's — GNU names it, goes on to the next, and
// still writes everything it read — so only the status carries it.
//
// The overlay is the only place here a file can be written, so a name outside
// it is a gap rather than one of GNU's errors: the write is one GNU would
// have made, and this is where it cannot. It is reported over the top of what
// was written all the same, the files it could write having been written.

import { parseArgs } from '../args.js'
import { consumeStdin, encodeUtf8 } from '../util.js'
import { markUnsupported, unsupported, unsupportedNote } from '../unsupported.js'

export function tee(stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['a', 'i', 'p'], long: ['append', 'ignore-interrupts'] })
  const append = flags.has('a') || flags.has('append')
  // A pipe carries bytes where a stage upstream wrote them, and what tee
  // hands on is what it was handed, whichever of the two that was.
  const piped = ctx.stdinBytes
  consumeStdin(ctx, '', true)
  const bytes = piped ?? encodeUtf8(stdin)
  const state = { stderr: '', status: 0, gap: null }
  for (const name of positional) write(name, bytes, append, state, ctx)
  const events = [{ fd: 1, bytes }, ...(state.stderr ? [{ fd: 2, text: state.stderr }] : [])]
  // Bytes that spell text are that text, so only what no text spells travels
  // as the bytes it is.
  const out = piped === null
    ? { stdout: stdin, stderr: state.stderr, exitCode: state.status }
    : { stdout: '', stderr: state.stderr, exitCode: state.status, events }
  if (!state.gap) return out
  const note = unsupportedNote(state.gap)
  return markUnsupported({ ...out, exitCode: 1 }, note.kind, note.command, note.detail, note.message)
}

function write(name, bytes, append, state, ctx) {
  // GNU writes to the sink and keeps nothing of it, which is what keeping
  // nothing of it is.
  if (name === '/dev/null') return
  let handle
  try {
    handle = ctx.writable && ctx.fs.openWritable?.(ctx.cwd, name, append)
  } catch (e) {
    // The message names the file it is about, as GNU's does.
    state.stderr += `tee: ${e.message}\n`
    state.status = 1
    return
  }
  if (!handle) {
    state.gap ??= unsupported('feature', 'tee', 'read-only target', `tee: ${name}: Read-only file system`, 1)
    state.stderr += `tee: ${name}: Read-only file system\n`
    return
  }
  handle.writeBytes(bytes)
}
