// Shared command I/O and numeric parsing; independent of the command registry.

import { UnsupportedError } from './unsupported.js'
import { lookup } from './fs.js'
import { UINT64_MAX } from './numeric.js'

// Byte operations encode JS strings as UTF-8. Preserve the BOM and refuse
// slices that cannot be represented losslessly as string output.
export const utf8 = new TextEncoder()
export function encodeUtf8(text) {
  if (!text.isWellFormed()) throw new UnsupportedError('feature', 'unpaired surrogate', 'unpaired UTF-16 surrogates cannot be encoded as UTF-8')
  return utf8.encode(text)
}
const strictUtf8 = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true })
export const utf8Decoder = {
  decode(bytes) {
    try { return strictUtf8.decode(bytes) } catch {
      throw new UnsupportedError('feature', 'partial UTF-8 byte sequence', 'byte output that is not valid UTF-8 cannot be represented by this string-based terminal')
    }
  },
}

export const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 })

// Terminate stderr once so consecutive errors stay on separate lines.
export const err = (msg, code = 1) => ({
  stdout: '',
  stderr: msg.endsWith('\n') ? msg : msg + '\n',
  exitCode: code,
})

export const usage = (line) => err(`usage: ${line}`, 2)

// Empty input has no lines; a trailing newline terminates the preceding line.
export function splitLines(s, delimiter = '\n') {
  if (s === '') return []
  const lines = s.split(delimiter)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

// Line-oriented output terminates nonempty arrays with a newline.
export const joinLines = (lines, delimiter = '\n') => lines.length === 0 ? '' : lines.join(delimiter) + delimiter

// Preserve each line's terminator for byte-exact filters and stdin offsets.
export function lineRecords(text, delimiter = '\n') {
  const records = []
  for (let pos = 0; pos < text.length;) {
    const end = text.indexOf(delimiter, pos)
    const next = end < 0 ? text.length : end + delimiter.length
    records.push(text.slice(pos, next))
    pos = next
  }
  return records
}

// Readers record unconsumed stdin so later commands in a group share its offset.
export function consumeStdin(ctx, rest = '') {
  ctx.io?.read(ctx.stdinHandle?.identity)
  ctx.stdinLeft = rest
}

// Keep operand order and partial read failures; head/tail need directory entries
// for banners even though they cannot read them. Repeated '-' shares one stream;
// /dev/stdin reopens a regular file independently but shares a pipe's offset.
export function readFilesFor(cmd, files, ctx, stdin = '', options = {}) {
  const entries = []
  let stderr = ''
  let pipe = stdin
  for (const name of files) {
    const entry = { name, content: '', kind: 'file' }
    let error
    if (name === '/dev/stdin' && ctx.stdinFile) { ctx.io?.read(ctx.stdinHandle?.identity); entry.content = ctx.stdinOrigin }
    else if (name === '-' || name === '/dev/stdin') {
      entry.content = pipe
      entry.shared = true
      pipe = ''
      consumeStdin(ctx)
    } else if (name !== '/dev/null') {
      const found = lookup(ctx.cwd, name, ctx.fs)
      if (found.error) { entry.kind = 'missing'; error = found.error.toLowerCase() }
      else if (ctx.fs.isDir(found.path)) {
        entry.kind = 'dir'
        if (!options.noRead) error = 'is a directory'
      } else entry.content = ctx.fs.readFile(found.path)
    }
    entries.push(entry)
    if (error) stderr += `${cmd}: ${name}: ${error}\n`
    if (entry.kind !== 'file' && (options.stopOnError || (entry.kind === 'dir' && options.stopOnDir))) break
  }
  return { inputs: entries.filter((e) => e.kind === 'file'), entries, stderr, failed: stderr !== '' }
}

export function readInputs(cmd, files, stdin, ctx, options) {
  if (files.length === 0) {
    consumeStdin(ctx)
    const only = [{ name: null, content: stdin, kind: 'file' }]
    return { inputs: only, entries: only, stderr: '', failed: false }
  }
  return readFilesFor(cmd, files, ctx, stdin, options)
}

export function readContent(cmd, files, stdin, ctx) {
  const r = readInputs(cmd, files, stdin, ctx)
  return { content: r.inputs.map((f) => f.content).join(''), stderr: r.stderr, failed: r.failed }
}

export const okWith = (stdout, r) => ({ stdout, stderr: r.stderr, exitCode: r.failed ? 1 : 0 })

// GNU counts allow leading blanks and '+', whereas find requires digits.
// Saturate beyond representable input sizes unless the caller specifies a limit.
export function parseNonNegativeInt(str, label, shown = str, { max = Infinity, digitsOnly = false } = {}) {
  if (typeof str !== 'string' || !(digitsOnly ? /^\d+$/u : /^[ \t\n\r\f\v]*\+?\d+$/u).test(str)) {
    return { error: err(`${label}: invalid count: ${shown}`) }
  }
  const n = Number(str)
  if (n > max) return { error: err(`${label}: out of range: ${shown}`) }
  return { value: Math.min(n, Number.MAX_SAFE_INTEGER) }
}

// Retain the sign for head/tail: '-5' means omit the last five lines to head,
// while '+5' means start at line five to tail. Preserve the operand in errors.
export function parseSignedCount(str, label) {
  if (typeof str !== 'string') return { error: err(`${label}: invalid count: ${str}`) }
  const sign = str[0] === '+' || str[0] === '-' ? str[0] : ''
  const part = sign === '-' ? str.slice(1) : str
  const m = /^[ \t\n\r\v\f]*\+?(\d+)(b|[kKMGTPEZYRQ](?:i?B)?)?$/u.exec(part)
  const bare = !sign && /^(?:b|[kKMGTPEZYRQ](?:i?B)?)$/u.test(part)
  if (!m && !bare) return { error: err(`${label}: invalid count: ${str}`) }
  const suffix = m?.[2] ?? (bare ? part : '')
  const count = scaledCount(BigInt(m?.[1] ?? '1'), suffix, label, str)
  return count.error ? count : { ...count, sign }
}

// Shared GNU byte-count suffixes and unsigned 64-bit range checking.
export function scaledCount(digits, suffix, label, shown) {
  let factor = 1n
  if (suffix === 'b') factor = 512n
  else if (suffix) factor = (suffix.length === 2 ? 1000n : 1024n) ** BigInt('KMGTPEZYRQ'.indexOf(suffix[0].toUpperCase()) + 1)
  const n = digits * factor
  if (n > UINT64_MAX) return { error: err(`${label}: count out of range: ${shown}`) }
  // Saturation preserves slicing positions beyond any representable JS string.
  return { value: Number(n > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : n) }
}

// Custom handlers may throw primitives, null, or objects with throwing getters.
export function reason(e) {
  try {
    const message = e?.message
    return typeof message === 'string' && message !== '' ? message : String(e)
  } catch {
    return 'threw a value with no message'
  }
}
