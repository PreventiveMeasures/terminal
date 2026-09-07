// Bash-style brace expansion. Runs first, on the word as typed: only
// braces and commas the user left unquoted take part (the word's mask,
// from tokenize.js, says which), so `"{a,b}"` and `\{a,b\}` stay
// literal while `x"{"` … well, stays a word with a quoted brace in it.
// A bound `$f` value is never read as brace syntax either: expansion
// happens before substitution, and the reference text `$f{a,b}` simply
// multiplies into `$fa` and `$fb`, as in bash.
//
// Rules (matching bash):
//   `{a,b,c}`            → 3 words
//   `pre{a,b}post`       → `preapost`, `prebpost`
//   `{a,b}{c,d}`         → cartesian: `ac`, `ad`, `bc`, `bd`
//   `{a,b{c,d}}`         → nested: `a`, `bc`, `bd`
//   `{1..5}` `{5..1}`    → sequences, ascending or descending
//   `{01..10}`           → zero-padded to the widest endpoint
//   `{a..e}` `{1..9..2}` → letters; an explicit step
//   `{,a}`               → an empty alternative, which quote removal
//                          then drops (`echo {,a}` prints `a`) unless
//                          something else in the word gives it text
//   `{a}`, `{}`, `{abc`  → unchanged (no comma, no range)
//
// A sequence bigger than SEQ_LIMIT is refused rather than materialized:
// bash tries and runs out of memory; here the pipeline buffers whole
// argv lists, so the cap is the honest answer. Endpoints and steps are
// bash's 64-bit integers, counted exactly; a word whose numbers do not
// fit stays literal, as in bash.

import { concatWords as concat, sliceWord as slice } from './word.js'
import { UnsupportedError } from './unsupported.js'

const SEQ_LIMIT = 100_000
const NUM_RANGE = /^([+-]?\d+)\.\.([+-]?\d+)(?:\.\.([+-]?\d+))?$/u
const CHAR_RANGE = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.([+-]?\d+))?$/u
const INT64_MAX = 2n ** 63n - 1n
const INT64_MIN = -(2n ** 63n)
const int64 = (s) => { const n = BigInt(s); return n > INT64_MAX || n < INT64_MIN ? null : n }

const maskAt = (w, i) => (w.mask === null ? '0' : w.mask[i])

// Find the leftmost balanced, unquoted `{...}` that is a comma list or
// a sequence; expand it and recurse on each product so adjacent and
// nested groups multiply naturally. Anything else is one word.
export function expandBraces(word) {
  if (!word.value.includes('{')) return [word]
  const { close, comma } = pairBraces(word)
  for (let i = 0; i < word.value.length; i++) {
    if (word.value[i] !== '{' || maskAt(word, i) !== '0') continue
    const end = close.get(i)
    if (end === undefined) continue
    const body = slice(word, i + 1, end)
    const alternatives = comma.has(i) ? splitTopCommas(body) : sequence(body)
    if (alternatives === null) continue
    const prefix = slice(word, 0, i)
    const suffix = slice(word, end + 1)
    const out = []
    for (const alt of alternatives) out.push(...expandBraces(concat(prefix, alt, suffix)))
    return out
  }
  return [word]
}

// One pass over the word: `close` maps each matched unquoted `{` to its
// `}`, and `comma` holds every `{` with an unquoted comma at its own
// nesting level. A `}` with nothing open is ordinary text, and so is a
// `{` still open at the end: it never appears in `close`.
function pairBraces(w) {
  const open = []
  const close = new Map()
  const comma = new Set()
  for (let i = 0; i < w.value.length; i++) {
    if (maskAt(w, i) !== '0') continue
    const c = w.value[i]
    if (c === '{') open.push(i)
    else if (c === '}') { if (open.length > 0) close.set(open.pop(), i) }
    else if (c === ',' && open.length > 0) comma.add(open.at(-1))
  }
  return { close, comma }
}

function splitTopCommas(body) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < body.value.length; i++) {
    if (maskAt(body, i) !== '0') continue
    const c = body.value[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === ',' && depth === 0) { parts.push(slice(body, start, i)); start = i + 1 }
  }
  parts.push(slice(body, start))
  return parts
}

// `{x..y}` / `{x..y..step}` on a body that is entirely unquoted, or
// null when it is not a sequence — including one bash's arithmetic
// cannot hold: an endpoint or step outside 64 bits, the one step whose
// absolute value overflows, a span that does. Bash takes the step's
// absolute value and counts in the direction of the endpoints; a zero
// step is 1.
function sequence(body) {
  if (body.mask !== null && /[12]/u.test(body.mask)) return null
  const num = NUM_RANGE.exec(body.value)
  const chr = num ? null : CHAR_RANGE.exec(body.value)
  if (!num && !chr) return null
  const [from, to] = num ? [int64(num[1]), int64(num[2])] : [BigInt(chr[1].codePointAt(0)), BigInt(chr[2].codePointAt(0))]
  const rawStep = (num ?? chr)[3] === undefined ? 1n : int64((num ?? chr)[3])
  if (from === null || to === null || rawStep === null || rawStep === INT64_MIN) return null
  const span = to >= from ? to - from : from - to
  if (span > INT64_MAX) return null
  const step = (rawStep < 0n ? -rawStep : rawStep) || 1n
  const count = span / step + 1n
  if (count > SEQ_LIMIT) throw new UnsupportedError('feature', 'brace expansion limit', `brace expansion \`{${body.value}}\` would produce ${count} words (limit ${SEQ_LIMIT})`)
  const width = num ? padWidth(num[1], num[2]) : 0
  const out = []
  const dir = to >= from ? 1n : -1n
  for (let k = 0n; k < count; k++) {
    const n = from + dir * k * step
    const text = num ? pad(n, width) : String.fromCodePoint(Number(n))
    out.push({ value: text, mask: null })
  }
  return out
}

// Zero padding applies when either endpoint was written with a leading
// zero (`{01..10}`, `{1..010}`) — a `+` sign in front of it does not
// count, as in bash; the width is the longest endpoint's, sign
// included, as bash pads `-1` alongside `-10` to `-01`.
function padWidth(a, b) {
  const zero = (s) => /^-?0\d/u.test(s)
  return zero(a) || zero(b) ? Math.max(a.length, b.length) : 0
}

function pad(n, width) {
  const s = String(n < 0n ? -n : n)
  const sign = n < 0n ? '-' : ''
  return sign + s.padStart(width - sign.length, '0')
}
