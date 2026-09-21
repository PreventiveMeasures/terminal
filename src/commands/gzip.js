import { parseArgs } from '../args.js'
import { decodeUtf8, encodeUtf8, encodeUtf8Loose, readBytesOf } from '../util.js'
import { lookupWithNote } from '../notes.js'
import { unsupported } from '../unsupported.js'
import { compressBytes, decompressBytes, formatUsable } from '../compression.js'

// gzip, both ways round. The work itself is the runtime's stream rather than
// this code's (../compression.js), and it answers asynchronously — so the
// command waits for it, which a line here can now do.
//
// What compressing writes is bytes, and this terminal carries a command's
// output as a string: no string spells a member, since the second byte of its
// header begins no character. So `-c` reports the gap every byte output here
// reports, and the file written beside the one it came from — which the
// overlay is the only place to write — is what compressing is for.

const FORMAT = 'gzip'

// Only where the runtime's streams know the format: a terminal whose streams
// do not is a terminal without the command, which is what it was before this
// one was written.
export const GZIP = formatUsable(FORMAT) ? { gzip } : {}

// A gzip member starts with these two, whatever follows.
const MAGIC = Object.freeze([0x1f, 0x8b])
const looksCompressed = (bytes) => bytes !== undefined && bytes.length >= 2 && bytes[0] === MAGIC[0] && bytes[1] === MAGIC[1]

// What zlib calls what it would not read, and what gzip says of it. Anything
// else is data that is not the deflate stream the header promised.
const REPORTS = { __proto__: null, 'unexpected end of file': 'unexpected end of file', 'incorrect data check': 'invalid compressed data--crc error' }
const reportOf = (error) => REPORTS[error] ?? 'invalid compressed data--format violated'

// The suffixes GNU knows. Decompressing takes one off to name the file it
// writes, and refuses a name it cannot shorten; compressing reads the same
// table the other way, and leaves a file already named as a member alone.
const SUFFIXES = Object.freeze({ __proto__: null, '.gz': '', '.tgz': '.tar', '.taz': '.tar', '-gz': '', '.z': '', '-z': '', '_z': '' })
const SUFFIX = '.gz'
const LEVELS = Object.freeze(['1', '2', '3', '4', '5', '6', '7', '8', '9'])

export async function gzip(stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, {
    short: [...LEVELS, 'd', 'c', 'k'],
    long: ['decompress', 'uncompress', 'stdout', 'to-stdout', 'keep'],
  })
  // A stream compresses as hard as it compresses, and takes no instruction
  // about it: a level it would go on to ignore is not one to accept.
  const level = LEVELS.find((name) => flags.has(name))
  if (level !== undefined) return unsupported('option', 'gzip', `-${level}`, `gzip: -${level}: choosing a compression level is not supported`, 1)
  const opts = {
    decompressing: ['d', 'decompress', 'uncompress'].some((name) => flags.has(name)),
    stdout: ['c', 'stdout', 'to-stdout'].some((name) => flags.has(name)),
    keep: flags.has('k') || flags.has('keep'),
  }
  const state = { ctx, stdout: '', stderr: '', status: 0, gap: null }
  if (positional.length === 0) await fromStdin(stdin, opts, state)
  // oxlint-disable-next-line no-await-in-loop -- one operand after the last, as gzip takes them.
  else for (const name of positional) await one(name, opts, state)
  if (state.gap) return state.gap
  return { stdout: state.stdout, stderr: state.stderr, exitCode: state.status }
}

// A pipe carries text, and no text spells a member — so decompressing one is
// read the way GNU reads a pipe carrying anything else, and always finds the
// same thing. Compressing one is the work itself, and then the output this
// terminal cannot carry.
async function fromStdin(stdin, opts, state) {
  if (opts.decompressing) return dataError(state, stdin === '' ? 'stdin: unexpected end of file' : 'stdin: not in gzip format')
  // A member of a pipe is the one GNU writes for a pipe: no name, and no
  // moment, because there was no file to take either from.
  return toStdout(await compressBytes(encodeUtf8(stdin), FORMAT), state)
}

function one(name, opts, state) {
  const { ctx } = state
  const found = lookupWithNote(ctx, 'gzip', name)
  if (found.error) return fail(state, `${name}: ${found.error}`, 1)
  if (ctx.fs.isDir(found.path)) return fail(state, `${name} is a directory -- ignored`, 2)
  return opts.decompressing ? decompress(name, found.path, opts, state) : compress(name, found.path, opts, state)
}

// The name it writes is the name it was given with a suffix on the end, and a
// name already carrying one is a file GNU says it is leaving alone — while
// making nothing of it: what it says there changes no status.
async function compress(name, path, opts, state) {
  const { ctx } = state
  const suffix = suffixOf(name)
  if (!opts.stdout && suffix !== undefined) return note(state, `${name} already has ${suffix} suffix -- unchanged`)
  const member = named(await compressBytes(readBytesOf(ctx.fs, path), FORMAT), name.slice(name.lastIndexOf('/') + 1), moment(ctx))
  return opts.stdout ? toStdout(member, state) : toFile(name + SUFFIX, member, name, opts, state)
}

