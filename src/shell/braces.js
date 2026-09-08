// Brace expansion runs before substitution and only sees unquoted syntax.
// Comma lists and numeric/letter sequences expand recursively, preserving
// quoting and empty alternatives; unmatched or non-expanding braces stay text.
// Sequence endpoints and steps use Bash's 64-bit bounds. Oversized numeric
// syntax stays literal, while materializing more than SEQ_LIMIT words reports
// an implementation limit because this shell buffers complete argv lists.

import { concatWords as concat, sliceWord as slice } from './word.js'
import { UnsupportedError } from '../unsupported.js'

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
  const pairs = pairBraces(word)
  for (let i = 0; i < word.value.length; i++) {
    if (word.value[i] !== '{' || maskAt(word, i) !== '0') continue
    const pair = pairs.get(i)
    if (!pair) continue
    const { end, commas } = pair
    const alternatives = commas.length ? [] : sequence(slice(word, i + 1, end))
    if (commas.length) {
      let start = i + 1
      for (const stop of [...commas, end]) {
        alternatives.push(slice(word, start, stop))
        start = stop + 1
      }
    }
    if (alternatives === null) continue
    const prefix = slice(word, 0, i)
    const suffix = slice(word, end + 1)
    const out = []
    for (const alt of alternatives) out.push(...expandBraces(concat(prefix, alt, suffix)))
    return out
  }
  return [word]
}

// Collect each pair's top-level comma positions during the same scan.
// Unmatched braces have no entry; nested commas belong to the inner pair.
function pairBraces(w) {
  const open = []
  const pairs = new Map()
  for (let i = 0; i < w.value.length; i++) {
    if (maskAt(w, i) !== '0') continue
    const c = w.value[i]
    if (c === '{') open.push({ start: i, commas: [] })
    else if (c === '}' && open.length) {
      const { start, commas } = open.pop()
      pairs.set(start, { end: i, commas })
    } else if (c === ',' && open.length) open.at(-1).commas.push(i)
  }
  return pairs
}

// Quoted or overflowing sequences stay literal. Bash uses the step's absolute
// value in the endpoints' direction, treats zero as one, and rejects a span
// or step magnitude outside its signed 64-bit arithmetic.
function sequence(body) {
  if (body.mask !== null && /[12]/u.test(body.mask)) return null
  const num = NUM_RANGE.exec(body.value)
  const range = num ?? CHAR_RANGE.exec(body.value)
  if (!range) return null
  const [from, to] = num ? [int64(num[1]), int64(num[2])] : [BigInt(range[1].codePointAt(0)), BigInt(range[2].codePointAt(0))]
  const rawStep = range[3] === undefined ? 1n : int64(range[3])
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
