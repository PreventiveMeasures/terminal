// The filters that rewrite a line rather than choose one: nl puts a number in
// front of it, cut keeps the fields or characters named, and tr maps one set
// of characters onto another. What they share is a spelling of what to act on
// — a width, a field list, a set — read before any line is.

import { parseArgs } from '../args.js'
import { INT64_MAX, INT64_MIN, UINT64_MAX } from '../numeric.js'
import { POSIX_RANGES } from '../charclass.js'
import { consumeStdin, decodeUtf8, encodeUtf8Loose, err, joinLines, ok, okWith, quoteLocale, readInputs, splitLines, usageError } from '../util.js'
import { unsupported } from '../unsupported.js'

// Unnumbered lines still reserve the number column and separator.
const NL_WIDTH = 6
const NL_SEP = '\t'
const NL_BLANK = ' '.repeat(NL_WIDTH + NL_SEP.length)

export function nl(stdin, tokens, ctx) {
  const { positional, order } = parseArgs(tokens, { valueShort: ['b', 'v'], valueLong: ['starting-line-number'] })
  // GNU reads each option as it comes, and says of a number it cannot read
  // what it would have been, as quote() names it.
  let n = 1n, style = 't'
  for (const { name, value } of order) {
    if (name === 'b') {
      // pREGEX is valid but unimplemented; other unknown styles are ordinary errors.
      if (value.startsWith('p')) return unsupported('option', 'nl', '-b p', `nl: -b: only \`a\`, \`t\` and \`n\` are supported (got \`${value}\`)`)
      if (!['a', 't', 'n'].includes(value)) return usageError('nl', `invalid body numbering style: ${quoteLocale(value, ctx)}`)
      style = value
      continue
    }
    const invalid = (why = '') => err(`nl: invalid starting line number: ${quoteLocale(value, ctx)}${why}`)
    if (!/^[ \t\n\r\f\v]*[+-]?\d+$/u.test(value)) return invalid()
    n = BigInt(value.trim())
    if (n < INT64_MIN || n > INT64_MAX) return invalid(': Value too large for defined data type')
  }
  const r = readInputs('nl', positional, stdin, ctx)
  if (r.inputs.some(({ content }) => /(?:^|\n)(?:\\:){1,3}(?:\n|$)/u.test(content))) return unsupported('feature', 'nl', 'logical pages', 'nl: logical page delimiters are not supported')
  const out = []
  for (const { content } of r.inputs) {
    for (const line of splitLines(content)) {
      if (style === 'a' || (style === 't' && line !== '')) {
        if (n > INT64_MAX) return { stdout: joinLines(out), stderr: r.stderr + 'nl: line number overflow\n', exitCode: 1 }
        out.push(`${String(n).padStart(NL_WIDTH)}${NL_SEP}${line}`)
        n++
      } else {
        out.push(NL_BLANK + line)
      }
    }
  }
  return okWith(joinLines(out), r)
}

// cut emits selected positions in input order, with overlapping ranges deduplicated.
// What it cannot do with its command line it says in the order GNU's reads
// it: a second list or a delimiter of more than one byte where the option
// stands, then no list at all, then a delimiter or -s beside -c.
export function cut(stdin, tokens, ctx) {
  const { flags, order, positional } = parseArgs(tokens, { short: ['s'], valueShort: ['d', 'f', 'c'] })
  let delim = '\t', delimited = false, kind = null, spec = null
  for (const { name, value } of order) {
    if (name === 'f' || name === 'c') {
      if (spec !== null) return usageError('cut', 'only one list may be specified')
      spec = value
      kind = name === 'f' ? 'field' : 'position'
    } else if (name === 'd') {
      if (encodeUtf8Loose(value).length > 1) return usageError('cut', 'the delimiter must be a single character')
      delim = value === '' ? '\0' : value
      delimited = true
    }
  }
  if (spec === null) return usageError('cut', 'you must specify a list of bytes, characters, or fields')
  const hasF = kind === 'field'
  if (!hasF && delimited) return usageError('cut', 'an input delimiter may be specified only when operating on fields')
  if (!hasF && flags.has('s')) return usageError('cut', 'suppressing non-delimited lines makes sense\n\tonly when operating on fields')
  const list = parseCutList(spec, kind, ctx)
  if (list.error) return list.error
  const r = readInputs('cut', positional, stdin, ctx)
  const out = []
  for (const { content } of r.inputs) {
    for (const line of hasF && delim === '\n' ? (content === '' ? [] : [content]) : splitLines(content)) {
      // Field mode passes undelimited lines through unless -s was given.
      if (hasF && !line.includes(delim)) {
        if (!flags.has('s')) out.push(line)
        continue
      }
      out.push(hasF ? cutFields(line, delim, list.ranges) : cutBytes(line, list.ranges))
    }
  }
  return okWith(joinLines(out), r)
}

