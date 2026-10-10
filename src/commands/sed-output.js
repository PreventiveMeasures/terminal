import { emptyOutput } from '../shell/output.js'
import { UnsupportedError, unsupportedNote } from '../unsupported.js'
import { encodeUtf8, stdoutIsTerminal } from '../util.js'
import { MAX_SED_OUTPUT, panic } from './sed-common.js'
import { missingPathNote } from '../notes.js'

// One of GNU's `struct output`: where a line goes, and whether the last one
// written there lacked its delimiter, which the next write supplies first.
// `write` is one ck_fwrite; `print` one fprintf, whose failure GNU ignores.
// The delimiter may be given as a function: it is the one in force when the
// line is written.
export function outputStream(write, delimiter, print = write) {
  const delim = typeof delimiter === 'function' ? delimiter : () => delimiter
  const out = {
    missing: false,
    write,
    print,
    supply() {
      if (!out.missing) return
      write(delim())
      out.missing = false
    },
    line(text, nl) {
      if (text === null) return
      out.supply()
      if (text !== '') write(text)
      if (nl) write(delim())
      else out.missing = true
    },
  }
  return out
}

const BLOCK = 4096
const CLOSED_BLOCK = 8192
const TTY_LINE = 1024
const byteLength = (text) => encodeUtf8(text).length

// GNU writes stdout through stdio: a block of 4096 bytes to a pipe or a file,
// a line at a time to a terminal, and 8192 bytes to a descriptor that is
// closed, which fails only when the block fills and again when sed closes
// it. Diagnostics go to stderr at once. Where both streams reach the same
// place, stdout is held back here exactly as stdio holds it, so the two
// arrive in GNU's order; elsewhere it is written as it comes.
export function sedOutput(ctx, delimiter) {
  const fds = ctx.outputFds
  const io = {
    ctx, fds, delimiter, written: 0, currentIdentity: undefined, input: null, result: null,
    closed: fds[1] === 'closed', merged: sameDestination(fds[1], fds[2]), terminal: stdoutIsTerminal(ctx),
    // Bytes put into stdout's buffer, those stdio has written out, and the
    // text not yet passed on.
    buffered: 0, flushed: 0, released: 0, held: [], block: undefined, misordered: false,
  }
  io.syncReads = () => ctx.io.setReads([io.currentIdentity, io.input?.identity])
  io.account = (text) => {
    io.written += text.length
    if (io.written > MAX_SED_OUTPUT) throw new UnsupportedError('feature', 'output limit', 'sed: output limit exceeded')
  }
  io.emit = (fd, text) => {
    if (text === '') return
    io.syncReads()
    const handle = fds[fd]
    if (handle?.path) { handle.write(text); return }
    io.result[fd === 1 ? 'stdout' : 'stderr'] += text
    io.result.events.push({ fd, text })
  }
  const stdout = (text, checked) => writeStdout(io, text, checked)
  const stderr = (text) => writeStderr(io, text)
  const writers = new Map()
  return {
    start(reader) {
      Object.assign(io, { result: emptyOutput(), input: reader, currentIdentity: undefined, buffered: 0, flushed: 0, released: 0, held: [] })
      io.syncReads()
      return io.result
    },
    record(record) { io.currentIdentity = record?.identity; io.syncReads() },
    // exit(): stdio writes out what it holds. A closed stdout fails only
    // when sed closes it, which it does when it finishes rather than dies.
    finish(closing) {
      release(io, io.buffered)
      io.currentIdentity = undefined
      io.input = null
      io.syncReads()
      if (io.misordered) {
        io.misordered = false
        throw new UnsupportedError('feature', 'combined output ordering', 'error: merging this command’s stdout and stderr in order is not supported')
      }
      if (io.closed && closing) throw panic("couldn't close stdout: Bad file descriptor")
    },
    stdout,
    stderr,
    account: io.account,
    main: () => outputStream(stdout, delimiter, (text) => stdout(text, false)),
    // GNU caches w descriptors by their spelling, including independent
    // offsets for aliases of the same path. Files open while their scripts
    // are compiled, and /dev/stdout and /dev/stderr are sed's own streams.
    openWrite(name) {
      if (!writers.has(name)) writers.set(name, openWriter(io, name, stdout, stderr))
      return writers.get(name)
    },
    writers,
    closed: io.closed,
  }
}

