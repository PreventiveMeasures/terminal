// Deflating and inflating a gzip member is the runtime's work rather than
// this code's: `CompressionStream` and `DecompressionStream` do it, and both
// answer asynchronously where everything else here answers at once. So the
// command waits for them where it meets them, which is what an asynchronous
// `run` is for — nothing is worked out ahead of a line to spare it the wait,
// because a line that can wait has no need of that.

import { encodeUtf8 } from './util.js'

// A gzip member starts with these two, whatever follows.
const MAGIC = Object.freeze([0x1f, 0x8b])
export const looksCompressed = (bytes) => bytes !== undefined && bytes.length >= 2 && bytes[0] === MAGIC[0] && bytes[1] === MAGIC[1]

// A runtime without the stream, or without the format, does neither of these,
// and the command says so rather than guessing at the bytes. Nothing here
// reaches for a stream it has not first been told is there.
export function decompressionAvailable() {
  try { return typeof DecompressionStream === 'function' && Boolean(new DecompressionStream('gzip')) } catch { return false }
}
export function compressionAvailable() {
  try { return typeof CompressionStream === 'function' && Boolean(new CompressionStream('gzip')) } catch { return false }
}

// What zlib calls it, and what gzip says of it. Anything else it refuses to
// read is data that is not the deflate stream the header promised.
const REPORTS = { __proto__: null, 'unexpected end of file': 'unexpected end of file', 'incorrect data check': 'invalid compressed data--crc error' }
const reportOf = (e) => REPORTS[e?.cause?.message ?? e?.message] ?? 'invalid compressed data--format violated'

// The bytes the stream gives back, and what stopped it where it stopped: gzip
// writes what it managed to inflate before the trouble it then reports, so
// both travel together.
async function through({ readable, writable }, bytes) {
  const writer = writable.getWriter()
  // The write is not waited for until the read is done, or a stream of more
  // than one chunk would wait on itself; what it fails at, the reader reports.
  const written = (async () => { try { await writer.write(bytes); await writer.close() } catch { /* the reader has it */ } })()
  const reader = readable.getReader()
  const chunks = []
  let error = null
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- a stream hands over one chunk after the last.
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
  } catch (e) { error = reportOf(e) }
  await written
  const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length }
  return { bytes: out, error }
}

export const inflate = (bytes) => through(new DecompressionStream('gzip'), bytes)

// Nothing is wrong with bytes to compress, whatever they are, so deflating
// answers with the member alone.
export const deflate = async (bytes) => (await through(new CompressionStream('gzip'), bytes)).bytes

// GNU records where a member came from: the name the file had, without the
// directory it stood in, and the moment it carried. A stream writes neither —
// what it writes is the header of a member that came from no file, which is
// the very one GNU writes for a pipe. Everything past the header is the
// member's own and says nothing about either, so the name and the moment go
// in front of it. A header that is not the plain ten bytes is one this does
// not know how to add to, and it is left as the runtime wrote it.
const HEADER = 10, NAME_FLAG = 0x08
export function named(member, name, modified) {
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
