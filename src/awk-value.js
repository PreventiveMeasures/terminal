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
import { formatNumeric, parseFormat } from './awk-format.js'

export class StrNum {
  constructor(s) { this.s = s }
}

const BLANK = '[ \\t\\n\\r\\f\\v]*'
const NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?'
const NUMERIC_RE = new RegExp(`^${BLANK}${NUMBER}${BLANK}$`, 'u')
const PREFIX_RE = new RegExp(`^${BLANK}(${NUMBER})`, 'u')

// "Looks numeric": the whole string, blanks aside, is a decimal number.
// Hex (`0x10`) and `inf`/`nan` spellings are not numbers here — that is
// gawk's default reading, and the one POSIX describes.
export const looksNumeric = (s) => NUMERIC_RE.test(s)

// String → number conversion takes the longest numeric PREFIX, like C's
// strtod: `"3x"` is 3, `" 4 "` is 4, `"abc"` is 0.
function parsePrefix(s) {
  const m = PREFIX_RE.exec(s)
  return m ? Number(m[1]) : 0
}

const arrayInScalar = () => new AwkError('attempt to use an array in a scalar context')

export function toNum(v) {
  if (typeof v === 'number') return v
  if (v === undefined) return 0
  if (v instanceof StrNum) return parsePrefix(v.s)
  if (typeof v === 'string') return parsePrefix(v)
  throw arrayInScalar()
}

// Number → string. Integral values print as integers (up to the point
// where JS itself would switch to exponent notation, 1e21); everything
// else goes through the awk format — CONVFMT for string conversions,
// OFMT for print. `%.6g` by default, which is why `print 1/3` shows
// `0.333333`.
const FORMAT_CACHE = new Map()

export function numToStr(n, fmt) {
  if (Number.isNaN(n)) return 'nan'
  if (!Number.isFinite(n)) return n < 0 ? '-inf' : 'inf'
  if (Number.isInteger(n) && Math.abs(n) < 1e21) {
    // Past 2^53 String() rounds the low digits (`2^62` → ...388000);
    // BigInt prints the exact value the double holds, as gawk does.
    return Math.abs(n) < 2 ** 53 ? String(n) : BigInt(n).toString()
  }
  let spec = FORMAT_CACHE.get(fmt)
  if (spec === undefined) {
    if (FORMAT_CACHE.size > 64) FORMAT_CACHE.clear()
    const pieces = parseFormat(fmt).filter((piece) => typeof piece !== 'string')
    // A CONVFMT that is not a single numeric conversion is a user error
    // gawk tolerates loosely; fall back to the default rather than guess.
    spec = pieces.length === 1 && 'diouxXeEfFgG'.includes(pieces[0].conv) && pieces[0].width !== '*' && pieces[0].precision !== '*'
      ? pieces[0]
      : parseFormat('%.6g')[0]
    FORMAT_CACHE.set(fmt, spec)
  }
  return formatNumeric(n, spec)
}

const fmtOf = (v) => (typeof v === 'string' ? v : v instanceof StrNum ? v.s : '%.6g')

export const convfmt = (m) => fmtOf(m.globals.get('CONVFMT'))
export const ofmt = (m) => fmtOf(m.globals.get('OFMT'))

export function toStr(v, m) {
  if (typeof v === 'string') return v
  if (v instanceof StrNum) return v.s
  if (typeof v === 'number') return numToStr(v, convfmt(m))
  if (v === undefined) return ''
  throw arrayInScalar()
}

// `print` converts numbers with OFMT rather than CONVFMT; otherwise the
// same as toStr.
export function toOutStr(v, m) {
  return typeof v === 'number' ? numToStr(v, ofmt(m)) : toStr(v, m)
}

const isNumericValue = (v) => typeof v === 'number' || v === undefined || (v instanceof StrNum && looksNumeric(v.s))

// POSIX comparison rule: numeric when BOTH sides are numbers, numeric
// strings, or uninitialized; string otherwise. Returns -1 / 0 / 1.
export function compare(a, b, m) {
  if (isNumericValue(a) && isNumericValue(b)) {
    const x = toNum(a)
    const y = toNum(b)
    return x < y ? -1 : x > y ? 1 : 0
  }
  const s = toStr(a, m)
  const t = toStr(b, m)
  return s < t ? -1 : s > t ? 1 : 0
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
