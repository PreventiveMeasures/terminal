// Dump readers open operands lazily: a byte limit must neither consume the
// next reader's input nor report errors from files it never opens.
import { consumeStdin, decodeUtf8, decodeUtf8Maybe, encodeUtf8Loose, err, readInputs } from '../util.js'
import { UINT64_MAX } from '../numeric.js'
import { unsupported } from '../unsupported.js'

const EMPTY = new Uint8Array()
// What glibc's stdio reads of a file at a time: its block size, on ext4.
const STDIO_BLOCK = 4096

export function dumpInput(cmd, files, stdin, ctx, opt) {
  const skip = dumpCount(cmd, opt.skip, opt.skipFlag, 0)
  const len = dumpCount(cmd, opt.len, opt.lenFlag, Number.POSITIVE_INFINITY)
  if (skip.error || len.error) return { error: skip.error ?? len.error }
  // hexdump asked for nothing opens nothing, and so finds nothing missing.
  if (cmd === 'hexdump' && len.value === 0) return { bytes: EMPTY, start: 0, r: { stderr: '', failed: false }, opened: true }
  let remaining = len.value
  let skipping = skip.value
  let start = 0
  let rest = stdin
  // The bytes a pipe carried, held before the first read takes them: what a
  // reader stops short of is handed back as the bytes it stopped short of,
  // rather than as the text they would spell, which for a dump is the point.
  const piped = ctx.stdinBytes
  const chunks = []
  const r = { stderr: '', failed: false }
  // Whether any input opened at all, a directory included, which od needs to
  // print an end offset and hexdump to have read anything.
  let opened = files.length === 0
  for (const file of files.length ? files : [null]) {
    // A dump is the bytes themselves, so a file this terminal cannot spell as
    // text is dumped as readily as one it can.
    const input = readInputs(cmd, file === null ? [] : [file], rest, ctx, { read: 'loose-bytes', noRead: remaining === 0 && skipping === 0 })
    const isDir = input.entries[0]?.kind === 'dir'
    r.stderr += input.stderr
    r.failed ||= input.failed && !(cmd === 'hexdump' && isDir)
    if (skipping && isDir) return { error: unsupported('feature', cmd, 'skip across unreadable input', `${cmd}: skipping across a directory operand is not supported`) }
    if (isDir && cmd === 'xxd') return { error: err('xxd: Is a directory', 2) }
    if (!input.inputs.length && !isDir) continue
    opened = true
    const entry = input.inputs[0]
    const shared = entry && (entry.shared || entry.name === null)
    if (cmd === 'hexdump' && skipping && shared && !ctx.stdinFile) {
      consumeStdin(ctx, rest, true, piped)
      return { error: err('hexdump: stdin: Illegal seek') }
    }
    // xxd seeks from the beginning unless +OFFSET was specified. Linux
    // hexdump also uses SEEK_SET for a nonzero skip; od skips from here.
    const rewind = shared && ctx.stdinFile && opt.skip !== undefined && (cmd === 'xxd' || (cmd === 'hexdump' && skip.value > 0))
    const all = rewind ? encodeUtf8Loose(ctx.stdinOrigin) : entry?.bytes ?? EMPTY
    const skipped = Math.min(skipping, all.length)
    skipping -= skipped; start += skipped
    const taken = Math.min(remaining, all.length - skipped)
    chunks.push(all.subarray(skipped, skipped + taken))
    remaining -= taken
    if (shared) {
      // xxd reads through stdio a block at a time and gives back nothing it
      // read ahead of what it needed, where hexdump and od leave a file where
      // they stopped: the next reader of the same file starts at the end of
      // the last block xxd read. (A pipe is left as it is read here.)
      const end = cmd === 'xxd' && ctx.stdinFile ? Math.min(all.length, skipped + Math.ceil(taken / STDIO_BLOCK) * STDIO_BLOCK) : skipped + taken
      const left = all.subarray(end)
      // Bytes came in, so bytes are what is left: handed back as they are,
      // and as the text they spell for a reader of text, which may be none.
      // Where text came in, text is what is left — and a read that stopped
      // inside a character has half of one to hand on, which is the same
      // limitation it was before any input here was bytes.
      const handed = piped !== null && !rewind && left.length > 0 ? left : null
      rest = handed === null ? decodeUtf8(left) : decodeUtf8Maybe(left) ?? ''
      consumeStdin(ctx, rest, true, handed)
    }
    if (rewind && skipping) { start = skip.value; skipping = 0 }
    if (remaining === 0 && skipping === 0) break
  }
  // od skips through what it opened, and with nothing opened has nothing to
  // have skipped past the end of.
  if (skipping && opt.skipPastEofErrors && opened) return { error: err(r.stderr + `${cmd}: cannot skip past end of combined input`) }
  // hexdump goes on to stdin where no operand opened, which a failed reopen
  // has closed: it says so where it has a skip to make there, and that every
  // operand failed otherwise.
  if (cmd === 'hexdump' && !opened) r.stderr += skip.value > 0 ? 'hexdump: stdin: Bad file descriptor\n' : 'hexdump: all input file arguments failed\n'
  const bytes = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return { bytes, start, r, opened }
}

