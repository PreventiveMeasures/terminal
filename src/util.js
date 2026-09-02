// Shared helpers for command modules. Kept in its own file (rather
// than co-located with the registry) so the text- and nav-command
// modules can import without pulling in each other through the
// registry, which would create a cycle.

import { resolve } from './fs.js'

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
// matters: `cat src` pointing at a directory should say "is a
// directory", not "no such file or directory" — the path exists, it's
// just not readable as a file. Matches GNU cat / head / tail.
export function readFilesFor(cmd, files, ctx) {
  const inputs = []
  let stderr = ''
  let failed = false
  for (const f of files) {
    const abs = resolve(ctx.cwd, f)
    if (ctx.fs.isDir(abs)) { stderr += `${cmd}: ${f}: is a directory\n`; failed = true; continue }
    if (!ctx.fs.isFile(abs)) { stderr += `${cmd}: ${f}: no such file or directory\n`; failed = true; continue }
    inputs.push({ name: f, content: ctx.fs.readFile(abs) })
  }
  return { inputs, stderr, failed }
}

// File inputs with a stdin fallback: with no file operands a command
// reads stdin (one nameless input); otherwise it reads the named
// files via readFilesFor with the same partial-failure semantics.
// This is the per-file model — callers that need file names/boundaries
// (wc, head, grep) iterate `.inputs`.
export function readInputs(cmd, files, stdin, ctx) {
  if (files.length === 0) return { inputs: [{ name: null, content: stdin }], stderr: '', failed: false }
  return readFilesFor(cmd, files, ctx)
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
// The digits are validated exactly as above; the SIGN is handed back
// rather than interpreted, because the two commands read it in mirror
// image: `head -n -5` drops the last 5 lines, `tail -n +5` starts at
// line 5, and an unsigned count means "first 5" to head and "last 5"
// to tail. `+` is the explicit form of each command's own default, so
// `head -n +5` is `head -n 5`. Errors quote the operand as typed —
// `-n +x` complains about `+x`, not `x`.
export function parseSignedCount(str, label) {
  if (typeof str !== 'string') return { error: err(`${label}: invalid count: ${str}`) }
  const sign = str[0] === '+' || str[0] === '-' ? str[0] : ''
  const r = parseNonNegativeInt(sign ? str.slice(1) : str, label, str)
  return r.error ? r : { value: r.value, sign }
}
