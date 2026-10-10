// The files r and R read: r at the time its text is written out, R a line
// at a time from a file opened as the script is read.

import { lookup } from '../fs.js'
import { UnsupportedError } from '../unsupported.js'
import { decodeUtf8, encodeUtf8 } from '../util.js'
import { panic } from './sed-common.js'

// print_file: a file that cannot be opened is no error; one that cannot be
// read is. It is written in fread's 8192-byte pieces.
export function writeFile(state, name) {
  const text = readCommandFile(state.ctx, state.output, name)
  if (text === null) return
  const bytes = encodeUtf8(text)
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(bytes.length, start + 8192)
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
    state.main.write(decodeUtf8(bytes.subarray(start, end)))
    start = end
  }
}

// The text of an r or R file, or null where GNU's fopen would fail. A
// stream, or a file this run writes, would be read as it is written.
function readCommandFile(ctx, output, name) {
  if (streamName(name)) {
    if (name === '/dev/null') return ''
    throw new UnsupportedError('feature', 'r from a stream', `sed: reading ${name} with r or R is not supported`)
  }
  const found = lookup(ctx.cwd, name, ctx.fs)
  if (found.error) return null
  if (ctx.fs.isDir(found.path)) throw panic(`read error on ${name}: Is a directory`)
  const identity = ctx.fs.fileIdentity?.(found.path)
  for (const writer of output.writers.values()) {
    if (writer.identity !== undefined && writer.identity === identity) {
      throw new UnsupportedError('feature', 'r of a w file', `sed: reading ${name}, which this script writes, is not supported`)
    }
  }
  return ctx.io.bufferReads(() => ctx.fs.readFile(found.path))
}

const streamName = (name) => /^\/(dev|proc)\//u.test(name)

// An R file: opened as the script is read, so one missing then reads as
// empty, and read a line at a time from the first R that runs. A line keeps
// its delimiter, and the last one goes out without one if it has none.
export function commandReader(ctx, output, name, delimiter) {
  if (streamName(name) && name !== '/dev/null') {
    throw new UnsupportedError('feature', 'r from a stream', `sed: reading ${name} with r or R is not supported`)
  }
  const missing = name !== '/dev/null' && Boolean(lookup(ctx.cwd, name, ctx.fs).error)
  let at = 0, content = null
  return {
    rewind() { at = 0 },
    next() {
      if (missing) return null
      content ??= readCommandFile(ctx, output, name) ?? ''
      if (at >= content.length) return null
      const end = content.indexOf(delimiter(), at)
      const stop = end < 0 ? content.length : end + 1
      const text = content.slice(at, stop)
      at = stop
      return text
    },
  }
}