// One write to stdout. `checked` is ck_fwrite, which dies of a failure;
// fprintf's goes unnoticed, and the buffer it could not write is dropped.
function writeStdout(io, text, checked = true) {
  if (text === '') return
  io.account(text)
  const size = byteLength(text)
  if (io.closed) {
    // stdio sizes its buffer by the descriptor when it first writes. A
    // file sed has open then holds the lowest free one, the closed stdout's
    // own, and is sized as a file is; a closed one has no size, and gets
    // BUFSIZ. Either way the writes fail.
    io.block ??= io.input?.operandOpen ? BLOCK : CLOSED_BLOCK
    if (io.buffered - io.flushed + size > io.block) {
      if (checked) throw panic(`couldn't write ${size} item${size === 1 ? '' : 's'} to stdout: Bad file descriptor`)
      io.flushed = io.buffered + size
    }
    io.buffered += size
    return
  }
  if (!io.merged) { io.emit(1, text); return }
  io.held.push(text)
  const before = io.buffered
  io.buffered += size
  if (io.terminal) {
    const newline = text.lastIndexOf('\n')
    if (newline >= 0) io.flushed = before + byteLength(text.slice(0, newline + 1))
  } else if (before - io.flushed + size > BLOCK) io.flushed = Math.floor(io.buffered / BLOCK) * BLOCK
}

function writeStderr(io, text) {
  if (text === '') return
  io.account(text)
  if (io.merged) {
    if (io.terminal && io.buffered - io.flushed > TTY_LINE) unordered(io)
    release(io, io.flushed)
  }
  io.emit(2, text)
}

// Pass on stdout up to the byte `limit`.
function release(io, limit) {
  while (io.released < limit && io.held.length) {
    const text = io.held[0]
    const size = byteLength(text)
    if (io.released + size <= limit) {
      io.emit(1, text)
      io.held.shift()
      io.released += size
      continue
    }
    let bytes = io.released, cut = 0
    for (const ch of text) {
      const width = byteLength(ch)
      if (bytes + width > limit) break
      bytes += width
      cut += ch.length
    }
    // stdio wrote part of a character before the diagnostic.
    if (bytes !== limit) unordered(io)
    io.emit(1, text.slice(0, cut))
    io.held[0] = text.slice(cut)
    io.released = bytes
    if (bytes !== limit) break
  }
}

// The router refuses an unordered result whose streams it merges; a file
// they share has no router, and is refused when sed finishes.
function unordered(io) {
  io.result.unordered = true
  io.misordered = Boolean(io.fds[1]?.path)
}

function openWriter(io, name, stdout, stderr) {
  const { ctx, fds } = io
  let write
  if (name === '/dev/stdout') write = stdout
  else if (name === '/dev/stderr') {
    write = (text) => {
      if (fds[2] === 'closed') {
        const size = byteLength(text)
        throw panic(`couldn't write ${size} item${size === 1 ? '' : 's'} to stderr: Bad file descriptor`)
      }
      stderr(text)
    }
  } else if (name === '/dev/null') write = () => {}
  else {
    // The file would take the closed stdout's descriptor, and stdout's
    // lines would go into it.
    if (io.closed) throw new UnsupportedError('feature', 'closed stdout', 'sed: opening a w file while stdout is closed is not supported')
    let handle
    try { handle = ctx.writable && ctx.fs.openWritable(ctx.cwd, name) } catch (e) {
      if (unsupportedNote(e)) throw e
      missingPathNote(ctx, 'sed', e?.path, e?.fsError)
      throw panic(`couldn't open file ${name}: ${e.fsError ?? e.message.slice(e.message.lastIndexOf(': ') + 2)}`)
    }
    if (!handle) {
      throw Object.assign(new UnsupportedError('feature', 'output file', `sed: couldn't open file ${name}: Read-only file system`), { exitCode: 4 })
    }
    write = (text) => { io.account(text); io.syncReads(); handle.write(text) }
    write.identity = handle.identity
  }
  return Object.assign(outputStream(write, io.delimiter), { path: name, identity: write.identity })
}

// The descriptors' destinations are one: the router's own test (see
// routeEvents in ../shell/output.js).
function sameDestination(first, second) {
  if (first === second) return first !== 'null' && first !== 'closed' && first !== undefined
  return first?.identity && second?.identity ? first.identity === second.identity : Boolean(first?.path && first.path === second?.path)
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
