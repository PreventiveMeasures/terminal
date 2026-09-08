// sort uses the whole line as a final tiebreak unless -u suppresses it.

import { parseArgs } from '../args.js'
import { err, joinLines, okWith, readInputs, splitLines, utf8 } from '../util.js'
import { unsupported } from '../unsupported.js'
import { compareNames as cmpStrings } from '../fs.js'

export function sort(stdin, tokens, ctx) {
  const { flags, values, positional } = parseArgs(tokens, {
    short: ['n', 'r', 'u', 'f', 'b', 'z'],
    valueShort: ['t'],
    repeatable: ['k'],
  })
  const sep = values.get('t')
  if (sep !== undefined && utf8.encode(sep).length !== 1) return err(`sort: multi-character tab \`${sep}\``)
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
const KEY_POS = /^(\d+)([a-zA-Z]*)$/u
// Recognize character-offset syntax before diagnosing unsupported key positions.
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

function compareNumeric(a, b) {
  if (a.negative !== b.negative) return a.negative ? -1 : 1
  // With trailing zeroes removed, fractional prefixes compare without padding.
  const d = a.integer.length - b.integer.length || cmpStrings(a.integer, b.integer) || cmpStrings(a.fraction, b.fraction)
  return a.negative ? -d : d
}