function dumpCount(cmd, value, flag, fallback) {
  if (value === undefined) return { value: fallback }
  // xxd accepts partial strtol inputs and relative/end-relative seeks. Reject
  // those explicitly instead of silently treating an octal offset as decimal.
  if (cmd === 'xxd' && (!/^(?:0[xX][\da-fA-F]+|0[0-7]*|[1-9]\d*)$/u.test(value))) {
    return { error: unsupported('feature', cmd, `${flag} ${value}`, `xxd: this offset/count spelling is not supported: ${value}`) }
  }
  return cmd === 'hexdump' ? hexdumpSize(value, flag) : odCount(value, flag)
}

// A number as C reads one in any base it spells: 0x for hex, 0 for octal,
// after blanks and a plus sign; and what follows it.
const NUMBER = /^[ \t\n\r\v\f]*\+?(?:(0[xX][\da-fA-F]+)|(0[0-7]*)|([1-9]\d*))?([\s\S]*)$/u
const NEGATIVE = /^[ \t\n\r\v\f]*-/u
function leading(value) {
  const [, hex, octal, decimal, rest] = NUMBER.exec(value)
  if (hex !== undefined) return { n: BigInt(hex), rest }
  if (octal !== undefined) return { n: BigInt('0o' + (octal.slice(1) || '0')), rest }
  return { n: decimal === undefined ? null : BigInt(decimal), rest }
}

// util-linux's strtosize: a power of 1024 for each of KMGTPEZY after the
// number, of 1000 where B follows the letter, and never a minus sign. What
// it will not read it names with the word for what the number was.
const SIZE_WORDS = { '-n': 'length', '-s': 'offset' }
function hexdumpSize(value, flag) {
  const failed = (why) => ({ error: err(`hexdump: failed to parse ${SIZE_WORDS[flag]}: '${value}': ${why}`) })
  const { n, rest } = leading(value)
  if (NEGATIVE.test(value) || n === null) return failed('Invalid argument')
  let size = n
  if (rest !== '') {
    // A fraction before the letter is read in the locale's own way.
    if (rest[0] === '.') return { error: unsupported('feature', 'hexdump', `${flag} ${value}`, `hexdump: this offset/count spelling is not supported: ${value}`) }
    const power = 'KMGTPEZY'.indexOf(rest[0].toUpperCase()) + 1
    const base = /^.i[Bb]$/u.test(rest) ? 1024n : /^.[Bb]$/u.test(rest) ? 1000n : rest.length === 1 ? 1024n : null
    if (power === 0 || !/[a-zA-Z]/u.test(rest[0]) || base === null) return failed('Invalid argument')
    size *= base ** BigInt(power)
  }
  if (size > UINT64_MAX) return failed('Numerical result out of range')
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) return { error: unsupported('feature', 'hexdump', 'large byte count', 'hexdump: counts beyond exact integer precision are not supported') }
  return { value: Number(size) }
}

// coreutils' xstrtoumax over od's suffixes: b for 512, and a power of 1024
// for each of the others — of 1000 where B or D follows, or iB for 1024 again.
// A suffix alone counts one of itself; a minus sign is no count at all.
const OD_SUFFIXES = 'bEGKkMmPQRTYZ'
const OD_POWERS = { __proto__: null, k: 1, K: 1, m: 2, M: 2, G: 3, T: 4, P: 5, E: 6, Z: 7, Y: 8, R: 9, Q: 10 }
function odCount(value, flag) {
  const invalid = () => ({ error: err(`od: invalid ${flag} argument '${value}'`) })
  const badSuffix = () => ({ error: err(`od: invalid suffix in ${flag} argument '${value}'`) })
  if (NEGATIVE.test(value)) return invalid()
  let { n, rest } = leading(value)
  if (n === null) {
    if (value === '' || !OD_SUFFIXES.includes(value[0])) return invalid()
    n = 1n
    rest = value
  }
  if (rest !== '') {
    if (!OD_SUFFIXES.includes(rest[0])) return badSuffix()
    let base = 1024n, used = 1
    if (rest[1] === 'i' && rest[2] === 'B') used += 2
    else if (rest[1] === 'B' || rest[1] === 'D') { base = 1000n; used++ }
    n *= rest[0] === 'b' ? 512n : base ** BigInt(OD_POWERS[rest[0]])
    if (rest.length > used) return badSuffix()
  }
  if (n > UINT64_MAX) return { error: err(`od: ${flag} argument '${value}' too large`) }
  // Saturation preserves slicing positions beyond any representable JS string.
  return { value: Number(n > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : n) }
}
