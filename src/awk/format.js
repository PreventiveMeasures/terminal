// Format parsing and numeric rendering shared by ./printf.js (arguments)
// and ./value.js (CONVFMT/OFMT).

// `%[flags][width][.precision][length]conv`. Width and precision are a
// number, `*` (taken from the argument list at print time), or null.
// The `'` (thousands grouping) flag and one `h` / `l` / `L` length
// modifier are accepted and ignored, as gawk does in the C locale. A
// `%` conversion (`%%`, or `%5%`) is a percent sign; an unknown
// conversion stays literal text.
import { AwkError, MAX_FIELD_WIDTH } from './common.js'

const SPEC = /^%([-+ 0#']*)(\d+|\*)?'?(?:\.(\d+|\*)?)?[hlL]?(.)?/su
const CONVERSIONS = 'diouxXeEfFgGcs'

export function parseFormat(fmt) {
  const pieces = []
  let lit = ''
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== '%') { lit += fmt[i]; continue }
    if (fmt[i + 1] === '%') { lit += '%'; i++; continue }
    if (/^%[^a-zA-Z%]*\$/u.test(fmt.slice(i))) throw new AwkError('positional printf arguments are not supported', null, 'positional format arguments')
    const m = SPEC.exec(fmt.slice(i))
    const conv = m[4]
    if (conv === 'a' || conv === 'A') throw new AwkError('hexadecimal floating-point formats are not supported', null, 'hexadecimal float format')
    if (conv === '%') { lit += '%'; i += m[0].length - 1; continue }
    if (conv === undefined || !CONVERSIONS.includes(conv)) {
      // `%` at the very end, or `%y`: printed as typed.
      lit += m[0]; i += m[0].length - 1
      continue
    }
    if (lit !== '') { pieces.push(lit); lit = '' }
    const flags = m[1]
    pieces.push({
      minus: flags.includes('-'),
      plus: flags.includes('+'),
      space: flags.includes(' '),
      zero: flags.includes('0'),
      alt: flags.includes('#'),
      width: m[2] === undefined ? null : m[2] === '*' ? '*' : Number(m[2]),
      // `%.d` is precision 0, like C.
      precision: m[3] === undefined ? (m[0].includes('.') ? 0 : null) : m[3] === '*' ? '*' : Number(m[3]),
      conv,
    })
    i += m[0].length - 1
  }
  if (lit !== '') pieces.push(lit)
  return pieces
}

// Pad `prefix + body` to the spec's width. `-` left-justifies with
// spaces; `0` pads with zeros between the sign/base prefix and the
// digits, but only where C allows it (numeric conversions, and for
// integers only when no precision was given) — the caller says so via
// `zeroOk`.
export function padField(prefix, body, spec, zeroOk) {
  const width = spec.width ?? 0
  if (width > MAX_FIELD_WIDTH) throw new AwkError('format width exceeds the output limit', null, 'format size limit')
  const missing = width - prefix.length - [...body].length
  if (missing <= 0) return prefix + body
  if (spec.minus) return prefix + body + ' '.repeat(missing)
  if (spec.zero && zeroOk) return prefix + '0'.repeat(missing) + body
  return ' '.repeat(missing) + prefix + body
}

const signPrefix = (spec) => (spec.plus ? '+' : spec.space ? ' ' : '')
const isUpper = (conv) => conv === 'X' || conv === 'E' || conv === 'G' || conv === 'F'

// Numeric conversions apply width and flags; infinities always carry a sign
// and ignore width. NaN formatting is diagnosed because JS loses its sign.
export function formatNumeric(value, spec) {
  if (spec.precision > MAX_FIELD_WIDTH) throw new AwkError('format precision exceeds the output limit', null, 'format size limit')
  const { conv } = spec
  if (!Number.isFinite(value)) {
    if (Number.isNaN(value)) throw new AwkError('formatting signed NaN is not supported', null, 'signed NaN')
    const text = value < 0 ? '-inf' : '+inf'
    return isUpper(conv) ? text.toUpperCase() : text
  }
  // An unsigned conversion of a value outside the 64-bit range prints
  // as `%g` with the same flags, width and precision (gawk's "emergency
  // use of %g"); `%d` / `%i` print every digit however large.
  if ('ouxX'.includes(conv) && (value >= 2 ** 64 || value < -(2 ** 63))) return formatFloat(value, { ...spec, conv: 'g' })
  return 'diouxX'.includes(conv) ? formatInteger(value, spec) : formatFloat(value, spec)
}

