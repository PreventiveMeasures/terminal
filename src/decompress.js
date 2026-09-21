// Inflating a compressed file is the one thing here a runtime does rather
// than this code: `DecompressionStream` answers asynchronously, and a line
// runs synchronously from end to end. So the work happens before the line
// does, on `runAsync` — the only entry point that can wait — and the command
// reads the answer back out of what was inflated.
//
// Nothing is lost by doing it early. A pipe and a redirect carry text here,
// and no text spells a gzip member: its second header byte begins no
// character at all. Compressed bytes reach a command from a file the
// filesystem holds and from nowhere else, so what a line could inflate is
// what the tree already held when the line started.

import { sameBytes, walkTree } from './fs.js'

// A gzip member starts with these two, whatever follows.
const MAGIC = Object.freeze([0x1f, 0x8b])
export const looksCompressed = (bytes) => bytes !== undefined && bytes.length >= 2 && bytes[0] === MAGIC[0] && bytes[1] === MAGIC[1]

// A runtime without the stream, or without the format, inflates nothing, and
// the command says so rather than guessing at the bytes.
export function decompressionAvailable() {
  try { return typeof DecompressionStream === 'function' && Boolean(new DecompressionStream('gzip')) } catch { return false }
}

// What zlib calls it, and what gzip says of it. Anything else it refuses to
// read is data that is not the deflate stream the header promised.
const REPORTS = { __proto__: null, 'unexpected end of file': 'unexpected end of file', 'incorrect data check': 'invalid compressed data--crc error' }
const reportOf = (e) => REPORTS[e?.cause?.message ?? e?.message] ?? 'invalid compressed data--format violated'

// The bytes the stream gives back, and what stopped it where it stopped: gzip
// writes what it managed to inflate before the trouble it then reports, so
// both travel together.
async function inflate(bytes) {
  const { readable, writable } = new DecompressionStream('gzip')
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
  const inflated = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) { inflated.set(chunk, at); at += chunk.length }
  return { bytes: inflated, error }
}

// Everything the tree holds that begins as a gzip member does, inflated and
// kept by the bytes it was inflated from. Only a line that names the command
// pays for the walk at all, and a line pays for nothing already inflated —
// which is most of them, since a file's bytes do not change under it.
export async function warmDecompression(line, ctx) {
  if (!/gzip/u.test(line) || !decompressionAvailable()) return
  const pending = []
  for (const entry of walkTree(ctx.fs, '/')) {
    if (entry.kind !== 'file' || ctx.fs.isBytes?.(entry.path) !== true) continue
    const bytes = ctx.fs.readBytes(entry.path)
    if (!looksCompressed(bytes) || decompressionOf(ctx, bytes) !== undefined) continue
    pending.push(inflate(bytes).then((inflated) => bucketOf(ctx, bytes.length).push({ compressed: bytes, inflated })))
  }
  await Promise.all(pending)
}

// Kept by content rather than by the array holding it: a copy of a file is the
// same member, and a copy is what the overlay makes of anything written into
// it, so `cp f.gz /tmp/ && gzip -d /tmp/f.gz` reads the answer its original
// already has. Length sorts them and a comparison settles them, so no two
// files are ever taken for one.
const bucketOf = (ctx, length) => {
  let bucket = ctx.decompressed.get(length)
  if (bucket === undefined) ctx.decompressed.set(length, bucket = [])
  return bucket
}

// What was inflated of these bytes, or nothing where nothing was: a line that
// never waited for the work has nothing to read, which is the gap the command
// reports rather than an answer it does not have.
export function decompressionOf(ctx, bytes) {
  const kept = ctx.decompressed?.get(bytes.length) ?? []
  return kept.find(({ compressed }) => sameBytes(compressed, bytes))?.inflated
}
