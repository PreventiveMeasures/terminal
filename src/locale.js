// The locale this terminal runs in: C.UTF-8, glibc's own, where text is read
// a character at a time, collation is code point order and the decimal point
// is `.`. It is the one locale implemented, so it is the one a session can be
// in: the variables that pick the character set — LANG, LC_ALL and LC_CTYPE —
// take a spelling of C.UTF-8 and nothing else, and `createTerminal` takes the
// same. The other LC_ categories read the same in C and POSIX as they do here,
// so those keep taking both.
//
// A command that would read text differently elsewhere asks here rather than
// the variables, so a locale this terminal cannot run in is refused where it
// would first change an answer, never answered as if it were this one.

import { UnsupportedError } from './unsupported.js'
import { POSIX_CLASSES, POSIX_RANGES } from './charclass.js'
import { CLASSES as RECORDED, TOLOWER, TOUPPER } from './locale-data.js'

export const LOCALE = 'C.UTF-8'
export const ONLY_C_UTF8 = 'only the C.UTF-8 locale is supported'

// glibc takes the codeset spelt with or without the hyphen, in either case.
export const spellsCUtf8 = (value) => typeof value === 'string' && /^C\.UTF-?8$/iu.test(value)

const CTYPE_VARIABLES = new Set(['LANG', 'LC_ALL', 'LC_CTYPE'])

export function localeOption(opts) {
  if (opts.locale === undefined || spellsCUtf8(opts.locale)) return LOCALE
  throw new TypeError(`createTerminal: ${ONLY_C_UTF8} (got ${JSON.stringify(opts.locale)})`)
}

// A shell assignment to a locale variable is refused unless it leaves the
// character set where it is. An empty LC_ALL or LC_CTYPE hands the choice
// back to LANG, which is fine; an empty LANG would hand it to the C locale.
export function checkLocaleAssignment(name, value) {
  const accepted = CTYPE_VARIABLES.has(name)
    ? spellsCUtf8(value) || (name !== 'LANG' && value === '')
    : spellsCUtf8(value) || value === 'C' || value === 'POSIX' || value === ''
  if (!accepted) throw new UnsupportedError('feature', name, `${name}: ${ONLY_C_UTF8}`)
}

// Where a command reads bytes rather than characters for the C and POSIX
// locales, this is what it asks. No session can be in either today, so the
// answer is false; the branches it selects are what a settable locale would
// switch on, and they are kept for that day rather than torn out.
export const isByteLocale = (locale) => locale === 'C' || locale === 'POSIX'
export const byteLocale = (ctx) => isByteLocale(ctx.locale)

// The character classes a regular expression, a glob or a word test go by,
// and the case a `-i` folds by, chosen by the locale: glibc's own for
// C.UTF-8, recorded in locale-data.js; the ASCII sets for C and POSIX, where
// a byte is a character; and nothing for any other locale, which is refused
// where a class would first be read.
// Each table answers a class name with its code point ranges, with a bracket
// body for a /u regex, and with a membership test; `word` is the set GNU's
// `\w`, `\b`, `\<`, `\>` and `-w` go by, the alphanumerics and `_`.
function decode(text) {
  const ranges = []
  let prev = -1
  for (const pair of text.split(',')) {
    const [gap, length] = pair.split(':').map((n) => parseInt(n, 36))
    const lo = prev + 1 + gap
    ranges.push([lo, lo + length])
    prev = lo + length
  }
  return ranges
}

function withUnderscore(ranges) {
  const at = ranges.findIndex(([lo]) => lo > 95)
  return [...ranges.slice(0, at), [95, 95], ...ranges.slice(at)]
}

// ASCII letters and digits as themselves; the rest of ASCII as \xNN, so that
// `]`, `\`, `^` and `-` cannot be read as syntax; everything past ASCII as
// the character itself, which a /u bracket reads as one code point.
function member(code) {
  if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return String.fromCodePoint(code)
  return code < 128 ? '\\x' + code.toString(16).padStart(2, '0') : String.fromCodePoint(code)
}
const bracketBody = (ranges) => ranges.map(([lo, hi]) => (lo === hi ? member(lo) : `${member(lo)}-${member(hi)}`)).join('')

function inRanges(ranges, code) {
  let hi = ranges.length - 1
  let lo = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (code < ranges[mid][0]) hi = mid - 1
    else if (code > ranges[mid][1]) lo = mid + 1
    else return true
  }
  return false
}

// Case, as GNU's tools read it for grep's -i, sed's I and gawk's IGNORECASE:
// the DFA the three share spells each letter out as the set grep calls its
// case-folded counterparts — the letter, its upper case, the lower case of
// that where it maps back up, and the few "lonesome" lower-case letters that
// map up to the same letter without being its lower case (`s` stands for
// `s`, `S` and `ſ`; the Kelvin sign, its own upper case, for itself alone).
// A range and a class fall to glibc's regex, which upper-cases the pattern
// and the text alike through towupper and then matches exactly: a range
// runs between its endpoints' upper cases, over the text's (`[a-{]` reads as
// `[A-{]`, which `_` is in, and `[[-{]` no longer holds `a`), and [:upper:]
// and [:lower:] both read as [:alpha:] (foldedClass). The two readings agree
// on every character but the Cyrillic Extended-C letters (see EXTENDED_C),
// which the DFA's list predates. The mappings are runs of start, count,
// offset and stride, decoded on first use.
export const foldedClass = (name) => (name === 'upper' || name === 'lower' ? 'alpha' : name)

