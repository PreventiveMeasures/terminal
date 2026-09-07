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
// argv lists, so the cap is the honest answer.

const SEQ_LIMIT = 100_000
const NUM_RANGE = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/u
const CHAR_RANGE = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/u

const maskAt = (w, i) => (w.mask === null ? '0' : w.mask[i])
const slice = (w, a, b) => ({ value: w.value.slice(a, b), mask: w.mask === null ? null : w.mask.slice(a, b) })
const concat = (...ws) => ({ value: ws.map((w) => w.value).join(''), mask: ws.every((w) => w.mask === null) ? null : ws.map((w) => w.mask ?? '0'.repeat(w.value.length)).join('') })

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
// null when it is not a sequence. Bash takes the step's absolute value
// and counts in the direction of the endpoints; a zero step is 1.
function sequence(body) {
  if (body.mask !== null && /[12]/u.test(body.mask)) return null
  const num = NUM_RANGE.exec(body.value)
  const chr = num ? null : CHAR_RANGE.exec(body.value)
  if (!num && !chr) return null
  const [from, to] = num ? [Number(num[1]), Number(num[2])] : [chr[1].codePointAt(0), chr[2].codePointAt(0)]
  const step = Math.abs(Number((num ?? chr)[3] ?? 1)) || 1
  const count = Math.floor(Math.abs(to - from) / step) + 1
  if (count > SEQ_LIMIT) throw new Error(`brace expansion \`{${body.value}}\` would produce ${count} words (limit ${SEQ_LIMIT})`)
  const width = num ? padWidth(num[1], num[2]) : 0
  const out = []
  const dir = to >= from ? 1 : -1
  for (let k = 0; k < count; k++) {
    const n = from + dir * k * step
    const text = num ? pad(n, width) : String.fromCodePoint(n)
    out.push({ value: text, mask: null })
  }
  return out
}

// Zero padding applies when either endpoint was written with a leading
// zero (`{01..10}`, `{1..010}`); the width is the longest endpoint's,
// sign included, as bash pads `-1` alongside `-10` to `-01`.
function padWidth(a, b) {
  const zero = (s) => /^-?0\d/u.test(s)
  return zero(a) || zero(b) ? Math.max(a.length, b.length) : 0
}

function pad(n, width) {
  const s = String(Math.abs(n))
  const sign = n < 0 ? '-' : ''
  return sign + s.padStart(width - sign.length, '0')
}
