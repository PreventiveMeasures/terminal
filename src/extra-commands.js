// Additional text commands kept here rather than in text-commands.js
// to stay under the per-file line cap. Same registry shape — each
// command takes (stdin, tokens, ctx), runs its tokens through
// parseArgs with a strict schema, and returns the standard
// `{ stdout, stderr, exitCode }` result. The TEXT_COMMANDS spread
// in index.js folds these into the main registry alongside the
// originals.

import { parseArgs } from './parse.js'
import { err, joinLines, ok, readFilesFor, splitLines, usage } from './util.js'

// Reverse line order: read stdin (or each file in order, reversed
// individually) and emit. Matches GNU `tac`'s per-file behavior —
// `tac a b` is reversed(a) then reversed(b), not reversed(a ++ b).
// Trailing newline is preserved because splitLines drops the empty
// post-newline element and we re-add one `\n` at the end iff we
// emitted anything.
function tac(stdin, tokens, ctx) {
  const { positional } = parseArgs(tokens)
  const r = positional.length > 0 ? readFilesFor('tac', positional, ctx) : { inputs: [{ name: null, content: stdin }] }
  if (r.error) return r.error
  const out = []
  for (const { content } of r.inputs) out.push(...splitLines(content).toReversed())
  return ok(joinLines(out))
}

// Cap on how many elements `seq` will materialize. Pipelines buffer
// each stage's entire output as a string (no lazy streaming), so an
// unbounded `seq 1 1000000000 | head -1` builds a billion lines and
// OOMs instead of stopping after the first. Real seq streams; we
// can't, so we bound the count. A million lines dwarfs any realistic
// interactive use and stays comfortably within memory.
const MAX_SEQ_ELEMENTS = 1_000_000

// Generate a numeric sequence, one per line. Forms:
//   seq LAST            → 1, 2, …, LAST              (step 1, even if LAST < 1 → empty)
//   seq FIRST LAST      → FIRST..LAST                (step ±1, sign auto-picked)
//   seq FIRST INCR LAST → FIRST, FIRST+INCR, …       (INCR may be negative)
// Integers only — floats and scientific notation are rejected so
// `seq 1 0.1 2` doesn't silently misbehave. parseNonNegativeInt
// can't be reused because seq legitimately accepts negatives.
//
// Auto-sign is gated to the two-arg form on purpose. In the one-arg
// form FIRST is fixed at 1 and `seq 0` / `seq -5` should print
// nothing (the loop just doesn't fire) — matching GNU. The earlier
// shared auto-sign made `seq 0` emit `1\n0\n`, which is wrong.
function seq(_stdin, tokens) {
  const { positional } = parseArgs(tokens)
  if (positional.length === 0 || positional.length > 3) {
    return usage('seq LAST  |  seq FIRST LAST  |  seq FIRST INCR LAST')
  }
  const nums = []
  for (const t of positional) {
    if (!/^-?\d+$/u.test(t)) return err(`seq: invalid integer: ${t}`)
    nums.push(Number(t))
  }
  let first, incr, last
  if (nums.length === 1) { first = 1; incr = 1; last = nums[0] }
  else if (nums.length === 2) { first = nums[0]; last = nums[1]; incr = first <= last ? 1 : -1 }
  else { [first, incr, last] = nums }
  if (incr === 0) return err('seq: increment must be non-zero')
  // Reject oversized ranges up front (before allocating) so a huge
  // `seq` can't OOM the buffered pipeline. Compute the count directly
  // rather than counting in the loop.
  const inRange = incr > 0 ? first <= last : first >= last
  const count = inRange ? Math.floor(Math.abs(last - first) / Math.abs(incr)) + 1 : 0
  if (count > MAX_SEQ_ELEMENTS) {
    return err(`seq: range too large: ${count} elements exceeds limit of ${MAX_SEQ_ELEMENTS}`)
  }
  const out = []
  if (incr > 0) for (let n = first; n <= last; n += incr) out.push(String(n))
  else for (let n = first; n >= last; n += incr) out.push(String(n))
  return ok(joinLines(out))
}

