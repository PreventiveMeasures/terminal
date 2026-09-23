// An archive read the way GNU tar 1.35 opens one — from stdin or a file, and
// through gzip where it is compressed — and then read whole by
// @preventive/archive's tar reader, which is strict: an archive it will not
// read in full is one this terminal does not read at all, and says so.
//
// GNU looks at the first block before anything else. A tar header there is
// an archive; otherwise the first bytes may name a compressor, and a file
// (never stdin, which it asks to be told about) is run through it. Failing
// both, a name ending in a compressor's suffix is run through that one. A
// file shorter than a block is no archive at all, and GNU says so and goes
// on to read it anyway, which finds nothing.
//
// What gzip says of a stream reaches tar's run as it does GNU's: gzip's own
// words first, and then, once tar has read what it was handed, "Child
// returned status" as the fatal error it is. That is only answered where
// gzip certainly handed over what it handed over here: every member whole,
// or nothing at all. A stream damaged in the middle of a member leaves gzip
// writing out what it had inflated up to there, which the runtime's stream
// does not say, so the listing that would follow is refused rather than
// guessed at.

import { supports } from '@preventive/archive/compression.js'
import { ArchiveError, unpack } from '@preventive/archive/tar.js'
import { decompressMembers } from '../compression.js'
import { lookupWithNote } from '../notes.js'
import { consumeStdin, encodeUtf8, readBytesOf } from '../util.js'
import { gzipTrouble, looksCompressed } from './gzip.js'
import { tarHeaders } from './tar-headers.js'
import { quoteColon } from './tar-names.js'

const BLOCK = 512
const GZIP_HEADER = 10
// No entries at all, and the status gzip left.
const noEntries = (child) => ({ entries: [], child, warnings: [], mtimes: [] })

// The compressors GNU knows by their first bytes, and the option that asks
// for each (check_compressed_archive).
const MAGICS = [
  { bytes: [0x1f, 0x9d], option: '-Z' },
  { bytes: [0x1f, 0x8b], option: '-z' },
  { bytes: [0x42, 0x5a, 0x68], option: '-j' },
  { bytes: [0x4c, 0x5a, 0x49, 0x50], option: '--lzip' },
  { bytes: [0xff, 0x4c, 0x5a, 0x4d, 0x41, 0x00], option: '--lzma' },
  { bytes: [0x5d, 0x00, 0x00], option: '--lzma' },
  { bytes: [0x89, 0x4c, 0x5a, 0x4f], option: '--lzop' },
  { bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], option: '-J' },
  { bytes: [0x28, 0xb5, 0x2f, 0xfd], option: '--zstd' },
]
const magicOf = (data) => MAGICS.find(({ bytes }) => bytes.length <= data.length && bytes.every((byte, i) => data[i] === byte))

// And the suffixes it knows them by, after the last dot of the name.
const SUFFIXES = {
  __proto__: null,
  gz: '-z', tgz: '-z', taz: '-z', Z: '-Z', taZ: '-Z', bz2: '-j', tbz: '-j', tbz2: '-j', tz2: '-j',
  lz: '--lzip', lzma: '--lzma', tlz: '--lzma', lzo: '--lzop', xz: '-J', txz: '-J', zst: '--zstd', tzst: '--zstd',
}
export function suffixCompression(name) {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? undefined : SUFFIXES[name.slice(dot + 1)]
}

// A compressor other than gzip is a program GNU runs and this terminal has
// no stream for.
export function refuseCompression(state, option) {
  state.refuse('option', option, `${option}: archives compressed other than with gzip are not supported`)
  return null
}

// GNU reads `host:file` as an archive on another machine, unless a slash
// comes first.
export const remoteArchive = (name) => {
  const colon = name.indexOf(':')
  return colon !== -1 && !name.slice(0, colon).includes('/')
}

