// Compressing and decompressing is the runtime's work rather than this
// code's: `CompressionStream` and `DecompressionStream` do it, and both
// answer asynchronously where everything else here answers at once. So the
// command waits for them where it meets them, which is what an asynchronous
// `run` is for — nothing is worked out ahead of a line to spare it the wait,
// because a line that can wait has no need of that.
//
// Which formats those streams know is the runtime's business too, and it
// differs between them: gzip is everywhere they are, brotli only where it was
// added. So a format is asked for rather than assumed, and a command that
// cannot have one says so rather than guessing at the bytes.

// Nothing here reaches for a stream it has not first been told is there.
export function decompressionAvailable(format) {
  try { return typeof DecompressionStream === 'function' && Boolean(new DecompressionStream(format)) } catch { return false }
}
export function compressionAvailable(format) {
  try { return typeof CompressionStream === 'function' && Boolean(new CompressionStream(format)) } catch { return false }
}

// The bytes the stream gives back, and what stopped it where it stopped: what
// a tool makes of that — the words it uses, and whether it keeps what came
// before it — is the tool's own business, so both travel together.
async function through(stream, bytes) {
  const { readable, writable } = stream
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
  } catch (e) { error = e?.cause?.message ?? e?.message ?? 'corrupt input' }
  await written
  const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length }
  return { bytes: out, error }
}

export const decompressBytes = (bytes, format) => through(new DecompressionStream(format), bytes)

// Nothing is wrong with bytes to compress, whatever they are, so compressing
// answers with the stream alone.
export const compressBytes = async (bytes, format) => (await through(new CompressionStream(format), bytes)).bytes
