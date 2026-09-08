// Shared helpers for command modules. Kept in its own file (rather
// than co-located with the registry) so the text- and nav-command
// modules can import without pulling in each other through the
// registry, which would create a cycle.

import { UnsupportedError } from './unsupported.js'
import { lookup } from './fs.js'

// The byte model every `-c`-style option shares. Content is a JS string
// (UTF-16 code units), so anything counting or slicing BYTES — `wc -c`,
// `head -c`, `cut -c`, the dump commands — encodes to UTF-8 first: `é`
// is 2 bytes, an emoji 4. Plain `.length` would count code units and
// disagree with coreutils on multibyte text. `ignoreBOM` keeps a
// leading U+FEFF in decoded output instead of swallowing it, since
// these are raw bytes being sliced, not a document being loaded.
export const utf8 = new TextEncoder()
const strictUtf8 = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true })
export const utf8Decoder = {
  decode(bytes) {
    try { return strictUtf8.decode(bytes) } catch {
      throw new UnsupportedError('feature', 'partial UTF-8 byte sequence', 'byte output that is not valid UTF-8 cannot be represented by this string-based terminal')
    }
  },
}

export const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 })

// Most stderr lines should end with a newline so consecutive
// error outputs render on separate lines. Tolerate the rare
// caller that already supplied one.
export const err = (msg, code = 1) => ({
  stdout: '',
  stderr: msg.endsWith('\n') ? msg : msg + '\n',
  exitCode: code,
})

export const usage = (line) => err(`usage: ${line}`, 2)