// GNU cut -c selects bytes even in UTF-8 mode. Partial characters must be diagnosed.
function cutBytes(line, ranges) {
  const bytes = encodeUtf8Loose(line)
  return decodeUtf8(Uint8Array.from(pickByPositions(bytes, ranges)))
}

// GNU names a bad list by what the list is of, and by what it could not read
// in it: a number below one, a decreasing range, a range with more than two
// ends or with none, what it could not read from the first character it
// could not read to the end of the list, or a number too large to hold — the
// first such number, whole. Recorded from coreutils 9.4.
const CUT_NAMES = {
  field: {
    zero: 'fields are numbered from 1',
    range: 'invalid field range',
    value: (text) => `invalid field value ${text}`,
    large: (digits) => `field number ${digits} is too large`,
  },
  position: {
    zero: 'byte/character positions are numbered from 1',
    range: 'invalid byte or character range',
    value: (text) => `invalid byte/character position ${text}`,
    large: (digits) => `byte/character offset ${digits} is too large`,
  },
}

// set_fields, read a character at a time: `,` and blanks part the items, and
// the end of the list is one more parting.
function parseCutList(spec, kind, ctx) {
  const names = CUT_NAMES[kind]
  const fail = (message) => ({ error: usageError('cut', message) })
  const ranges = []
  let dash = false, initial = 1n, lhs = false, rhs = false, start = -1, value = 0n
  for (let at = 0; ; at++) {
    const c = spec[at]
    if (c === '-') {
      start = -1
      if (dash) return fail(names.range)
      dash = true
      if (lhs && value === 0n) return fail(names.zero)
      initial = lhs ? value : 1n
      value = 0n
    } else if (c === undefined || c === ',' || c === ' ' || c === '\t') {
      start = -1
      if (dash) {
        if (!lhs && !rhs) return fail('invalid range with no endpoint: -')
        if (rhs && value < initial) return fail('invalid decreasing range')
        ranges.push([initial, rhs ? value : null])
      } else if (value === 0n) return fail(names.zero)
      else ranges.push([value, value])
      if (c === undefined) break
      dash = lhs = rhs = false
      value = 0n
    } else if (c >= '0' && c <= '9') {
      if (start < 0) start = at
      if (dash) rhs = true
      else lhs = true
      value = value * 10n + BigInt(c)
      if (value >= UINT64_MAX) return fail(names.large(quoteLocale(/^\d*/u.exec(spec.slice(start))[0], ctx)))
    } else return fail(names.value(quoteLocale(spec.slice(at), ctx)))
  }
  // Normalize once so every record can use ordered, nonoverlapping slices.
  const numbered = ranges.map(([from, to]) => [Number(from), to === null ? Infinity : Number(to)])
  numbered.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const range of numbered) {
    const previous = merged.at(-1)
    if (previous && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1])
    else merged.push(range)
  }
  return { ranges: merged }
}

function pickByPositions(items, ranges) {
  return ranges.flatMap(([start, end]) => Array.from(items.slice(start - 1, end)))
}

function cutFields(line, delim, ranges) {
  const fields = delim === '\n' ? splitLines(line) : line.split(delim)
  return pickByPositions(fields, ranges).join(delim)
}