// Number lines with `cat -n`-style formatting (6-wide right-aligned
// number, tab separator). `-b a` numbers every line; `-b t` (the
// default, matching GNU) skips empty lines — they pass through
// unprefixed instead. Other GNU `-b` styles (`n`, `pREGEX`) are
// out of scope; the error message names the supported set.
function nl(stdin, tokens, ctx) {
  const { values, positional } = parseArgs(tokens, { valueShort: ['b'] })
  const style = values.get('b') ?? 't'
  if (style !== 'a' && style !== 't') return err(`nl: -b: only \`a\` and \`t\` are supported (got \`${style}\`)`)
  const r = positional.length > 0 ? readFilesFor('nl', positional, ctx) : { inputs: [{ name: null, content: stdin }] }
  if (r.error) return r.error
  const out = []
  let n = 0
  for (const { content } of r.inputs) {
    for (const line of splitLines(content)) {
      if (style === 'a' || line !== '') {
        n++
        out.push(`${String(n).padStart(6)}\t${line}`)
      } else {
        out.push(line)
      }
    }
  }
  return ok(joinLines(out))
}

// Extract characters (`-c LIST`) or delimiter-separated fields
// (`-f LIST [-d DELIM]`) from each line. LIST is comma-separated
// 1-indexed ranges: `N`, `N-M`, `N-` (open-ended high), `-M`
// (open-ended low). Output is ordered by position, not by the
// order listed — matching GNU cut.
function cut(stdin, tokens, ctx) {
  const { values, positional } = parseArgs(tokens, { valueShort: ['d', 'f', 'c'] })
  const hasF = values.has('f')
  const hasC = values.has('c')
  if (hasF === hasC) return usage('cut -f LIST [-d DELIM] [file...]  |  cut -c LIST [file...]')
  if (hasC && values.has('d')) return err('cut: -d is only valid with -f')
  const list = parseCutList(hasF ? values.get('f') : values.get('c'))
  if (list.error) return list.error
  const delim = values.get('d') ?? '\t'
  if (hasF && delim.length !== 1) return err('cut: -d delimiter must be a single character')
  const r = positional.length > 0 ? readFilesFor('cut', positional, ctx) : { inputs: [{ name: null, content: stdin }] }
  if (r.error) return r.error
  const out = []
  for (const { content } of r.inputs) {
    for (const line of splitLines(content)) {
      out.push(hasF ? cutFields(line, delim, list.ranges) : pickByPositions([...line], list.ranges).join(''))
    }
  }
  return ok(joinLines(out))
}

function parseCutList(spec) {
  const ranges = []
  for (const part of spec.split(',')) {
    if (part === '') return { error: err(`cut: empty list item in \`${spec}\``) }
    if (/^\d+$/u.test(part)) {
      const n = Number(part)
      if (n < 1) return { error: err('cut: list items must be >= 1') }
      ranges.push([n, n])
      continue
    }
    const range = part.match(/^(\d*)-(\d*)$/u)
    if (!range || (range[1] === '' && range[2] === '')) {
      return { error: err(`cut: invalid list item: ${part}`) }
    }
    const start = range[1] === '' ? 1 : Number(range[1])
    const end = range[2] === '' ? Number.POSITIVE_INFINITY : Number(range[2])
    if (start < 1) return { error: err('cut: list items must be >= 1') }
    if (end < start) return { error: err(`cut: reversed range: ${part}`) }
    ranges.push([start, end])
  }
  return { ranges }
}

// Return the items at the 1-indexed positions covered by `ranges`,
// in ascending position order with duplicates removed. Shared by
// the char and field branches of cut.
function pickByPositions(items, ranges) {
  const seen = new Set()
  const indices = []
  for (const [s, e] of ranges) {
    for (let i = s; i <= Math.min(e, items.length); i++) {
      if (seen.has(i)) continue
      seen.add(i)
      indices.push(i)
    }
  }
  indices.sort((a, b) => a - b)
  return indices.map((i) => items[i - 1])
}

// Lines without the delimiter pass through verbatim — matching GNU
// `cut`'s default (the `-s` "suppress unmatched lines" flag isn't
// modeled). Fields are re-joined with the same delimiter so the
// output stays parseable by the same downstream cut.
function cutFields(line, delim, ranges) {
  const fields = line.split(delim)
  if (fields.length === 1) return line
  return pickByPositions(fields, ranges).join(delim)
}

