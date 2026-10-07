// Compressing and decompressing is the runtime's work rather than this
// code's: `CompressionStream` and `DecompressionStream` do it, and both
// answer asynchronously where everything else here answers at once. So the
// command waits for them where it meets them, which is what an asynchronous
// `run` is for — nothing is worked out ahead of a line to spare it the wait,
// because a line that can wait has no need of that.
//
// Reaching those streams is @preventive/archive's work, the same code its
// zip half deflates through: its compression.js puts bytes through one whole,
// says whether a runtime's streams know a format both ways, and keeps what
// came out before a failure on the error it throws. Which formats they know
// is the runtime's business, and it differs between them: gzip is everywhere
// they are, brotli only where it was added. So a format is asked for rather
// than assumed, and a command that cannot have one says so rather than
// guessing at the bytes. What is left here is what a command makes of a
// failure, and the members of a gzip stream, which no stream tells apart.

import { CompressionError, decompress, supports } from '@preventive/archive/compression.js'
import { crc32 } from '@exodus/bytes/crc.js'
import { joinBytes } from './bytes.js'

// The bytes the stream gave back, and what stopped it where it stopped: what
// a tool makes of that — the words it uses, and whether it keeps what came
// before it — is the tool's own business, so both travel together. The word
// is the platform's: Node's stream error carries zlib's under it, and names
// a raw stream's trailing bytes itself.
export async function decompressBytes(bytes, format) {
  try { return { bytes: await decompress(bytes, format), error: null } } catch (error) {
    if (!(error instanceof CompressionError)) throw error
    return { bytes: error.bytes, error: error.cause?.cause?.message ?? error.cause?.message ?? 'corrupt input' }
  }
}

// A gzip stream is members one after another, and what follows the last of
// them is gzip's business rather than the runtime's: the stream reads those
// bytes as another member's header, fails on them, and hands back neither
// them nor what it had already read. gzip keeps what the members held and
// says what it made of the rest, so the members are taken apart here.
//
// Where a member ends is not something a runtime's stream will say, but the
// member says it itself. Its header is ten bytes and whatever its flags call
// for after them; its data is a raw deflate stream, which `deflate-raw` reads
// to its own end and hands over whole, minding nothing that follows it; and
// the four bytes before a member's end count what that member held. So the
// data is inflated on its own to learn that count, and the end is where the
// input spells it — one place in four thousand million, whatever the rest of
// the input is and however much of it there is. Each end so found is
// decompressed as the member it claims to be before a byte of it is answered
// with, so nothing here was guessed at.
const HEADER = 10 // a member's header before its flags add to it
const TRAILER = 8 // the check and the count that close one
const DEFLATE = 8 // the method every member is written with
const FCOMMENT = 0x10, FEXTRA = 0x04, FHCRC = 0x02, FNAME = 0x08
const GZIP = 'gzip', RAW = 'deflate-raw'
const heldAt = (bytes, at) => bytes[at] + bytes[at + 1] * 0x100 + bytes[at + 2] * 0x10000 + bytes[at + 3] * 0x1000000

// How far a member's header reaches. One that runs past the end of what there
// is, or that names a method no member is written with, is not one to read.
function headerLength(bytes, at) {
  if (bytes[at] !== 0x1f || bytes[at + 1] !== 0x8b || bytes[at + 2] !== DEFLATE) return -1
  const flags = bytes[at + 3]
  let cursor = at + HEADER
  if ((flags & FEXTRA) !== 0) {
    if (cursor + 2 > bytes.length) return -1
    cursor += 2 + bytes[cursor] + bytes[cursor + 1] * 0x100
  }
  // The name and the comment are each closed by a zero, in that order.
  for (const flag of [FNAME, FCOMMENT]) {
    if ((flags & flag) === 0) continue
    while (cursor < bytes.length && bytes[cursor] !== 0) cursor++
    cursor++
  }
  if ((flags & FHCRC) !== 0) cursor += 2
  return cursor <= bytes.length ? cursor - at : -1
}

// The member beginning at `at`, and where it ends, or nothing where the bytes
// there are no whole member. An end ahead of the real one has to spell the
// same count in four bytes to be tried at all, which no run of data does; a
// run of zeros spells nought, so a member whose data held nothing — or was
// never data — is given up on after a few rather than followed to the end of
// the input, there being no end of its own to find either way.
const TRIES = 64
async function memberAt(bytes, at) {
  const head = headerLength(bytes, at)
  if (head < 0) return null
  const raw = await decompressBytes(bytes.subarray(at + head), RAW)
  // Whatever stopped the raw stream stopped it past what this member held —
  // that is the trailer and what follows, which are no part of the data — so
  // the count stands or no end will match it.
  const held = raw.bytes.length % 0x100000000
  let tries = TRIES
  for (let end = at + head + TRAILER; end <= bytes.length && tries > 0; end++) {
    if (heldAt(bytes, end - 4) !== held) continue
    tries--
    // oxlint-disable-next-line no-await-in-loop -- all but one end in four thousand million is ruled out before this.
    const member = await decompressBytes(bytes.subarray(at, end), GZIP)
    if (member.error === null) return { bytes: member.bytes, end }
  }
  return null
}

