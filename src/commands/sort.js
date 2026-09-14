// sort uses the whole line as a final tiebreak unless -u suppresses it.

import { parseArgs } from '../args.js'
import { encodeUtf8Loose, err, joinLines, okWith, readInputs, splitLines } from '../util.js'
import { unsupported } from '../unsupported.js'
import { compareNames as cmpStrings } from '../fs.js'

export function sort(stdin, tokens, ctx) {
  const { flags, values, positional } = parseArgs(tokens, {
    short: ['n', 'r', 'u', 'f', 'b', 'z'],
    valueShort: ['t'],
    repeatable: ['k'],
  })
  const sep = values.get('t')
  if (sep !== undefined && encodeUtf8Loose(sep).length !== 1) return err(`sort: multi-character tab '${sep}'`, 2)
  const globals = { n: flags.has('n'), f: flags.has('f'), b: flags.has('b'), r: flags.has('r') }
  const keys = parseKeySpecs(values.get('k') ?? [], globals)
  if (keys.error) return keys.error
  const r = readInputs('sort', positional, stdin, ctx, { stopOnError: true })
  // A read error aborts the complete sort with no partial output.
  if (r.failed) return { stdout: '', stderr: r.stderr, exitCode: 2 }
  const delimiter = flags.has('z') ? '\0' : '\n'
  const lines = r.inputs.flatMap(({ content }) => splitLines(content, delimiter))
  // With no -k, the whole line is one key with the same modifier semantics.
  const specs = keys.specs.length ? keys.specs : [{ start: 1, ...globals }]
  const ordered = sortByKeys(lines, specs, sep, flags.has('u'), globals.r)
  return okWith(joinLines(ordered, delimiter), r)
}

// Keys extend to end of line unless an end field is given. Any per-key modifier
// suppresses inherited global modifiers; character offsets remain unsupported.
const KEY_MODS = 'nrfb'
// Distinguish valid unimplemented modifiers from malformed key specifications.
const GNU_KEY_MODS = 'bdfghiMnRrV'
// A field or offset is read the way strtoul reads one, so a leading blank or
// `+` belongs to the number: `-k' 1'` and `-k+1` are both field 1.
const KEY_COUNT = /^[ \t]*\+?(\d+)/u

// GNU names the first thing wrong with a key, and says it two ways: a number
// it could not read where one belongs, and anything else about the spec as a
// whole. Both exit 2, as every sort diagnostic does. Recorded from coreutils 9.4.
const keyCount = (what, rest) => err(`sort: ${what}: invalid count at start of '${rest}'`, 2)
const keyField = (what, spec) => err(`sort: ${what}: invalid field specification '${spec}'`, 2)

// START[,END], each of them FIELD[.OFFSET][MODIFIERS]. The zero checks come
// before the leftover one, so `0q` is a field number rather than a stray `q`.
function readKeySpec(spec) {
  let at = 0
  let fault = null
  const count = (what) => {
    const m = KEY_COUNT.exec(spec.slice(at))
    if (m === null) { fault = keyCount(what, spec.slice(at)); return null }
    at += m[0].length
    return Number(m[1])
  }
  const position = (what) => {
    const field = count(what)
    if (field === null) return null
    let offset = null
    if (spec[at] === '.') {
      at++
      offset = count("invalid number after '.'")
      if (offset === null) return null
    }
    const mods = at
    while (at < spec.length && /[a-zA-Z]/u.test(spec[at])) at++
    return { field, offset, mods: spec.slice(mods, at) }
  }
  const from = position('invalid number at field start')
  if (from === null) return { error: fault }
  let to = null
  if (spec[at] === ',') {
    at++
    to = position("invalid number after ','")
    if (to === null) return { error: fault }
  }
  if (from.field === 0 || to?.field === 0) return { error: keyField('field number is zero', spec) }
  if (from.offset === 0) return { error: keyField('character offset is zero', spec) }
  if (at !== spec.length) return { error: keyField('stray character in field spec', spec) }
  return { from, to }
}

function parseKeySpecs(raw, globals) {
  const specs = []
  for (const spec of raw) {
    const read = readKeySpec(spec)
    if (read.error) return { error: read.error }
    const { from, to } = read
    const mods = from.mods + (to?.mods ?? '')
    for (const c of mods) {
      if (KEY_MODS.includes(c)) continue
      // A letter GNU knows is a key this cannot sort by; any other is the
      // stray character GNU calls it.
      if (!GNU_KEY_MODS.includes(c)) return { error: keyField('stray character in field spec', spec) }
      return { error: unsupported('option', 'sort', `-k${spec}`, `sort: unknown key option \`${c}\` in ${spec}`, 2) }
    }
    // An end offset of zero ends the key at the end of its field, which is
    // where a key with no end offset ends; any other offset picks a character.
    if (from.offset !== null || (to?.offset ?? 0) !== 0) {
      return { error: unsupported('option', 'sort', `-k${spec}`, `sort: invalid key specification: ${spec} (character offsets are not supported)`, 2) }
    }
    // Any option on EITHER position suppresses the globals for this key
    // — `b` included, so `sort -r -k2b` sorts ascending.
    const own = mods.length > 0
    specs.push({
      start: from.field,
      end: to?.field,
      n: own ? mods.includes('n') : globals.n,
      r: own ? mods.includes('r') : globals.r,
      f: own ? mods.includes('f') : globals.f,
      // `b` is POSITIONAL, unlike the ordering options: it attaches to
      // the position it was written on. `-k2,3b` blanks the END, so the
      // key still STARTS with field 2's leading blanks, while `-k2b,3`
      // strips them. Only the start matters without character offsets.
      b: own ? from.mods.includes('b') : globals.b,
    })
  }
  return { specs }
}

