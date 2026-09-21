import { parseArgs } from '../args.js'
import { decodeUtf8, encodeUtf8Loose, readBytesOf } from '../util.js'
import { lookupWithNote } from '../notes.js'
import { unsupported } from '../unsupported.js'
import { decompressionAvailable, decompressionOf, looksCompressed } from '../decompress.js'

// gzip, decompressing and nothing else. What it inflates was inflated before
// the line ran (../decompress.js): `DecompressionStream` answers
// asynchronously and a line runs synchronously, so `runAsync` does the
// waiting and this reads the answer. Under `run`, or where no such stream
// exists, there is nothing to read and the gap says which of the two it was.
//
// Compressing is not here at all: what it would write is bytes, which a
// terminal carrying its output as a string cannot hand back, and a file it
// could write them to is the overlay's alone.

// What `-d` takes off a name to write the file beside it. GNU knows these
// and refuses a name it cannot shorten.
const SUFFIXES = Object.freeze({ __proto__: null, '.gz': '', '.tgz': '.tar', '.taz': '.tar', '-gz': '', '.z': '', '-z': '', '_z': '' })

export function gzip(stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, {
    short: ['d', 'c', 'k'],
    long: ['decompress', 'uncompress', 'stdout', 'to-stdout', 'keep'],
  })
  if (!['d', 'decompress', 'uncompress'].some((name) => flags.has(name))) {
    return unsupported('feature', 'gzip', 'compression', 'gzip: compressing is not supported', 1)
  }
  const opts = { stdout: ['c', 'stdout', 'to-stdout'].some((name) => flags.has(name)), keep: flags.has('k') || flags.has('keep') }
  const state = { ctx, stdout: '', stderr: '', status: 0, gap: null }
  // Stdin is text here, and no text spells a gzip member — the second byte of
  // its header begins no character. So a pipe is read the way GNU reads one
  // that carries anything else, and always finds the same thing.
  if (positional.length === 0) dataError(state, stdin === '' ? 'stdin: unexpected end of file' : 'stdin: not in gzip format')
  else for (const name of positional) decompress(name, opts, state)
  if (state.gap) return state.gap
  return { stdout: state.stdout, stderr: state.stderr, exitCode: state.status }
}

function decompress(name, opts, state) {
  const { ctx } = state
  const found = lookupWithNote(ctx, 'gzip', name)
  if (found.error) return fail(state, `${name}: ${found.error}`, 1)
  if (ctx.fs.isDir(found.path)) return fail(state, `${name} is a directory -- ignored`, 2)
  // Only a file held as bytes can be a member: no text spells one, since the
  // second byte of the header begins no character. Asking costs nothing,
  // where reading a file to look at its first two bytes would.
  const bytes = ctx.fs.isBytes?.(found.path) === true ? readBytesOf(ctx.fs, found.path) : undefined
  if (!looksCompressed(bytes)) return dataError(state, `${name}: ${tooShort(bytes, found.path, ctx) ? 'unexpected end of file' : 'not in gzip format'}`)
  const inflated = decompressionOf(ctx, bytes)
  if (inflated === undefined) return refuse(state)
  const written = opts.stdout ? toStdout(inflated.bytes, state) : toFile(name, inflated.bytes, opts, state)
  // GNU writes what it inflated before the trouble it then reports. Where the
  // trouble is the check at the end of a member, it has already written the
  // bytes that failed it and this has not: a stream hands nothing over until
  // it is sure of it, so a file whose data is corrupt reports the same error
  // with nothing written before it.
  if (written && inflated.error) dataError(state, `${name}: ${inflated.error}`)
}

// GNU reads the two header bytes before anything else: a file with fewer than
// two is one it ran out of, and one whose two say something else is not a
// member at all. A file of text is neither, and only its first character can
// make it too short to tell.
function tooShort(bytes, path, ctx) {
  if (bytes !== undefined) return bytes.length < 2
  const text = ctx.fs.readFile(path)
  return text.length < 2 && encodeUtf8Loose(text).length < 2
}

// The two ways there is nothing to read: a runtime with no stream to inflate
// with, and a line that never waited for one.
function refuse(state) {
  state.gap ??= decompressionAvailable()
    ? unsupported('feature', 'gzip', 'synchronous decompression', 'gzip: decompressing a file is only supported by runAsync', 1)
    : unsupported('feature', 'gzip', 'decompression', 'gzip: this runtime cannot decompress: DecompressionStream is not available', 1)
}

const toStdout = (bytes, state) => { state.stdout += decodeUtf8(bytes); return true }

// Without `-c` the file is written beside the one it came from, which the
// overlay is the only place to do. The name it takes is the name it had with
// its suffix off, and a name with no suffix to take off is one GNU leaves
// alone rather than guessing a name for.
function toFile(name, bytes, opts, state) {
  const { ctx } = state
  const suffix = Object.keys(SUFFIXES).find((end) => name.length > end.length && name.endsWith(end))
  if (suffix === undefined) return fail(state, `${name}: unknown suffix -- ignored`, 2)
  const target = name.slice(0, -suffix.length) + SUFFIXES[suffix]
  if (lookupWithNote(ctx, 'gzip', target).error === null) return fail(state, `${target} already exists;\tnot overwritten`, 2)
  let handle
  try { handle = ctx.writable && ctx.fs.openWritable?.(ctx.cwd, target) } catch (e) { return fail(state, `${target}: ${e.message}`, 1) }
  if (!handle) {
    state.gap ??= unsupported('feature', 'gzip', 'read-only target', `gzip: ${target}: file system is read-only`, 1)
    return false
  }
  handle.writeBytes(bytes)
  // What was decompressed is gone once it has been, unless `-k` keeps it.
  if (!opts.keep) ctx.fs.removeWritable(ctx.cwd, name)
  return true
}

// What GNU says of data that is not what the header promised, which it writes
// a newline ahead of — where a file it could not open, or passed over, is
// reported as it stands.
const dataError = (state, message) => fail(state, message, 1, '\n')

function fail(state, message, status, lead = '') {
  state.stderr += `${lead}gzip: ${message}\n`
  // An error is worth reporting over a warning, as GNU reports it.
  state.status = state.status === 1 ? 1 : status
  return false
}