// The tree has no clock of its own, so the moment it was made stands in — the
// same one `ls -l` dates every file in it to.
const moment = (ctx) => Math.floor(ctx.createdAt / 1000)

// GNU records where a member came from: the name the file had, without the
// directory it stood in, and the moment it carried. A stream writes neither —
// what it writes is the header of a member that came from no file, which is
// the very one GNU writes for a pipe. Everything past the header is the
// member's own and says nothing about either, so the name and the moment go
// in front of it. A header that is not the plain ten bytes is one this does
// not know how to add to, and it is left as the runtime wrote it.
const HEADER = 10, NAME_FLAG = 0x08
function named(member, name, modified) {
  const label = encodeUtf8(name)
  if (member.length < HEADER || member[3] !== 0 || label.includes(0)) return member
  const out = new Uint8Array(member.length + label.length + 1)
  out.set(member.subarray(0, HEADER))
  out[3] = NAME_FLAG
  for (let i = 0; i < 4; i++) out[4 + i] = modified >>> (8 * i) & 0xff
  out.set(label, HEADER)
  // The name is closed by the zero the array already holds there.
  out.set(member.subarray(HEADER), HEADER + label.length + 1)
  return out
}

async function decompress(name, path, opts, state) {
  const { ctx } = state
  // Only a file held as bytes can be a member: no text spells one, since the
  // second byte of the header begins no character. Asking costs nothing,
  // where reading a file to look at its first two bytes would.
  const bytes = ctx.fs.isBytes?.(path) === true ? readBytesOf(ctx.fs, path) : undefined
  if (!looksCompressed(bytes)) return dataError(state, `${name}: ${tooShort(bytes, path, ctx) ? 'unexpected end of file' : 'not in gzip format'}`)
  const inflated = await decompressBytes(bytes, FORMAT)
  const suffix = suffixOf(name)
  const written = opts.stdout ? toStdout(inflated.bytes, state)
    : suffix === undefined ? fail(state, `${name}: unknown suffix -- ignored`, 2)
      : toFile(name.slice(0, -suffix.length) + SUFFIXES[suffix], inflated.bytes, name, opts, state)
  // GNU writes what it inflated before the trouble it then reports. Where the
  // trouble is the check at the end of a member, it has already written the
  // bytes that failed it and this has not: a stream hands nothing over until
  // it is sure of it, so a file whose data is corrupt reports the same error
  // with nothing written before it.
  if (written && inflated.error) dataError(state, `${name}: ${reportOf(inflated.error)}`)
}

const suffixOf = (name) => Object.keys(SUFFIXES).find((end) => name.length > end.length && name.endsWith(end))

// GNU reads the two header bytes before anything else: a file with fewer than
// two is one it ran out of, and one whose two say something else is not a
// member at all. A file of text is neither, and only its first character can
// make it too short to tell.
function tooShort(bytes, path, ctx) {
  if (bytes !== undefined) return bytes.length < 2
  const text = ctx.fs.readFile(path)
  return text.length < 2 && encodeUtf8Loose(text).length < 2
}

const toStdout = (bytes, state) => { state.stdout += decodeUtf8(bytes); return true }

// Beside the file it came from, which the overlay is the only place to do.
function toFile(target, bytes, source, opts, state) {
  const { ctx } = state
  if (lookupWithNote(ctx, 'gzip', target).error === null) return fail(state, `${target} already exists;\tnot overwritten`, 2)
  let handle
  try { handle = ctx.writable && ctx.fs.openWritable?.(ctx.cwd, target) } catch (e) { return fail(state, `${target}: ${e.message}`, 1) }
  if (!handle) {
    state.gap ??= unsupported('feature', 'gzip', 'read-only target', `gzip: ${target}: file system is read-only`, 1)
    return false
  }
  handle.writeBytes(bytes)
  // What was compressed, or decompressed, is gone once it has been, unless
  // `-k` keeps it.
  if (!opts.keep) ctx.fs.removeWritable(ctx.cwd, source)
  return true
}

// What GNU says of data that is not what the header promised, which it writes
// a newline ahead of — where a file it could not open, or passed over, is
// reported as it stands, and a file it is leaving alone is reported without
// being made anything of.
const dataError = (state, message) => fail(state, message, 1, '\n')
const note = (state, message) => fail(state, message, state.status)

function fail(state, message, status, lead = '') {
  state.stderr += `${lead}gzip: ${message}\n`
  // An error is worth reporting over a warning, as GNU reports it.
  state.status = state.status === 1 ? 1 : status
  return false
}