// Delimited fields exclude the separator. Whitespace fields include the blanks
// before the next word, so leading-blank handling must be applied separately.
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
  // Trailing blanks form another field: "ann 007 " has three fields.
  let i = 0
  do {
    const start = i
    while (i < line.length && /[ \t]/u.test(line[i])) i++
    while (i < line.length && !/[ \t]/u.test(line[i])) i++
    bounds.push([start, i])
  } while (i < line.length)
  return bounds
}

function keyOf(line, spec, bounds) {
  if (spec.start > bounds.length) return ''
  let from = bounds[spec.start - 1][0]
  // No end field means "to end of line"; an end past the last field
  // means the same rather than an error.
  const to = spec.end === undefined || spec.end > bounds.length ? line.length : bounds[spec.end - 1][1]
  if (spec.b) while (from < to && /[ \t]/u.test(line[from])) from++
  return line.slice(from, Math.max(from, to))
}

// C-locale folding is ASCII-only; full Unicode case expansion can
// silently merge distinct records under -u (for example ß and SS).
const foldCase = (s) => s.replace(/[a-z]/gu, (c) => c.toUpperCase())

function sortByKeys(lines, specs, sep, unique, globalReverse) {
  // Share field boundaries between keys and normalize before comparing records.
  const wholeLine = specs.every((spec) => spec.start === 1 && spec.end === undefined)
  if (wholeLine && specs.length === 1 && !specs[0].n && !specs[0].f && !specs[0].b) {
    // UTF-16 and code-point order coincide when no record has astral characters.
    lines.sort(lines.some((line) => /[\u{10000}-\u{10FFFF}]/u.test(line)) ? cmpStrings : undefined)
    if (specs[0].r) lines.reverse()
    return unique ? lines.filter((line, i) => i === 0 || line !== lines[i - 1]) : lines
  }
  const decorated = lines.map((line) => {
    const bounds = wholeLine ? [[0, line.length]] : fieldBounds(line, sep)
    return {
      line,
      keys: specs.map((spec) => {
        const key = keyOf(line, spec, bounds)
        return spec.n ? numericKey(key) : spec.f ? foldCase(key) : key
      }),
    }
  })
  const compare = (a, b) => {
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]
      const d = spec.n ? compareNumeric(a.keys[i], b.keys[i]) : cmpStrings(a.keys[i], b.keys[i])
      if (d !== 0) return spec.r ? -d : d
    }
    // GNU's last-resort comparison of whole lines, which `-u` drops so
    // that lines with equal keys count as duplicates.
    return unique ? 0 : (globalReverse ? -1 : 1) * cmpStrings(a.line, b.line)
  }
  decorated.sort(compare)
  const out = []
  for (let i = 0; i < decorated.length; i++) {
    // Deduplicate by comparator equality; different numeric text can have the same value.
    if (unique && i > 0 && compare(decorated[i - 1], decorated[i]) === 0) continue
    out.push(decorated[i].line)
  }
  return out
}

// Preserve decimal precision without converting to JS numbers. A leading + is
// not numeric, and exponent suffixes do not affect the parsed numeric prefix.
function numericKey(line) {
  const m = /^[ \t]*(-?)(?:(\d+)(?:\.(\d*))?|\.(\d+))/u.exec(line)
  const integer = (m?.[2] ?? '').replace(/^0+/u, '') || '0'
  const fraction = (m?.[3] ?? m?.[4] ?? '').replace(/0+$/u, '')
  return { integer, fraction, negative: m?.[1] === '-' && (integer !== '0' || fraction !== '') }
}

// Numeric components contain only ASCII digits, so UTF-16 order is sufficient.
const cmpDigits = (a, b) => a < b ? -1 : a > b ? 1 : 0

function compareNumeric(a, b) {
  if (a.negative !== b.negative) return a.negative ? -1 : 1
  // With trailing zeroes removed, fractional prefixes compare without padding.
  const d = a.integer.length - b.integer.length || cmpDigits(a.integer, b.integer) || cmpDigits(a.fraction, b.fraction)
  return a.negative ? -d : d
}
