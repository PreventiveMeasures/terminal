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

// Resolve and read each file path against the virtual filesystem.
// Returns `{ inputs }` on success or `{ error }` on the first
// failure. The dir-vs-missing distinction matters: `cat src`
// pointing at a directory should say "is a directory", not "no
// such file or directory" — the path exists, it's just not
// readable as a file. Matches GNU cat / head / tail behavior.
export function readFilesFor(cmd, files, ctx) {
  const inputs = []
  for (const f of files) {
    const abs = resolve(ctx.cwd, f)
    if (ctx.fs.isDir(abs)) return { error: err(`${cmd}: ${f}: is a directory`) }
    if (!ctx.fs.isFile(abs)) return { error: err(`${cmd}: ${f}: no such file or directory`) }
    inputs.push({ name: f, content: ctx.fs.readFile(abs) })
  }
  return { inputs }
}

// Parse a non-negative decimal count. The digits-only regex rejects
// empty strings (`Number('')` is 0, which would otherwise sneak
// through — relevant because the tokenizer can emit empty tokens
// from quoted args like `head -n "" file`), whitespace,
// sign-prefixed numbers, hex/oct/binary literals, and scientific
// notation. The Number.isSafeInteger guard rejects values past
// 2^53 - 1 where round-trip parsing stops being exact. Callers
// that need a strictly positive count (e.g. xargs -n) check
// `value === 0` themselves.
export function parseNonNegativeInt(str, label) {
  if (typeof str !== 'string' || !/^\d+$/u.test(str)) {
    return { error: err(`${label}: invalid count: ${str}`) }
  }
  const n = Number(str)
  if (!Number.isSafeInteger(n)) return { error: err(`${label}: out of range: ${str}`) }
  return { value: n }
}