// Where the archive comes from: its bytes, and whether they came down stdin.
function openArchive(opts, state) {
  const { ctx } = state
  const name = opts.archive
  if (name === '-') {
    const bytes = ctx.stdinBytes ?? encodeUtf8(ctx.stdinLeft)
    // Taking the pipe is taking it: the next command finds it at its end.
    consumeStdin(ctx, '', true)
    return { bytes, name, stdin: true }
  }
  if (remoteArchive(name)) return state.refuse('feature', 'remote archive', `${name}: remote archives are not supported`)
  if (name === '/dev/null') return { bytes: new Uint8Array(), name, stdin: false }
  if (name.startsWith('/dev/')) return state.refuse('feature', 'special file', `${name}: reading an archive from a device is not supported`)
  const found = lookupWithNote(ctx, 'tar', name)
  if (found.error) return state.fatal(`${quoteColon(name, ctx)}: Cannot open: ${found.error}`)
  if (ctx.fs.isDir(found.path)) {
    state.warn(`${quoteColon(name, ctx)}: Cannot read: Is a directory`)
    return state.fatal('At beginning of tape, quitting now')
  }
  return { bytes: readBytesOf(ctx.fs, found.path), name, stdin: false }
}

// The entries of the archive `opts.archive` names, and the status gzip
// left, which the caller reports once it has done with them — or null,
// where the run has already ended.
export function readArchive(opts, state) {
  const source = openArchive(opts, state)
  if (!source) return null
  const data = source.bytes
  if (opts.gzip) return gunzipped(data, state)
  // A block's worth the reader takes is an archive, whatever its name says.
  const read = data.length >= BLOCK ? unpacked(data) : null
  if (read?.entries !== undefined) return named(read.entries, data, state, 0)
  const magic = magicOf(data)
  if (magic !== undefined) {
    if (source.stdin) return state.fatal(`Archive is compressed. Use ${magic.option} option`)
    return magic.option === '-z' ? gunzipped(data, state) : refuseCompression(state, magic.option)
  }
  const short = data.length < BLOCK
  if (short) state.error('This does not look like a tar archive')
  const suffix = source.stdin ? undefined : suffixCompression(source.name)
  if (suffix !== undefined && suffix !== '-z') return refuseCompression(state, suffix)
  if (short) return suffix === undefined ? noEntries(0) : gunzipped(data, state)
  // A block's worth that the reader refused may still open with a header
  // GNU would have taken, and then it never runs gzip over it at all.
  return refused(read.error, state)
}

// What gzip hands tar, and what it says of it.
async function gunzipped(data, state) {
  if (!supports('gzip')) return state.refuse('option', '-z', 'this runtime has no gzip stream')
  if (!looksCompressed(data)) {
    // gzip reads the two magic bytes before anything else.
    state.say(2, `\ngzip: stdin: ${data.length < 2 ? 'unexpected end of file' : 'not in gzip format'}\n`)
    return noEntries(1)
  }
  const inflated = await decompressMembers(data)
  const trouble = inflated.error === null ? null : gzipTrouble('stdin', inflated)
  if (trouble !== null && !trouble.whole && data.length > GZIP_HEADER) {
    state.refuse('feature', 'damaged gzip stream', 'the gzip stream is damaged, and how much of it GNU gzip would inflate is not known here')
    return null
  }
  if (trouble !== null) state.say(2, trouble.text)
  // Less than a block is the end of the archive to GNU when it arrives
  // through a pipe: nothing to read, and nothing wrong with that.
  const child = trouble?.status ?? 0
  if (inflated.bytes.length < BLOCK) return noEntries(child)
  const read = unpacked(inflated.bytes)
  return read.entries === undefined ? refused(read.error, state) : named(read.entries, inflated.bytes, state, child)
}

// The whole archive through the package's reader: its entries, or why it
// will not read them.
function unpacked(data) {
  try { return { entries: unpack(data) } } catch (error) {
    if (!(error instanceof ArchiveError)) throw error
    return { error }
  }
}

function refused(error, state) {
  state.refuse('feature', 'archive', `this archive is not one this terminal reads: ${error.message}`)
  return null
}

// The entries read, the status gzip left, and what the headers say of each
// entry that the package does not (see tar-headers.js); null where they say
// what this terminal cannot answer for, which ends the run.
function named(entries, data, state, child) {
  const read = tarHeaders(data, entries, (text) => quoteColon(text, state.ctx))
  if (read.gap === undefined) return { entries, child, ...read }
  state.refuse('feature', ...read.gap)
  return null
}