// The zero cases follow gawk. `%d` / `%i` with precision 0 print no
// digits (and no sign) for a value that TRUNCATES to zero; the unsigned
// conversions test the original double instead — 1e-6 is not zero, so
// `%#o` of it is `00` and `%.0u` of it is `0`, while an exact 0 gives
// `0` and nothing.
function formatInteger(value, spec) {
  const { conv } = spec
  const signed = conv === 'd' || conv === 'i'
  const zero = signed ? Math.trunc(value) === 0 : value === 0
  // BigInt keeps huge values exact and avoids JS's `1e+21` rendering.
  let big = BigInt(Math.trunc(value))
  let negative = false
  if (big < 0n) {
    if (signed) { negative = true; big = -big }
    // Unsigned conversions wrap like a 64-bit C unsigned: `%x` of -1
    // is ffffffffffffffff.
    else big = BigInt.asUintN(64, big)
  }
  const base = conv === 'o' ? 8 : conv === 'x' || conv === 'X' ? 16 : 10
  let digits = big.toString(base)
  if (conv === 'X') digits = digits.toUpperCase()
  if (spec.precision !== null) {
    if (spec.precision === 0 && zero) digits = spec.alt && !signed ? '0' : ''
    else digits = digits.padStart(spec.precision, '0')
  }
  let prefix = negative ? '-' : signed && digits !== '' ? signPrefix(spec) : ''
  if (spec.alt && !zero) {
    if (conv === 'o') digits = '0' + digits
    if (conv === 'x' || conv === 'X') prefix += conv === 'x' ? '0x' : '0X'
  }
  return padField(prefix, digits, spec, spec.precision === null)
}

// toFixed / toExponential cap their digit count at 100.
const MAX_FLOAT_PRECISION = 100

function formatFloat(value, spec) {
  const { conv } = spec
  if (spec.precision > MAX_FLOAT_PRECISION) throw new AwkError(`floating-point precision above ${MAX_FLOAT_PRECISION} is not supported`, null, 'float precision limit')
  const prec = spec.precision ?? 6
  const negative = value < 0 || Object.is(value, -0)
  const abs = Math.abs(value)
  let body
  if (conv === 'e' || conv === 'E') body = exponential(abs, prec)
  else if (conv === 'f' || conv === 'F') body = fixed(abs, prec)
  else body = general(abs, prec, spec.alt)
  // `#` keeps the decimal point even with nothing after it.
  if (spec.alt && prec === 0 && conv !== 'g' && conv !== 'G') {
    body = conv === 'e' || conv === 'E' ? body.replace('e', '.e') : body + '.'
  }
  if (isUpper(conv)) body = body.toUpperCase()
  return padField(negative ? '-' : signPrefix(spec), body, spec, true)
}

// C rounds ties to even; JS rounds up. When the 100-digit expansion shows
// exactly 5 followed by zeros, keep an even last digit instead of rounding.
function tieToEven(rounded, exact, keptEnd, tailStart) {
  const tail = exact.slice(tailStart)
  if (!/^50*$/u.test(tail)) return rounded
  const kept = exact.slice(0, keptEnd)
  const last = kept.at(-1)
  return Number(last) % 2 === 0 ? kept : rounded
}

// JS writes `1.5e+4`; C writes `1.5e+04` (at least two exponent digits).
function exponential(abs, prec) {
  const exact = abs.toExponential(MAX_FLOAT_PRECISION)
  const dot = exact.indexOf('.')
  const e = exact.indexOf('e')
  const [roundedMantissa, roundedExponent] = abs.toExponential(prec).split('e')
  const mantissa = tieToEven(roundedMantissa, exact.slice(0, e), prec === 0 ? dot : dot + 1 + prec, dot + 1 + prec)
  // The rounded mantissa may have carried into a new power of ten
  // (9.95 → 1.0e+1); take the exponent from the rounded form then.
  const exp = Number(mantissa === roundedMantissa ? roundedExponent : exact.slice(e + 1))
  return `${mantissa}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
}

// toFixed itself switches to exponent form at 1e21; C never does.
function fixed(abs, prec) {
  if (abs >= 1e21) return BigInt(abs).toString() + (prec > 0 ? '.' + '0'.repeat(prec) : '')
  const exact = abs.toFixed(MAX_FLOAT_PRECISION)
  const dot = exact.indexOf('.')
  return tieToEven(abs.toFixed(prec), exact, prec === 0 ? dot : dot + 1 + prec, dot + 1 + prec)
}

// %g uses P significant digits (0 means 1): exponent form for X < -4 or
// X >= P, fixed otherwise. Drop trailing zeros unless # is present.
function general(abs, precision, alt) {
  const p = precision === 0 ? 1 : precision
  if (abs === 0) return alt ? '0.' + '0'.repeat(p - 1) : '0'
  const e = exponential(abs, p - 1)
  const at = e.indexOf('e')
  const x = Number(e.slice(at + 1))
  if (x < -4 || x >= p) {
    if (alt) return e.includes('.') ? e : e.slice(0, at) + '.' + e.slice(at)
    return stripZeros(e.slice(0, at)) + e.slice(at)
  }
  const s = fixed(abs, p - 1 - x)
  // `#` keeps the decimal point too: `%#.0g` of 1 is `1.`.
  return alt ? (s.includes('.') ? s : s + '.') : stripZeros(s)
}

const stripZeros = (s) => (s.includes('.') ? s.replace(/\.?0+$/u, '') : s)