// tr reads its options only before its first operand, as GNU's does.
export function tr(stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['c', 'd', 's'], stopAtFirstPositional: true })
  const del = flags.has('d')
  const squeeze = flags.has('s')
  const complement = flags.has('c')
  const counted = trOperandCount(positional, del, squeeze, ctx)
  if (counted) return counted
  if (del && squeeze) return unsupported('option', 'tr', '-d -s', 'tr: -d combined with -s is not supported')
  if (squeeze && !del && positional.length === 2) return unsupported('feature', 'tr', 'translate and squeeze', 'tr: combined translation and squeezing is not supported')
  if (/\P{ASCII}/u.test(stdin + positional.join(''))) return unsupported('feature', 'tr', 'non-ASCII bytes', 'tr: translation of non-ASCII bytes is not supported')
  if (positional.some((s) => /\[[.=]/u.test(s))) return unsupported('feature', 'tr', 'set expressions', 'tr: equivalence classes and collating symbols are not supported')
  if (positional.some((s) => /\[[^\]]*\*/u.test(s))) return unsupported('feature', 'tr', 'repeat expressions', 'tr: repetition expressions in a set are not supported')
  if (positional.some((s) => /\\[0-7]{2}|\\[1-7abfrv]/u.test(s))) return unsupported('feature', 'tr', 'set escapes', 'tr: these set escape sequences are not supported')
  if (positional.some((s) => /(?:^|[^\\])(?:\\\\)*\\$/u.test(s))) return unsupported('feature', 'tr', 'trailing backslash', 'tr: an unescaped trailing backslash in a set is not supported')
  const set1 = expandTrSet(positional[0], ctx)
  if (set1.error) return set1.error
  const members = new Set(set1.chars)
  // `-c` inverts membership rather than materialising the complement,
  // which would be every byte NOT in SET1.
  const selected = (ch) => complement !== members.has(ch)
  if (del) { consumeStdin(ctx); return ok([...stdin].filter((c) => !selected(c)).join('')) }
  if (squeeze) { consumeStdin(ctx); return ok(squeezeChars(stdin, selected)) }
  const set2 = expandTrSet(positional[1], ctx)
  if (set2.error) return set2.error
  const misuse = classMisuse(set1, set2, complement)
  if (misuse) return misuse
  if (set2.chars.length === 0) return err('tr: when not truncating set1, string2 must be non-empty')
  consumeStdin(ctx)
  // Complement order is byte order; either mode pads SET2 with its last byte.
  const from = complement
    ? Array.from({ length: 256 }, (_, i) => String.fromCodePoint(i)).filter((c) => !members.has(c))
    : set1.chars
  const map = new Map()
  const pad = set2.chars.at(-1)
  for (let i = 0; i < from.length; i++) map.set(from[i], set2.chars[i] ?? pad)
  return ok([...stdin].map((c) => map.get(c) ?? c).join(''))
}

// How many strings tr takes: two to translate or to delete and squeeze, one
// to delete, and one or two to squeeze. Too few or too many is GNU's error,
// with the line saying why where a count alone would not.
function trOperandCount(positional, del, squeeze, ctx) {
  const least = del === squeeze ? 2 : 1
  const most = del && !squeeze ? 1 : 2
  if (positional.length === 0) return usageError('tr', 'missing operand')
  if (positional.length < least) {
    const why = squeeze ? 'Two strings must be given when both deleting and squeezing repeats.' : 'Two strings must be given when translating.'
    return usageError('tr', `missing operand after ${quoteLocale(positional.at(-1), ctx)}\n${why}`)
  }
  if (positional.length > most) {
    const why = positional.length === 2 ? '\nOnly one string may be given when deleting without squeezing repeats.' : ''
    return usageError('tr', `extra operand ${quoteLocale(positional[most], ctx)}${why}`)
  }
  return null
}

