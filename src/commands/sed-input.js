import { resolve } from '../fs.js'
import { consumeStdin, readFilesFor } from '../util.js'
import { refreshSedStdin } from './sed-output.js'

// Open operands only as records or an evaluated $ address require them.
// q leaves later operands unopened and preserves the rest of shared stdin.
export function sedInput(files, stdin, ctx, delimiter, separate, report) {
  const names = files.length ? files : ['-']
  const status = { stderr: '', failed: false }
  let index = 0, line = 0, pipe = stdin, source = null

  function available() {
    while (source === null || source.pos === source.content.length) {
      if (index === names.length) return false
      source = null
      const name = names[index++]
      if (name === '-') pipe = refreshSedStdin(pipe, ctx)
      else if (name === '/dev/stdin' && ctx.stdinHandle) ctx.stdinOrigin = ctx.io.bufferReads(() => ctx.fs.readIdentity(ctx.stdinHandle.identity))
      const r = readFilesFor('sed', [name], ctx, pipe)
      status.stderr += r.stderr
      status.failed ||= r.failed
      source = r.inputs.length ? { ...r.inputs[0], identity: inputIdentity(name, ctx), pos: 0, first: true } : null
      if (r.stderr && report) report(r.stderr)
      // readFilesFor consumes shared stdin eagerly; this reader consumes it
      // one record at a time, including when $ merely looks ahead.
      if (source?.shared) consumeStdin(ctx, pipe)
      if (separate) line = 0
    }
    return true
  }

  function next() {
    if (!available()) return null
    const start = source.pos
    const end = source.content.indexOf(delimiter, start)
    const terminator = end < 0 ? '' : delimiter
    const text = source.content.slice(start, end < 0 ? source.content.length : end)
    source.pos = end < 0 ? source.content.length : end + delimiter.length
    if (source.shared) {
      pipe = source.content.slice(source.pos)
      consumeStdin(ctx, pipe)
    }
    const reset = source.first
    source.first = false
    let last
    return {
      text, terminator, line: ++line, reset, identity: source.identity,
      last: () => last ??= source.pos < source.content.length ? false : separate || !available(),
    }
  }

  return { next, status, get identity() { return source?.identity } }
}

function inputIdentity(name, ctx) {
  if (name === '-' || name === '/dev/stdin') return ctx.stdinHandle?.identity
  return ctx.fs.fileIdentity?.(resolve(ctx.cwd, name))
}
