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
function decompressionAvailable(format) {
  try { return typeof DecompressionStream === 'function' && Boolean(new DecompressionStream(format)) } catch { return false }
}
function compressionAvailable(format) {
  try { return typeof CompressionStream === 'function' && Boolean(new CompressionStream(format)) } catch { return false }
}

// Whether a command for this format belongs in the registry at all. A tool
// that could neither compress nor decompress is no tool, so a terminal whose
// streams do not know the format does not carry it: the name is not found,
// which is what it was before the command was written. Asked once, when the
// registry is built — a runtime does not learn a format later.
export const formatUsable = (format) => decompressionAvailable(format) && compressionAvailable(format)

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

// A gzip stream is members one after another, and what follows the last of
// them is gzip's business rather than the runtime's: the stream reads those
// bytes as another member's header, fails on them, and hands back neither
// them nor what it had already read. gzip keeps what the members held and
// says what it made of the rest, so the members are found here by asking
// which of the input's ends decompresses whole.
//
// The asking is cheap because the format says where a member may end: the
// four bytes before its end count what that member held, which is no more
// than deflate could have packed into everything ahead of it. Ends whose
// count says otherwise are not tried at all, and little else survives — the
// count is four bytes of whatever the garbage is, and the bound is tight for
// all but a very long input. Each end that does survive is decompressed whole
// before it is believed, so nothing answered here was guessed at; the looking
// stops once it has read a few times the input over, an input that buries its
// members deeper than that being one this leaves as the stream left it.
const LEAST = 18 // a ten-byte header, a byte of deflate, an eight-byte trailer
const RATIO = 1032 // the most a byte of deflate can hold
const ZEROS = 16 // the zero bytes a member can end with, trailer and all
const BUDGET = 1 << 20
const heldAt = (bytes, at) => bytes[at] + bytes[at + 1] * 0x100 + bytes[at + 2] * 0x10000 + bytes[at + 3] * 0x1000000

async function wholeAt(bytes, format, end) {
  const read = await through(new DecompressionStream(format), bytes.subarray(0, end))
  return read.error === null ? { bytes: read.bytes, rest: bytes.subarray(end) } : null
}

async function lastWholeMember(bytes, format) {
  // gzip passes over a tail of zero bytes without a word, that being a block
  // device's padding rather than anything it was meant to read. A member ends
  // in zeros of its own — the high bytes of its length, and the last of the
  // block before them — so where there is such a tail the member ends a byte
  // or two into it, and those ends are tried from the near side first.
  let pad = bytes.length
  while (pad > 0 && bytes[pad - 1] === 0) pad--
  const state = { budget: Math.max(BUDGET, bytes.length * 8) }
  const near = await scan(bytes, format, state, Math.max(pad, LEAST), Math.min(bytes.length - 1, pad + ZEROS), 1)
  return near ?? await scan(bytes, format, state, Math.min(bytes.length - 1, pad - 1), LEAST, -1)
}

async function scan(bytes, format, state, from, to, step) {
  for (let end = from; step * (to - end) >= 0 && end <= state.budget; end += step) {
    if (heldAt(bytes, end - 4) > RATIO * end) continue
    state.budget -= end
    // oxlint-disable-next-line no-await-in-loop -- one end after another, and the first that comes back whole is the answer.
    const found = await wholeAt(bytes, format, end)
    if (found) return found
  }
  return null
}

// What came out whole, what stopped the stream, and what was left over after
// the members it did read. An input the stream read to the end left nothing
// over and nothing stopped it; one with no whole member in it is answered as
// it was before, with the bytes the stream managed and what it ran into.
export async function decompressMembers(bytes, format) {
  const read = await through(new DecompressionStream(format), bytes)
  if (read.error === null) return { ...read, rest: null }
  const whole = await lastWholeMember(bytes, format)
  return whole === null ? { ...read, rest: null } : { ...whole, error: read.error }
}

// Nothing is wrong with bytes to compress, whatever they are, so compressing
// answers with the stream alone.
export const compressBytes = async (bytes, format) => (await through(new CompressionStream(format), bytes)).bytes
