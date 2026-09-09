import { consumeStdin, readFilesFor } from '../util.js'

// Open operands only as records or an evaluated $ address require them.
// q leaves later operands unopened and preserves the rest of shared stdin.
export function sedInput(files, stdin, ctx, delimiter, separate) {
  const names = files.length ? files : ['-']
  const status = { stderr: '', failed: false }
  let index = 0, line = 0, pipe = stdin, source = null

  function available() {
    while (source === null || source.pos === source.content.length) {
      if (index === names.length) return false
      const r = readFilesFor('sed', [names[index++]], ctx, pipe)
      status.stderr += r.stderr
      status.failed ||= r.failed
      source = r.inputs.length ? { ...r.inputs[0], pos: 0, first: true } : null
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
      text, terminator, line: ++line, reset,
      last: () => last ??= source.pos < source.content.length ? false : separate || !available(),
    }
  }

  return { next, status }
}
