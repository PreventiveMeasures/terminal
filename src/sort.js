// `sort`, split out from the text-command registry because its key
// machinery (`-k` / `-t`) is the bulk of it. Ordering follows GNU:
// lexicographic by default, `-n` by leading numeric value, `-k` by
// selected fields, with the whole line as the last-resort tiebreak.

import { parseArgs } from './parse.js'
import { err, joinLines, okWith, readContent, splitLines } from './util.js'
import { unsupported } from './unsupported.js'

export function sort(stdin, tokens, ctx) {
  const { flags, values, positional } = parseArgs(tokens, {
    short: ['n', 'r', 'u', 'f', 'b'],
    valueShort: ['t'],
    repeatable: ['k'],
  })
  const sep = values.get('t')
  if (sep !== undefined && [...sep].length !== 1) return err(`sort: multi-character tab \`${sep}\``)
  const globals = { n: flags.has('n'), f: flags.has('f'), b: flags.has('b'), r: flags.has('r') }
  const keys = parseKeySpecs(values.get('k') ?? [], globals)
  if (keys.error) return keys.error
  // `sort a b` orders the concatenation of all inputs, matching coreutils.
  const r = readContent('sort', positional, stdin, ctx)
  // Unlike cat/head/wc, sort is ALL-OR-NOTHING: GNU abandons the run on
  // the first operand it cannot read and writes nothing to stdout,
  // exiting 2. Emitting a partial sort would be worse than useless —
  // the result would look like a complete ordering of the input.
  if (r.failed) return { stdout: '', stderr: r.stderr, exitCode: 2 }
  let lines = splitLines(r.content)
  const numeric = flags.has('n')
  const unique = flags.has('u')
  if (keys.specs.length > 0) return okWith(joinLines(sortByKeys(lines, keys.specs, sep, unique, globals.r)), r)
  if (numeric) {
    // -n orders by each line's leading numeric value. Equal values keep
    // input order (stable sort); without -u the whole line breaks the
    // tie (GNU's last-resort comparison). -u drops that tiebreak so
    // equal-value lines (e.g. `1` and `01`) dedupe in input order.
    const decorated = lines.map((line) => ({ line, key: numericKey(line) }))
    decorated.sort(unique
      ? (a, b) => a.key - b.key
      : (a, b) => (a.key - b.key) || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0))
    lines = decorated.map((d) => d.line)
  } else if (globals.f) {
    // -f folds case for the comparison only; the line is emitted as it
    // was read. GNU folds toward upper case, so `alpha` sorts with
    // `Alpha` rather than after every capital.
    lines = lines
      .map((line) => ({ line, key: line.toUpperCase() }))
      .sort((a, b) => cmpStrings(a.key, b.key) || cmpStrings(a.line, b.line))
      .map((d) => d.line)
  } else {
    lines.sort()
  }
  // Dedup in ascending order (keeping the first of each run) before -r
  // reverses, so the kept representative matches GNU regardless of -r.
  if (unique) {
    const seen = new Set()
    lines = lines.filter((l) => {
      const k = numeric ? numericKey(l) : globals.f ? l.toUpperCase() : l
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }
  if (flags.has('r')) lines.reverse()
  return okWith(joinLines(lines), r)
}

// GNU `sort -n`: a line's value is its leading numeric prefix — optional
// blanks, an optional `-`, then digits with an optional decimal part.
// Anything else (a `+` sign, scientific `e`, or non-digit) isn't numeric,
// so such lines sort as 0. Thousands separators aren't recognized (C locale).
// `-k F[,F][opts]` selects a sort key. The END is optional and, when
// absent, the key runs to the END OF THE LINE — so `-k1` is the whole
// line, not just field 1, and `-t: -k2` of `ann:25:la` is `25:la`.
// Getting that wrong makes `-u` look broken, since keys that should
// differ collapse.
//
// Per-key modifiers are n/r/f/b. GNU's precedence is all-or-nothing: a
// key carrying ANY modifier of its own ignores every global one, which
// is why `sort -r -t: -k2n` sorts ASCENDING. A bare key inherits the
// globals instead.
//
// Character offsets (`-k1.2`) are not modelled; the message says so
// rather than silently sorting on the wrong span.
const KEY_MODS = 'nrfb'
// Every modifier GNU sort accepts, including the ones above. The two
// sets differ, and the difference is the whole point: a spec GNU would
// take and this one won't (`-k2g`, `-k1.2`) is a GAP and belongs on the
// diagnostic feed, while `-k2Z` is malformed for GNU too and is just an
// error. Reporting both the same way would train a caller to ignore the
// feed, or to treat its own typos as missing features.
const GNU_KEY_MODS = 'bdfghiMnRrV'
const KEY_POS = /^(\d+)([a-zA-Z]*)$/u
// GNU's full KEYDEF grammar, `F[.C][OPTS][,F[.C][OPTS]]` — the same as
// KEY_POS plus the `.C` character offset this sort does not model.
// Matching against it is what separates "GNU takes this, we don't" from
// "malformed either way": `-k1.2` parses here and nowhere else, so it is
// a gap, while `-k1.2.3` and `-k1,2,3.4` fail both and are ordinary
// errors. Testing for a bare `.` instead would report a caller's own
// typo as a missing feature.
const GNU_KEY_POS = /^\d+(?:\.\d+)?([a-zA-Z]*)$/u
const isGnuKeySpec = (spec) => {
  const parts = spec.split(',')
  if (parts.length > 2) return false
  return parts.every((part) => {
    const m = GNU_KEY_POS.exec(part)
    return m !== null && [...m[1]].every((c) => GNU_KEY_MODS.includes(c))
  })
}

function parseKeySpecs(raw, globals) {
  const specs = []
  for (const spec of raw) {
    const parts = spec.split(',')
    const bad = () => {
      const message = `sort: invalid key specification: ${spec}`
      if (!isGnuKeySpec(spec)) return { error: err(message) }
      return { error: unsupported('option', 'sort', `-k${spec}`, `${message} (character offsets are not supported)`) }
    }
    if (parts.length > 2) return bad()
    const [m1, m2] = parts.map((part) => KEY_POS.exec(part))
    if (!m1 || (parts.length === 2 && !m2)) return bad()
    const mods = m1[2] + (m2?.[2] ?? '')
    for (const c of mods) {
      if (KEY_MODS.includes(c)) continue
      const message = `sort: unknown key option \`${c}\` in ${spec}`
      return { error: GNU_KEY_MODS.includes(c) ? unsupported('option', 'sort', `-k${spec}`, message) : err(message) }
    }
    const start = Number(m1[1])
    const end = m2 === undefined ? undefined : Number(m2[1])
    if (start === 0 || end === 0) return { error: err(`sort: field number is zero: ${spec}`) }
    if (end !== undefined && end < start) return { error: err(`sort: reversed key range: ${spec}`) }
    // Any option on EITHER position suppresses the globals for this key
    // — `b` included, so `sort -r -k2b` sorts ascending.
    const own = mods.length > 0
    specs.push({
      start,
      end,
      n: own ? mods.includes('n') : globals.n,
      r: own ? mods.includes('r') : globals.r,
      f: own ? mods.includes('f') : globals.f,
      // `b` is POSITIONAL, unlike the ordering options: it attaches to
      // the position it was written on. `-k2,3b` blanks the END, so the
      // key still STARTS with field 2's leading blanks, while `-k2b,3`
      // strips them. Only the start matters without character offsets.
      b: own ? m1[2].includes('b') : globals.b,
    })
  }
  return { specs }
}

// Field boundaries. `-t SEP` delimits with a character that belongs to
// neither neighbour. WITHOUT it, fields are runs of non-blanks and each
// field after the first INCLUDES the blanks preceding it — `-k2` of
// `b  1` is `  1`, blanks and all, until `b` strips them. GNU warns
// about exactly that, because it changes the ordering.
function fieldBounds(line, sep) {
  const bounds = []
  if (sep !== undefined) {
    let start = 0
    for (;;) {
      const at = line.indexOf(sep, start)
      if (at === -1) { bounds.push([start, line.length]); break }
      bounds.push([start, at])
      start = at + sep.length
    }
    return bounds
  }
  // GNU finds the start of field N by repeating "skip blanks, skip
  // non-blanks" N-1 times, and a field exists while that start is still
  // inside the line. That is not the same as counting runs of
  // non-blanks: `ann 007 ` has a THIRD field — the trailing blank —
  // whereas `ann  bob` has only two. Counting runs merges those cases
  // and makes `-k3` pick the wrong span on one of them.
  const starts = [0]
  const blank = (i) => /\s/u.test(line[i])
  let i = 0
  while (i < line.length) {
    while (i < line.length && blank(i)) i++
    while (i < line.length && !blank(i)) i++
    if (i < line.length) starts.push(i)
  }
  for (let k = 0; k < starts.length; k++) bounds.push([starts[k], starts[k + 1] ?? line.length])
  return bounds
}

function keyOf(line, spec, sep) {
  const bounds = fieldBounds(line, sep)
  if (spec.start > bounds.length) return ''
  let from = bounds[spec.start - 1][0]
  // No end field means "to end of line"; an end past the last field
  // means the same rather than an error.
  const to = spec.end === undefined || spec.end > bounds.length ? line.length : bounds[spec.end - 1][1]
  if (spec.b) while (from < to && /\s/u.test(line[from])) from++
  return line.slice(from, Math.max(from, to))
}

const cmpStrings = (a, b) => a < b ? -1 : a > b ? 1 : 0

function sortByKeys(lines, specs, sep, unique, globalReverse) {
  // Decorate once: recomputing the keys inside the comparator would
  // re-split every line on each of the O(n log n) comparisons.
  const decorated = lines.map((line) => ({ line, keys: specs.map((s) => keyOf(line, s, sep)) }))
  const compare = (a, b) => {
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]
      const [x, y] = [a.keys[i], b.keys[i]]
      const d = spec.n ? numericKey(x) - numericKey(y)
        : spec.f ? cmpStrings(x.toUpperCase(), y.toUpperCase())
        : cmpStrings(x, y)
      if (d !== 0) return spec.r ? -d : d
    }
    // GNU's last-resort comparison of whole lines, which `-u` drops so
    // that lines with equal keys count as duplicates.
    return unique ? 0 : (globalReverse ? -1 : 1) * cmpStrings(a.line, b.line)
  }
  decorated.sort(compare)
  const out = []
  for (let i = 0; i < decorated.length; i++) {
    // `-u` keeps the first of each run the COMPARATOR calls equal, which
    // is not the same as equal key text: under a numeric key `BOB` and
    // `ann` both read as 0, so they are duplicates. Comparing adjacent
    // entries works because the array is already sorted, and `compare`
    // has already dropped the whole-line tiebreak under `-u`.
    if (unique && i > 0 && compare(decorated[i - 1], decorated[i]) === 0) continue
    out.push(decorated[i].line)
  }
  return out
}

function numericKey(line) {
  const m = /^[ \t]*(-?(?:\d+\.?\d*|\.\d+))/u.exec(line)
  return m ? Number(m[1]) : 0
}
