import { emptyOutput } from '../shell/output.js'
import { UnsupportedError } from '../unsupported.js'
import { MAX_SED_OUTPUT } from './sed-common.js'

export function lineWriter(write, delimiter) {
  let missing = false
  return (text, terminator) => {
    write((missing ? delimiter : '') + text + (terminator ?? ''))
    missing = terminator === ''
  }
}

// GNU caches w descriptors by their spelling, including independent offsets
// for aliases of the same path. Files open while their scripts are compiled.
export function sedOutput(ctx, delimiter) {
  const writers = new Map()
  let written = 0
  let currentIdentity, input, result
  const syncReads = () => ctx.io.setReads([currentIdentity, input?.identity])
  function stream(fd, text) {
    if (text === '') return
    account(text)
    syncReads()
    const handle = ctx.outputFds[fd]
    if (handle?.path) { handle.write(text); return }
    if (handle === 'closed') {
      const e = new Error('write error: Bad file descriptor'); e.exitCode = 4; throw e
    }
    result[fd === 1 ? 'stdout' : 'stderr'] += text
    result.events.push({ fd, text })
  }
  function account(text) {
    written += text.length
    if (written > MAX_SED_OUTPUT) throw new UnsupportedError('feature', 'output limit', 'sed: output limit exceeded')
  }
  return {
    start(reader) { result = emptyOutput(); input = reader; currentIdentity = undefined; syncReads(); return result },
    record(record) { currentIdentity = record?.identity; syncReads() },
    finish() { currentIdentity = undefined; input = null; syncReads() },
    stream,
    account,
    openWrite(name) {
      if (writers.has(name)) return writers.get(name)
      let write
      if (name === '/dev/null') write = () => {}
      else if (name === '/dev/stdout' || name === '/dev/stderr') write = (text) => stream(name === '/dev/stdout' ? 1 : 2, text)
      else {
        let handle
        try { handle = ctx.writable && ctx.fs.openWritable(ctx.cwd, name) } catch (e) { e.exitCode = 4; throw e }
        if (!handle) throw new UnsupportedError('feature', 'output file', `sed: ${name}: Read-only file system`)
        write = (text) => { account(text); syncReads(); handle.write(text) }
      }
      const writer = lineWriter(write, delimiter)
      writers.set(name, writer)
      return writer
    },
  }
}

// Script compilation can truncate a file whose stdin descriptor the shell
// already opened. Consumed streams may have buffered bytes we cannot model.
export function refreshSedStdin(stdin, ctx) {
  const handle = ctx.stdinHandle
  if (!handle) return stdin
  const content = ctx.io.bufferReads(() => ctx.fs.readIdentity(handle.identity))
  if (content === handle.content) return stdin
  if (stdin !== handle.content) throw new UnsupportedError('feature', 'modified redirected input', 'sed: reading an input file changed after partial consumption is not supported')
  ctx.stdinHandle = { ...handle, content }
  ctx.stdinOrigin = ctx.stdinLeft = content
  return content
}