// Translate, delete, or squeeze characters from stdin. Forms:
//   tr SET1 SET2   replace each SET1 char with the corresponding SET2 char
//   tr -d SET      delete every char in SET
//   tr -s SET      collapse adjacent duplicates of SET chars
// SET supports `a-z` ranges and `\n` / `\t` / `\\` / `\0` escapes.
// GNU's `-c` (complement) and combined `-ds` aren't modeled.
function tr(stdin, tokens) {
  const { flags, positional } = parseArgs(tokens, { short: ['d', 's'] })
  const del = flags.has('d')
  const squeeze = flags.has('s')
  if (del && squeeze) return err('tr: -d combined with -s is not supported')
  const want = (del || squeeze) ? 1 : 2
  if (positional.length !== want) return usage('tr SET1 SET2  |  tr -d SET  |  tr -s SET')
  const set1 = expandTrSet(positional[0])
  if (set1.error) return set1.error
  if (del) {
    const remove = new Set(set1.chars)
    return ok([...stdin].filter((c) => !remove.has(c)).join(''))
  }
  if (squeeze) return ok(squeezeChars(stdin, new Set(set1.chars)))
  const set2 = expandTrSet(positional[1])
  if (set2.error) return set2.error
  if (set2.chars.length === 0) return err('tr: SET2 must not be empty')
  const map = new Map()
  // GNU pads SET2 by repeating its last char to SET1's length. The
  // truncate alternative (POSIX `-t`) isn't modeled.
  const pad = set2.chars.at(-1)
  for (let i = 0; i < set1.chars.length; i++) map.set(set1.chars[i], set2.chars[i] ?? pad)
  return ok([...stdin].map((c) => map.get(c) ?? c).join(''))
}

// Pre-split into an array of code-point characters so a single
// astral codepoint (e.g. an emoji) reads as ONE unit rather than
// the high/low surrogate pair `spec[i]` would otherwise expose.
// Ranges then walk code-point values, not code units.
function expandTrSet(spec) {
  const units = [...spec]
  const chars = []
  let i = 0
  const readUnit = () => {
    if (units[i] !== '\\') return units[i++]
    if (i + 1 >= units.length) return null
    const e = units[i + 1]
    i += 2
    return e === 'n' ? '\n' : e === 't' ? '\t' : e === '\\' ? '\\' : e === '0' ? '\0' : e
  }
  while (i < units.length) {
    const c = readUnit()
    if (c === null) return { error: err('tr: trailing backslash in set') }
    if (units[i] === '-' && i + 1 < units.length) {
      i++
      const endC = readUnit()
      if (endC === null) return { error: err('tr: trailing backslash in set') }
      const start = c.codePointAt(0)
      const end = endC.codePointAt(0)
      if (end < start) return { error: err(`tr: reversed range: ${c}-${endC}`) }
      for (let cc = start; cc <= end; cc++) chars.push(String.fromCodePoint(cc))
    } else {
      chars.push(c)
    }
  }
  return { chars }
}

function squeezeChars(s, set) {
  let out = ''
  let prev = null
  for (const c of s) {
    if (set.has(c) && c === prev) continue
    out += c
    prev = c
  }
  return out
}

// Print the fake `/usr/bin/<name>` for each known command. Unknown
// names emit `<name> not found` (zsh-builtin style, on stdout) and
// bump the exit code to 1. The fake-path mapping is one-way: this
// command does NOT participate in the `/bin/` / `/usr/bin/` prefix
// stripping that `dispatch` does — checking the registry directly
// keeps the lookup local and avoids feedback with that resolver.
function whichCmd(_stdin, tokens, ctx) {
  const { positional } = parseArgs(tokens)
  if (positional.length === 0) return usage('which COMMAND...')
  const out = []
  let exitCode = 0
  for (const name of positional) {
    if (ctx.hasCommand(name)) out.push(`/usr/bin/${name}`)
    else { out.push(`${name} not found`); exitCode = 1 }
  }
  return { stdout: joinLines(out), stderr: '', exitCode }
}

export const EXTRA_COMMANDS = { cut, tac, tr, seq, nl, which: whichCmd }
