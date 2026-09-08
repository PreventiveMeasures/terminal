// Dump readers open operands lazily: a byte limit must neither consume the
// next reader's input nor report errors from files it never opens.
import { consumeStdin, err, readInputs, utf8, utf8Decoder } from './util.js'
import { unsupported } from './unsupported.js'

export function dumpInput(cmd, files, stdin, ctx, opt) {
  const skip = dumpCount(cmd, opt.skip, opt.skipFlag, 0)
  const len = dumpCount(cmd, opt.len, opt.lenFlag, Number.POSITIVE_INFINITY)
  if (skip.error || len.error) return { error: skip.error ?? len.error }
  let remaining = len.value
  let skipping = skip.value
  let start = 0
  let rest = stdin
  const chunks = []
  const r = { stderr: '', failed: false }
  for (const file of files.length ? files : [null]) {
    const input = readInputs(cmd, file === null ? [] : [file], rest, ctx, { noRead: remaining === 0 && skipping === 0 })
    r.stderr += input.stderr
    r.failed ||= input.failed && !(cmd === 'hexdump' && input.entries[0]?.kind === 'dir')
    if (skipping && input.entries[0]?.kind === 'dir') return { error: unsupported('feature', cmd, 'skip across unreadable input', `${cmd}: skipping across a directory operand is not supported`) }
    if (input.entries[0]?.kind === 'dir' && cmd === 'xxd') return { error: err(r.stderr, 2) }
    if (!input.inputs.length && input.entries[0]?.kind !== 'dir') continue
    const entry = input.inputs[0]
    const shared = entry && (entry.shared || entry.name === null)
    if (cmd === 'hexdump' && skipping && shared && !ctx.stdinFile) {
      consumeStdin(ctx, rest)
      return { error: err('hexdump: standard input: Illegal seek') }
    }
    // xxd seeks from the beginning unless +OFFSET was specified. Linux
    // hexdump also uses SEEK_SET for a nonzero skip; od skips from here.
    const rewind = shared && ctx.stdinFile && opt.skip !== undefined && (cmd === 'xxd' || (cmd === 'hexdump' && skip.value > 0))
    const all = utf8.encode(rewind ? ctx.stdinOrigin : entry?.content ?? '')
    const skipped = Math.min(skipping, all.length)
    skipping -= skipped; start += skipped
    const taken = Math.min(remaining, all.length - skipped)
    chunks.push(all.subarray(skipped, skipped + taken))
    remaining -= taken
    if (shared) {
      rest = utf8Decoder.decode(all.subarray(skipped + taken))
      consumeStdin(ctx, rest)
    }
    if (rewind && skipping) { start = skip.value; skipping = 0 }
    if (remaining === 0 && skipping === 0) break
  }
  if (skipping && opt.skipPastEofErrors) return { error: err(r.stderr + `${cmd}: cannot skip past end of combined input`) }
  const bytes = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return { bytes, start, r }
}

function dumpCount(cmd, value, flag, fallback) {
  if (value === undefined) return { value: fallback }
  // xxd accepts partial strtol inputs and relative/end-relative seeks. Reject
  // those explicitly instead of silently treating an octal offset as decimal.
  if (cmd === 'xxd' && (!/^(?:0[xX][\da-fA-F]+|0[0-7]*|[1-9]\d*)$/u.test(value))) {
    return { error: unsupported('feature', cmd, `${flag} ${value}`, `xxd: this offset/count spelling is not supported: ${value}`) }
  }
  if (cmd === 'hexdump') {
    if (!/^[ \t\n\r\v\f]*[+\d-]/u.test(value)) return { error: err(`${cmd}: ${flag}: invalid count: ${value}`) }
    if (!/^\d+$/u.test(value) || /^0\d/u.test(value)) {
      return { error: unsupported('feature', cmd, `${flag} ${value}`, `hexdump: this offset/count spelling is not supported: ${value}`) }
    }
    if (BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) return { error: unsupported('feature', cmd, 'large byte count', 'hexdump: counts beyond exact integer precision are not supported') }
    return { value: Number(value) }
  }
  const m = /^[ \t\n\r\v\f]*\+?(0[xX][\da-fA-F]+|0[0-7]*|[1-9]\d*)(b|[kKMGTPEZYRQ](?:i?B)?)?$/u.exec(value)
  if (!m) return { error: err(`${cmd}: ${flag}: invalid count: ${value}`) }
  const digits = /^0\d/u.test(m[1]) ? '0o' + m[1].slice(1) : m[1]
  const n = BigInt(digits) * multiplier(m[2])
  if (n > 18446744073709551615n) return { error: err(`${cmd}: ${flag}: count out of range: ${value}`) }
  return { value: Number(n > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : n) }
}

function multiplier(suffix) {
  if (!suffix) return 1n
  if (suffix === 'b') return 512n
  const exponent = BigInt('KMGTPEZYRQ'.indexOf(suffix[0].toUpperCase()) + 1)
  return (suffix.length === 2 ? 1000n : 1024n) ** exponent
}
