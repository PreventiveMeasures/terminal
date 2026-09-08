// awk's value model. A cell holds one of:
//   number     a JS number
//   string     a JS string — a string CONSTANT, or the result of a
//              string operation; never compares numerically
//   StrNum     a string that came from input (a field, a getline line,
//              a split() element, a -v assignment, a for-in key). POSIX
//              calls these "numeric strings": they compare as numbers
//              when they look like one, as strings otherwise. This is
//              why `$1 < 9` on the line `10` is false (numeric) while
//              `x = "10"; x < 9` is true (string).
//   undefined  uninitialized — both `""` and 0, and numeric in comparisons
//   Map        an array (only ever reached through the name lookup in
//              awk-eval.js; the scalar helpers below reject it)

import { AwkError } from './awk-common.js'
import { compareNames } from './fs.js'
import { formatNumeric, parseFormat } from './awk-format.js'

export class StrNum {
  constructor(s) { this.s = s }
}

const BLANK = '[ \\t\\n\\r\\f\\v]*'
const NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?'
const NUMERIC_RE = new RegExp(`^${BLANK}${NUMBER}${BLANK}$`, 'u')
const PREFIX_RE = new RegExp(`^${BLANK}(${NUMBER})`, 'u')
// gawk's "IEEE magic values": exactly these four spellings, a sign
// required, are the infinities and NaNs; `inf` and `nan` alone are 0.
const MAGIC_RE = new RegExp(`^${BLANK}([+-])(inf|nan)${BLANK}$`, 'iu')

// "Looks numeric": the whole string, blanks aside, is a decimal number.
// Hex (`0x10`) is not a number here — gawk's default reading, and the
// one POSIX describes.
export const looksNumeric = (s) => NUMERIC_RE.test(s) || MAGIC_RE.test(s)

// String → number conversion takes the longest numeric PREFIX, like C's
// strtod: `"3x"` is 3, `" 4 "` is 4, `"abc"` is 0.
function parsePrefix(s) {
  const m = PREFIX_RE.exec(s)
  if (m) return Number(m[1])
  const magic = MAGIC_RE.exec(s)
  if (!magic) return 0
  if (magic[2].toLowerCase() === 'nan') return Number.NaN
  return magic[1] === '-' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
}

const arrayInScalar = () => new AwkError('attempt to use an array in a scalar context')

export function toNum(v) {
  if (typeof v === 'number') return v
  if (v === undefined) return 0
  if (v instanceof StrNum) return parsePrefix(v.s)
  if (typeof v === 'string') return parsePrefix(v)
  throw arrayInScalar()
}

// Number → string. An integral value prints as an exact integer, however
// large (gawk: `print 2^70` is 1180591620717411303424); anything else
// goes through the awk format — CONVFMT for string conversions, OFMT for
// print. `%.6g` by default, which is why `print 1/3` shows `0.333333`.
// Infinities and NaN carry an explicit sign, as gawk prints them; JS has
// no NaN sign, and `-nan` is what x86 produces for the usual sources
// (log(-1), inf - inf).
const FORMAT_CACHE = new Map()

export function numToStr(n, fmt) {
  if (Number.isNaN(n)) throw new AwkError('formatting signed NaN is not supported', null, 'signed NaN')
  if (!Number.isFinite(n)) return n < 0 ? '-inf' : '+inf'
  if (Number.isInteger(n)) return Math.abs(n) < 2 ** 53 ? String(n) : BigInt(n).toString()
  let pieces = FORMAT_CACHE.get(fmt)
  if (pieces === undefined) {
    if (FORMAT_CACHE.size > 64) FORMAT_CACHE.clear()
    pieces = parseFormat(fmt)
    const specs = pieces.filter((piece) => typeof piece !== 'string')
    if (specs.length > 1 || specs.some((spec) => !'diouxXeEfFgG'.includes(spec.conv) || spec.width === '*' || spec.precision === '*')) throw new AwkError('this numeric conversion format is not supported', null, 'numeric conversion format')
    FORMAT_CACHE.set(fmt, pieces)
  }
  return pieces.map((piece) => typeof piece === 'string' ? piece : formatNumeric(n, piece)).join('')
}

const fmtOf = (v) => (typeof v === 'string' ? v : v instanceof StrNum ? v.s : '%.6g')

export const convfmt = (m) => fmtOf(m.globals.get('CONVFMT'))
export const ofmt = (m) => fmtOf(m.globals.get('OFMT'))

export function toStr(v, m) {
  if (typeof v === 'string') return checkText(m, v)
  if (v instanceof StrNum) return checkText(m, v.s)
  if (typeof v === 'number') return numToStr(v, convfmt(m))
  if (v === undefined) return ''
  throw arrayInScalar()
}

export function byteLocale(ctx) {
  return ['C', 'POSIX'].includes(ctx.vars.get('LC_ALL') || ctx.vars.get('LC_CTYPE') || ctx.vars.get('LANG'))
}

export function checkText(m, text) {
  if (m.byteLocale && /[\u0080-\u{10FFFF}]/u.test(text)) throw new AwkError('non-ASCII AWK text in a byte locale is not supported', null, 'byte locale text')
  return text
}

export function foldCase(text, upper = false) {
  return [...text].map((char) => {
    const mapped = upper ? char.toUpperCase() : char.toLowerCase()
    if ([...mapped].length !== 1) throw new AwkError('Unicode case expansion is not supported', null, 'Unicode case mapping')
    return mapped
  }).join('')
}

// `print` converts numbers with OFMT rather than CONVFMT; otherwise the
// same as toStr.
export function toOutStr(v, m) {
  return typeof v === 'number' ? numToStr(v, ofmt(m)) : toStr(v, m)
}

const isNumericValue = (v) => typeof v === 'number' || v === undefined || (v instanceof StrNum && looksNumeric(v.s))

// gawk's IGNORECASE: regex matching, string comparison and index()
// ignore case while it is non-zero.
export const ignoreCase = (m) => truthy(m.globals.get('IGNORECASE'))

// POSIX comparison rule: numeric when BOTH sides are numbers, numeric
// strings, or uninitialized; string otherwise. Returns -1 / 0 / 1, or
// NaN when a NaN is involved (unordered: every test but `!=` is false).
export function compare(a, b, m) {
  if (isNumericValue(a) && isNumericValue(b)) {
    const x = toNum(a)
    const y = toNum(b)
    return x < y ? -1 : x > y ? 1 : x === y ? 0 : Number.NaN
  }
  let s = toStr(a, m)
  let t = toStr(b, m)
  if (ignoreCase(m)) { s = foldCase(s); t = foldCase(t) }
  return compareNames(s, t)
}

// Truth: a number is true when non-zero, a string when non-empty, and a
// numeric string follows its numeric value — so the input field `0` is
// false but the constant `"0"` is true.
export function truthy(v) {
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v)
  if (typeof v === 'string') return v !== ''
  if (v instanceof StrNum) return looksNumeric(v.s) ? toNum(v) !== 0 : v.s !== ''
  if (v === undefined) return false
  throw arrayInScalar()
}

// Array subscripts are strings; numbers convert with CONVFMT, so
// `a[0.1 + 0.2]` and `a["0.3"]` name the same element.
export const subscriptKey = (v, m) => toStr(v, m)

// gawk's typeof(): the type of a cell as the program sees it.
export function typeName(v) {
  if (v instanceof Map) return 'array'
  if (v === undefined) return 'untyped'
  if (typeof v === 'number') return 'number'
  if (v instanceof StrNum) return looksNumeric(v.s) ? 'strnum' : 'string'
  return 'string'
}
