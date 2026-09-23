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

// What came out whole, what stopped the stream, and what was left over after
// the members it did read. An input the stream read to the end left nothing
// over and nothing stopped it; one whose members do not account for it short
// of the end is answered as it was before, with the bytes the stream managed
// and what it ran into.
export async function decompressMembers(bytes) {
  const read = await decompressBytes(bytes, GZIP)
  if (read.error === null || !supports(RAW)) return { ...read, rest: null }
  const parts = []
  let at = 0
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one member after the last, as a stream carries them.
    const member = await memberAt(bytes, at)
    if (member === null) break
    parts.push(member.bytes)
    at = member.end
  }
  if (at === 0 || at === bytes.length) return { ...read, rest: null }
  return { bytes: joinBytes(parts), error: read.error, rest: bytes.subarray(at) }
}
