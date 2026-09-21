import { parseArgs } from '../args.js'
import { encodeUtf8, readBytesOf } from '../util.js'
import { lookupWithNote } from '../notes.js'
import { unsupported } from '../unsupported.js'
import { compressBytes, decompressBytes, formatUsable } from '../compression.js'

// brotli, where the runtime's streams know the format. Everything gzip's
// command says about waiting holds here (../compression.js), and two things
// differ: brotli keeps the file it read unless told otherwise, and it stops
// at the first operand it could not do, where gzip takes them all.
//
// What it writes compressing is a brotli stream, which this terminal carries
// as a string only where those bytes spell text — usually they do not, so
// `-c` is usually the gap every byte output here is, and the file written
// beside the one it came from is what compressing is for.

const FORMAT = 'brotli'
const SUFFIX = '.br'
// Only where the runtime's streams know the format. gzip is everywhere they
// are; brotli is where it was added, and a terminal whose streams do not know
// it does not carry the command — the name is not found, as it was before.
export const BROTLI = formatUsable(FORMAT) ? { brotli } : {}
// The name brotli gives the input it did not open, which is the console's on
// the system it was first written for.
const STDIN = 'con'
const LEVELS = Object.freeze(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'])
// Writing to stdout takes one file, and brotli prints its usage over more
// than one rather than picking. What it prints after this line is its list of
// options, which this leaves out: most of them are options this command does
// not carry, and it will not offer what it would then refuse.
const USAGE = 'Usage: brotli [OPTION]... [FILE]...\n'

export async function brotli(stdin, tokens, ctx) {
  const { flags, values, positional } = parseArgs(tokens, {
    short: [...LEVELS, 'd', 'c', 'k', 'j', 'f', 'Z'],
    long: ['decompress', 'stdout', 'keep', 'rm', 'force', 'best'],
    valueShort: ['q'], valueLong: ['quality'],
  })
  // A stream compresses as hard as it compresses, and takes no instruction
  // about it: a level it would go on to ignore is not one to accept.
  const level = chosen(flags, values)
  if (level !== undefined) return unsupported('option', 'brotli', level, `brotli: ${level}: choosing a compression level is not supported`, 1)
  const opts = {
    decompressing: flags.has('d') || flags.has('decompress'),
    stdout: flags.has('c') || flags.has('stdout'),
    // Keeping is what brotli does anyway; `--rm` is what changes it.
    remove: flags.has('j') || flags.has('rm'),
    force: flags.has('f') || flags.has('force'),
  }
  if (opts.stdout && positional.length > 1) return { stdout: USAGE, stderr: '', exitCode: 1 }
  const state = { ctx, events: [], stderr: '', status: 0, gap: null }
  // A pipe is what it reads with no operand, and `-` is the same thing named.
  for (const name of positional.length === 0 ? ['-'] : positional) {
    // oxlint-disable-next-line no-await-in-loop -- brotli takes one operand after the last, and stops at the first it could not do.
    if (!await one(name, stdin, opts, state)) break
  }
  if (state.gap) return state.gap
  // What it wrote, in the order it wrote it: the bytes go to a pipe or a file
  // as they are, and to a terminal as the text they spell.
  const events = [...state.events, ...(state.stderr ? [{ fd: 2, text: state.stderr }] : [])]
  return { stdout: '', stderr: state.stderr, exitCode: state.status, events }
}

// However a level was asked for, named as it was written.
function chosen(flags, values) {
  const short = [...LEVELS, 'Z'].find((name) => flags.has(name))
  if (short !== undefined) return '-' + short
  if (flags.has('best')) return '--best'
  if (values.has('q')) return '-q'
  return values.has('quality') ? '--quality' : undefined
}

function one(name, stdin, opts, state) {
  const { ctx } = state
  // A pipe carries text unless a stage upstream wrote bytes into it, and a
  // brotli stream is bytes: `cat f.br | brotli -d` hands them over.
  if (name === '-') return through(ctx.stdinBytes ?? encodeUtf8(stdin), STDIN, null, opts, state)
  // The name it writes is the name it was given with the suffix on the end,
  // or with the suffix taken off — and a name too short to take one off of
  // has nothing left to be called.
  let target = null
  if (!opts.stdout) {
    if (!opts.decompressing) target = name + SUFFIX
    else if (name.length <= SUFFIX.length) return fail(state, `empty output file name for [${name}] input file`)
    else if (name.endsWith(SUFFIX)) target = name.slice(0, -SUFFIX.length)
    else return fail(state, `input file [${name}] suffix mismatch`)
  }
  const found = lookupWithNote(ctx, 'brotli', name)
  if (found.error) return fail(state, `failed to open input file [${name}]: ${found.error}`)
  // The output is opened before the input is read, which is where brotli
  // finds a name already taken.
  if (target !== null && !opts.force && lookupWithNote(ctx, 'brotli', target).error === null) {
    return fail(state, `failed to open output file [${target}]: File exists`)
  }
  if (ctx.fs.isDir(found.path)) return fail(state, `failed to read input [${name}]: Is a directory`)
  return through(readBytesOf(ctx.fs, found.path), name, target, opts, state)
}

// One file's worth of the work the runtime does, and what becomes of it.
async function through(bytes, name, target, opts, state) {
  const { ctx } = state
  const done = opts.decompressing ? await decompressBytes(bytes, FORMAT) : { bytes: await compressBytes(bytes, FORMAT), error: null }
  // Brotli hands over nothing it could not read to the end: a stream that
  // failed leaves the file it was writing unwritten, and says only that.
  if (done.error) return fail(state, `corrupt input [${name}]`)
  if (target === null) state.events.push({ fd: 1, bytes: done.bytes })
  else if (!toFile(target, done.bytes, state)) return false
  // What it read is kept, unless `--rm` says otherwise.
  if (opts.remove && name !== STDIN) ctx.fs.removeWritable(ctx.cwd, name)
  return true
}

// Beside the file it came from, which the overlay is the only place to do.
function toFile(target, bytes, state) {
  const { ctx } = state
  let handle
  try { handle = ctx.writable && ctx.fs.openWritable?.(ctx.cwd, target) } catch (e) { return fail(state, `failed to open output file [${target}]: ${e.message}`) }
  if (!handle) {
    state.gap ??= unsupported('feature', 'brotli', 'read-only target', `brotli: ${target}: file system is read-only`, 1)
    return false
  }
  handle.writeBytes(bytes)
  return true
}

// Brotli names what went wrong and nothing else — no command in front of it —
// and the first operand it could not do is the last one it looks at.
function fail(state, message) {
  state.stderr += `${message}\n`
  state.status = 1
  return false
}