// What GNU's gzip makes of a member's header, read in its own order: a method
// it does not know, a member encrypted or carrying flags it does not know, and
// a header whose own check fails are each its refusal as it comes to them, and
// input that ends first is input it ran out of. Otherwise the header's length.
const ENCRYPTED = 0x20, RESERVED = 0xc0
const RAN_OUT = Object.freeze({ trouble: Object.freeze(['eof']) })
function headerOf(bytes, at) {
  const end = bytes.length
  if (at + 3 > end) return RAN_OUT
  if (bytes[at + 2] !== DEFLATE) return { trouble: ['method', bytes[at + 2]] }
  if (at + 4 > end) return RAN_OUT
  const flags = bytes[at + 3]
  if ((flags & ENCRYPTED) !== 0) return { trouble: ['encrypted'] }
  if ((flags & RESERVED) !== 0) return { trouble: ['flags', flags] }
  const length = headerLength(bytes, at)
  if (length < 0) return RAN_OUT
  if ((flags & FHCRC) === 0) return { length }
  // The check is the low half of the CRC-32 of every header byte before it.
  const sum = at + length - 2
  const computed = crc32(bytes.subarray(at, sum)) & 0xffff, stored = bytes[sum] + bytes[sum + 1] * 0x100
  return stored === computed ? { length } : { trouble: ['checksum', stored, computed] }
}

// Where the deflate data from `from` ends, which no stream says: the shortest
// run of the input it does not run out of, found by halving. The end found is
// only answered with where the data up to it inflates cleanly, so a runtime
// whose stream words running out otherwise finds none rather than a wrong one.
const RUNS_OUT = 'unexpected end of file'
async function dataEnd(bytes, from) {
  let enough = bytes.length, short = from
  while (enough - short > 1) {
    const middle = Math.floor((short + enough) / 2)
    // oxlint-disable-next-line no-await-in-loop -- each half is chosen by the answer before it.
    const tried = await decompressBytes(bytes.subarray(from, middle), RAW)
    if (tried.error === RUNS_OUT) short = middle
    else enough = middle
  }
  const data = await decompressBytes(bytes.subarray(from, enough), RAW)
  return data.error === null ? { bytes: data.bytes, end: enough } : null
}

// What GNU makes of a member the stream would not read whole. Its header is
// read first, and what GNU refuses there is refused before a byte of the
// member is written. Past it, GNU writes what it inflates as it goes, and only
// then reads the eight bytes that close the member: data that ran out is
// written as far as it went, and a check or a count that disagrees with what
// was written is said once it has been. Data that is not deflate at all is
// left to the word the stream had for it. A member whose eight bytes do agree
// was whole after all, which a run of tries can miss, and is read on from.
async function brokenMember(bytes, at) {
  const header = headerOf(bytes, at)
  if (header.trouble) return { bytes: null, trouble: { header: header.trouble } }
  const from = at + header.length
  const raw = await decompressBytes(bytes.subarray(from), RAW)
  if (raw.error === RUNS_OUT) return { bytes: raw.bytes, trouble: { eof: true } }
  const data = raw.error === null ? { bytes: raw.bytes, end: bytes.length } : await dataEnd(bytes, from)
  if (data === null) return { bytes: null, trouble: null, error: raw.error }
  if (data.end + TRAILER > bytes.length) return { bytes: data.bytes, trouble: { eof: true } }
  const crc = crc32(data.bytes) !== heldAt(bytes, data.end)
  const length = data.bytes.length % 0x100000000 !== heldAt(bytes, data.end + 4)
  if (!crc && !length) return { bytes: data.bytes, trouble: null, end: data.end + TRAILER }
  return { bytes: data.bytes, trouble: { crc, length } }
}

// What came out, what stopped the stream, what was left over after the
// members it did read, and what GNU would make of the first of them that is
// not whole. An input the stream read to the end left nothing over and
// nothing stopped it. Otherwise the bytes are the members that were whole and
// whatever of the next GNU writes before it reports it — `trouble` says what
// it reports; bytes after the last member that begin none are `rest` alone,
// which is gzip's to answer as trailing garbage or padding.
export async function decompressMembers(bytes) {
  const read = await decompressBytes(bytes, GZIP)
  if (read.error === null || !supports(RAW)) return { ...read, rest: null, trouble: null }
  const parts = []
  let at = 0
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one member after the last, as a stream carries them.
    const member = await memberAt(bytes, at) ?? await brokenAt(bytes, at)
    if (member === null || member.end === undefined) {
      if (at === bytes.length) return { ...read, rest: null, trouble: null }
      if (member?.bytes) parts.push(member.bytes)
      return { bytes: joinBytes(parts), error: member?.error ?? read.error, rest: bytes.subarray(at), trouble: member?.trouble ?? null }
    }
    parts.push(member.bytes)
    at = member.end
  }
}

// Only bytes that open a member are one to make anything of: what follows the
// last of them otherwise is not a member at all.
const brokenAt = (bytes, at) => bytes.length - at >= 2 && bytes[at] === 0x1f && bytes[at + 1] === 0x8b ? brokenMember(bytes, at) : null