// grep's lonesome_lower: lower-case letters whose upper case has another
// lower case, as the DFA folds them.
const LONESOME = [0x00B5, 0x0131, 0x017F, 0x01C5, 0x01C8, 0x01CB, 0x01F2, 0x0345, 0x03C2, 0x03D0, 0x03D1, 0x03D5, 0x03D6, 0x03F0, 0x03F1, 0x03F2, 0x03F5, 0x1E9B, 0x1FBE]

// U+1C80–U+1C88, old letterforms whose upper case is a plain Cyrillic
// capital's: glibc's regex folds them together with it and GNU's DFA does
// not, so which answers a pattern decides the match. Case-insensitive
// matching over text or a pattern holding one is refused rather than guessed.
export const EXTENDED_C = /[\u1C80-\u1C88]/u

function decodeMapping(text) {
  const map = new Map()
  for (const run of text.split(',')) {
    const [from, count, offset, stride] = run.split(':').map((n) => parseInt(n, 36))
    for (let i = 0; i < count; i++) map.set(from + i * stride, from + i * stride + offset)
  }
  return map
}

const caseMaps = (up, low) => ({ up, low, folds: new Map() })

function asciiCase() {
  const up = new Map()
  const low = new Map()
  for (let c = 97; c <= 122; c++) { up.set(c, c - 32); low.set(c - 32, c) }
  return caseMaps(up, low)
}

// Ascending, with touching and overlapping ranges joined.
function mergeRanges(items) {
  const out = []
  for (const [lo, hi] of items.sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1)
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi)
    else out.push([lo, hi])
  }
  return out
}

function classTable(name, multibyte, rangesOf, bodyOf, caseOf) {
  const bodies = new Map()
  const ranges = new Map()
  let maps = null
  const get = (cls) => {
    if (!ranges.has(cls)) ranges.set(cls, rangesOf(cls))
    return ranges.get(cls)
  }
  const kase = () => (maps ??= caseOf())
  const table = {
    name, multibyte,
    ranges: get,
    body(cls) {
      if (!bodies.has(cls)) bodies.set(cls, bodyOf(cls, get(cls)))
      return bodies.get(cls)
    },
    has(cls, code) {
      const found = get(cls)
      return found !== undefined && inRanges(found, code)
    },
    // GNU's word and space escapes for the JS matcher, whose own \b and \w
    // know ASCII only: `\<`, `\>`, a boundary, its negation, and the sets.
    assertions() {
      if (table.js) return table.js
      const s = table.body('space')
      const w = `[${table.body('word')}]`
      table.js = {
        __proto__: null,
        '<': `(?<!${w})(?=${w})`, '>': `(?<=${w})(?!${w})`,
        boundary: `(?:(?<!${w})(?=${w})|(?<=${w})(?!${w}))`, inside: `(?:(?<=${w})(?=${w})|(?<!${w})(?!${w}))`,
        word: w, nonWord: `[^${table.body('word')}]`, space: `[${s}]`, nonSpace: `[^${s}]`,
      }
      return table.js
    },
    up: (code) => kase().up.get(code) ?? code,
    low: (code) => kase().low.get(code) ?? code,
    // The characters `code` stands for under case folding, itself among
    // them, ascending: one entry means it has no case.
    fold(code) {
      const { folds } = kase()
      let set = folds.get(code)
      if (set === undefined) {
        const uc = table.up(code)
        const lc = table.low(uc)
        const found = new Set([code, uc])
        if (lc !== uc && table.up(lc) === uc) found.add(lc)
        for (const li of LONESOME) if (table.up(li) === uc) found.add(li)
        set = [...found].sort((a, b) => a - b)
        folds.set(code, set)
      }
      return set
    },
    // The range `lo`-`hi` under case folding, as ranges of the characters
    // it takes: those of the upper-cased range whose own upper case stays
    // in it, and those outside it whose upper case falls in it. Null when
    // the endpoints cross once upper-cased, GNU's "Invalid range end".
    foldRange(lo, hi) {
      const { up } = kase()
      const from = up.get(lo) ?? lo
      const to = up.get(hi) ?? hi
      if (from > to) return null
      const holes = []
      const extra = []
      for (const [c, u] of up) {
        const inside = c >= from && c <= to
        if (inside !== (u >= from && u <= to)) (inside ? holes : extra).push(c)
      }
      const items = []
      let start = from
      for (const hole of holes.sort((a, b) => a - b)) {
        if (hole > start) items.push([start, hole - 1])
        start = hole + 1
      }
      if (start <= to) items.push([start, to])
      return mergeRanges([...items, ...extra.map((c) => [c, c])])
    },
  }
  return table
}

const ASCII_TABLE = classTable('C', false, (cls) => POSIX_RANGES[cls], (cls) => POSIX_CLASSES[cls], asciiCase)
const C_UTF8_TABLE = classTable(LOCALE, true,
  (cls) => (cls === 'word' ? withUnderscore(decode(RECORDED.alnum)) : Object.hasOwn(RECORDED, cls) ? decode(RECORDED[cls]) : undefined),
  (cls, ranges) => (ranges === undefined ? undefined : bracketBody(ranges)),
  () => caseMaps(decodeMapping(TOUPPER), decodeMapping(TOLOWER)))

export function classTables(locale) {
  if (locale === LOCALE) return C_UTF8_TABLE
  if (isByteLocale(locale)) return ASCII_TABLE
  throw new UnsupportedError('feature', 'locale', `matching in the ${locale} locale is not supported`)
}