// The classes tr knows, which are the locale's own — the same table the regex
// and glob parsers read `[[:alpha:]]` from, so a set here holds exactly what a
// bracket expression there does. This reads its input as ASCII, and a class is
// taken in code point order, which is the order a translation pairs the two
// sets off in. `word` is GNU's own and no class tr will take.
const CLASSES = Object.freeze(Object.fromEntries(Object.entries(POSIX_RANGES)
  .filter(([name]) => name !== 'word')
  .map(([name, ranges]) => [name, ranges.flatMap(([low, high]) => Array.from({ length: high - low + 1 }, (_, step) => String.fromCodePoint(low + step)))])))
const OPPOSITE = { __proto__: null, lower: 'upper', upper: 'lower' }

// `[:name:]` is a class, and a `[` that begins no whole one is the bracket
// itself: `[abc]` is five characters rather than a set, which is how GNU
// reads it and what `tr -s '[:l]'` relies on.
function classAt(spec, at) {
  if (spec[at] !== '[' || spec[at + 1] !== ':') return null
  const close = spec.indexOf(':]', at + 2)
  return close < 0 ? null : { name: spec.slice(at + 2, close), next: close + 2, text: spec.slice(at, close + 2) }
}

// A class in string2 is only ever `upper` or `lower`, and only opposite the
// other one over the very same stretch of string1 — which is what makes the
// pairing mean anything, the two being the same length. Complementing string1
// leaves nothing of it to pair against, so what string2 may then say is
// narrower still: a class at its end has no stretch to answer for, and
// anything longer than a single character has no order left to follow.
function classMisuse(set1, set2, complement) {
  const stray = set2.classes.find((one) => OPPOSITE[one.name] === undefined)
  if (stray) return err("tr: when translating, the only character classes that may appear in\nstring2 are 'upper' and 'lower'")
  const aligned = (one) => set1.classes.some((other) => other.name === OPPOSITE[one.name] && other.start === one.start && other.end === one.end)
  const loose = complement ? null : set2.classes.find((one) => !aligned(one))
  if (loose) return err('tr: misaligned [:upper:] and/or [:lower:] construct')
  if (set2.classes.some((one) => one.end === set2.chars.length) && (complement || set1.chars.length > set2.chars.length)) {
    return err('tr: when translating with string1 longer than string2,\nthe latter string must not end with a character class')
  }
  if (complement && set1.classes.length > 0 && set2.chars.length !== 1) {
    return err('tr: when translating with complemented character classes,\nstring2 must map all characters in the domain to one')
  }
  return null
}

function expandTrSet(spec, ctx) {
  const chars = []
  const classes = []
  let i = 0
  const readUnit = () => {
    if (spec[i] !== '\\') return spec[i++]
    if (i + 1 >= spec.length) return null
    const e = spec[i + 1]
    i += 2
    return e === 'n' ? '\n' : e === 't' ? '\t' : e === '\\' ? '\\' : e === '0' ? '\0' : e
  }
  while (i < spec.length) {
    const klass = classAt(spec, i)
    if (klass) {
      if (klass.name === '') return { error: err(`tr: missing character class name '${klass.text}'`) }
      const members = CLASSES[klass.name]
      if (members === undefined) return { error: err(`tr: invalid character class ${quoteLocale(klass.name, ctx)}`) }
      classes.push({ name: klass.name, start: chars.length, end: chars.length + members.length })
      chars.push(...members)
      i = klass.next
      continue
    }
    const c = readUnit()
    if (spec[i] === '-' && i + 1 < spec.length) {
      i++
      const endC = readUnit()
      if (endC === null) return { error: err('tr: trailing backslash in set') }
      const start = c.codePointAt(0)
      const end = endC.codePointAt(0)
      if (end < start) return { error: err(`tr: range-endpoints of '${c}-${endC}' are in reverse collating sequence order`) }
      for (let cc = start; cc <= end; cc++) chars.push(String.fromCodePoint(cc))
    } else {
      chars.push(c)
    }
  }
  return { chars, classes }
}

function squeezeChars(s, selected) {
  let out = ''
  let prev = null
  for (const c of s) {
    if (selected(c) && c === prev) continue
    out += c
    prev = c
  }
  return out
}