// Split a string into lines, dropping the trailing empty element
// produced by a trailing newline. `''` returns `[]` (no lines)
// rather than `['']` so empty stdin doesn't read as one blank
// line — important for grep/wc behavior on empty pipes.
export function splitLines(s) {
  if (s === '') return []
  const lines = s.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

// Inverse of `splitLines` for command output: empty array stays
// empty (no bare newline), non-empty gets a trailing newline so
// the next command sees one line per element. Pinning the
// convention here keeps each command from re-implementing it.
export const joinLines = (lines) => lines.length === 0 ? '' : lines.join('\n') + '\n'

// Resolve and read each file path against the virtual filesystem.
// Reads every path it can rather than aborting on the first bad one,
// collecting a stderr line per missing/dir path — so `cat a missing b`
// still emits a and b (matching coreutils' partial-failure behavior).
// Returns `{ inputs, stderr, failed }`: `inputs` for the readable
// files in order, `stderr` with one error line per failure, and
// `failed` true if any path errored. The dir-vs-missing distinction
// matters twice over. In the MESSAGE: `cat src` pointing at a directory
// should say "is a directory", not "no such file or directory" — the
// path exists, it's just not readable as a file. And in the OUTPUT: the
// underlying `open()` SUCCEEDS on a directory and only the read fails,
// so GNU head/tail still banner a directory operand while a missing one
// gets nothing at all. `entries` carries every operand in order with
// that distinction as `kind`; `inputs` is the readable subset, which is
// what every other caller wants, so this changed nothing for them.
// A command that reads its standard input records what it leaves of
// it — nothing, unless it stopped short as `head -c N` does — for the
// next command in the same group: `echo hi | { echo x; cat; }` prints
// both, `{ cat; cat; }` once. A command that never reads it leaves it
// be. The engine (index.js) resets the record before each command.
export function consumeStdin(ctx, rest = '') {
  ctx.stdinLeft = rest
}

// `stdin` backs a `-` operand — the first one; a second `-` names the
// same stream and finds it at end of file, as `cat - -` does. Such
// entries are marked `shared` so a reader that stops short (`head`)
// can leave the rest for the next one. `/dev/stdin` is that stream too
// when it is a pipe; on a regular file it reopens the file from the
// start, on its own, as the kernel does.
export function readFilesFor(cmd, files, ctx, stdin = '', options = {}) {
  const entries = []
  let stderr = ''
  let failed = false
  let pipe = stdin
  for (const f of files) {
    // `-` is the standard input, by the convention every coreutils
    // reader follows; it keeps its name so banners can label it.
    if (f === '/dev/null') { entries.push({ name: f, content: '', kind: 'file' }); continue }
    if (f === '/dev/stdin' && ctx.stdinFile) { entries.push({ name: f, content: ctx.stdinOrigin, kind: 'file' }); continue }
    if (f === '-' || f === '/dev/stdin') { entries.push({ name: f, content: pipe, kind: 'file', shared: true }); pipe = ''; consumeStdin(ctx); continue }
    const { path: abs, error } = lookup(ctx.cwd, f, ctx.fs)
    if (error) {
      stderr += `${cmd}: ${f}: ${error.toLowerCase()}\n`
      failed = true
      entries.push({ name: f, content: '', kind: 'missing' })
      if (options.stopOnError) break
      continue
    }
    if (ctx.fs.isDir(abs)) {
      if (!options.noRead) { stderr += `${cmd}: ${f}: is a directory\n`; failed = true }
      entries.push({ name: f, content: '', kind: 'dir' })
      if (options.stopOnError || options.stopOnDir) break
      continue
    }
    entries.push({ name: f, content: ctx.fs.readFile(abs), kind: 'file' })
  }
  return { inputs: entries.filter((e) => e.kind === 'file'), entries, stderr, failed }
}

// File inputs with a stdin fallback: with no file operands a command
// reads stdin (one nameless input); otherwise it reads the named
// files via readFilesFor with the same partial-failure semantics.
// This is the per-file model — callers that need file names/boundaries
// (wc, head, grep) iterate `.inputs`.
export function readInputs(cmd, files, stdin, ctx, options) {
  if (files.length === 0) {
    consumeStdin(ctx)
    const only = [{ name: null, content: stdin, kind: 'file' }]
    return { inputs: only, entries: only, stderr: '', failed: false }
  }
  return readFilesFor(cmd, files, ctx, stdin, options)
}

// The concatenated-stream model: every readable input joined into one
// string, file boundaries dropped. For commands that treat all input
// as a single stream (cat, sort, uniq). Carries the same partial-
// failure stderr/failed so callers can hand it straight to okWith.
export function readContent(cmd, files, stdin, ctx) {
  const r = readInputs(cmd, files, stdin, ctx)
  return { content: r.inputs.map((f) => f.content).join(''), stderr: r.stderr, failed: r.failed }
}

// Pair a command's stdout with the partial-failure outcome from
// readInputs / readFilesFor: surface the per-file errors on stderr and
// exit 1 if any input failed, even when some files were read.
export const okWith = (stdout, r) => ({ stdout, stderr: r.stderr, exitCode: r.failed ? 1 : 0 })

// Parse a non-negative decimal count. The digits-only regex rejects
// empty strings (`Number('')` is 0, which would otherwise sneak
// through — relevant because the tokenizer can emit empty tokens
// from quoted args like `head -n "" file`), whitespace,
// sign-prefixed numbers, hex/oct/binary literals, and scientific
// notation. The Number.isSafeInteger guard rejects values past
// 2^53 - 1 where round-trip parsing stops being exact. Callers
// that need a strictly positive count (e.g. xargs -n) check
// `value === 0` themselves.
export function parseNonNegativeInt(str, label, shown = str) {
  if (typeof str !== 'string' || !/^\d+$/u.test(str)) {
    return { error: err(`${label}: invalid count: ${shown}`) }
  }
  const n = Number(str)
  if (!Number.isSafeInteger(n)) return { error: err(`${label}: out of range: ${shown}`) }
  return { value: n }
}

// A count that may carry a sign, as head's and tail's `-n` / `-c` do.
// GNU size suffixes are supported; the SIGN is handed back
// rather than interpreted, because the two commands read it in mirror
// image: `head -n -5` drops the last 5 lines, `tail -n +5` starts at
// line 5, and an unsigned count means "first 5" to head and "last 5"
// to tail. `+` is the explicit form of each command's own default, so
// `head -n +5` is `head -n 5`. Errors quote the operand as typed —
// `-n +x` complains about `+x`, not `x`.
export function parseSignedCount(str, label) {
  if (typeof str !== 'string') return { error: err(`${label}: invalid count: ${str}`) }
  const sign = str[0] === '+' || str[0] === '-' ? str[0] : ''
  const part = sign === '-' ? str.slice(1) : str
  const m = /^[ \t\n\r\v\f]*\+?(\d+)(b|[kKMGTPEZYRQ](?:i?B)?)?$/u.exec(part)
  const bare = !sign && /^(?:b|[kKMGTPEZYRQ](?:i?B)?)$/u.test(part)
  if (!m && !bare) return { error: err(`${label}: invalid count: ${str}`) }
  const suffix = m?.[2] ?? (bare ? part : '')
  let factor = 1n
  if (suffix === 'b') factor = 512n
  else if (suffix) factor = (suffix.length === 2 ? 1000n : 1024n) ** BigInt('KMGTPEZYRQ'.indexOf(suffix[0].toUpperCase()) + 1)
  const n = BigInt(m?.[1] ?? '1') * factor
  if (n > 18446744073709551615n) return { error: err(`${label}: count out of range: ${str}`) }
  // A JS string cannot approach this bound; saturation preserves slicing
  // semantics without rounding a representable input position.
  return { value: Number(n > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : n), sign }
}
