// The printf-format core, on plain JS numbers and strings: parsing a
// format string into literal runs and conversion specs, and rendering
// one numeric conversion the way C's printf would. awk-printf.js layers
// the argument handling (`*`, awk value conversion, `%c` / `%s`) on
// top; awk-value.js uses formatNumeric directly for CONVFMT / OFMT.

// `%[flags][width][.precision][length]conv`. Width and precision are a
// number, `*` (taken from the argument list at print time), or null.
// The `'` (thousands grouping) flag and one `h` / `l` / `L` length
// modifier are accepted and ignored, as gawk does in the C locale. A
// `%` conversion (`%%`, or `%5%`) is a percent sign; an unknown
// conversion stays literal text.
const SPEC = /^%([-+ 0#']*)(\d+|\*)?'?(?:\.(\d+|\*)?)?[hlL]?(.)?/su
const CONVERSIONS = 'diouxXeEfFgGcs'

export function parseFormat(fmt) {
  const pieces = []
  let lit = ''
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== '%') { lit += fmt[i]; continue }
    if (fmt[i + 1] === '%') { lit += '%'; i++; continue }
    const m = SPEC.exec(fmt.slice(i))
    const conv = m[4]
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
  const missing = width - prefix.length - body.length
  if (missing <= 0) return prefix + body
  if (spec.minus) return prefix + body + ' '.repeat(missing)
  if (spec.zero && zeroOk) return prefix + '0'.repeat(missing) + body
  return ' '.repeat(missing) + prefix + body
}

const signPrefix = (spec) => (spec.plus ? '+' : spec.space ? ' ' : '')
const isUpper = (conv) => conv === 'X' || conv === 'E' || conv === 'G' || conv === 'F'

// Render a number for one of the numeric conversions (d i o u x X e E
// f F g G), width and flags applied. Infinities and NaN always carry a
// sign, follow the conversion's case, and take no width — exactly what
// gawk prints for them.
export function formatNumeric(value, spec) {
  const { conv } = spec
  if (!Number.isFinite(value)) {
    const body = Number.isNaN(value) ? 'nan' : 'inf'
    const text = (value < 0 || Number.isNaN(value) ? '-' : '+') + body
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
  const prec = Math.min(spec.precision ?? 6, MAX_FLOAT_PRECISION)
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

// C rounds an exact tie to the even digit (`%.0f` of 2.5 is `2`, `%.2f`
// of 0.125 is `0.12`); toFixed and toExponential round it up. A tie is
// exact only when the decimal expansion stops with a 5 right after the
// kept digits, and every double has a finite expansion that the 100-digit
// forms show verbatim — so look at those digits, and when they say tie
// and the kept digit is even, use the truncated digits instead.
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
  const mantissa = tieToEven(abs.toExponential(prec).split('e')[0], exact.slice(0, e), prec === 0 ? dot : dot + 1 + prec, dot + 1 + prec)
  // The rounded mantissa may have carried into a new power of ten
  // (9.95 → 1.0e+1); take the exponent from the rounded form then.
  const rounded = abs.toExponential(prec)
  const exp = Number(mantissa === rounded.split('e')[0] ? rounded.slice(rounded.indexOf('e') + 1) : exact.slice(e + 1))
  return `${mantissa}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
}

// toFixed itself switches to exponent form at 1e21; C never does.
function fixed(abs, prec) {
  if (abs >= 1e21) return BigInt(abs).toString() + (prec > 0 ? '.' + '0'.repeat(prec) : '')
  const exact = abs.toFixed(MAX_FLOAT_PRECISION)
  const dot = exact.indexOf('.')
  return tieToEven(abs.toFixed(prec), exact, prec === 0 ? dot : dot + 1 + prec, dot + 1 + prec)
}

// `%g`: precision P counts significant digits (0 reads as 1). Use `%e`
// style when the exponent X is below -4 or at least P, else `%f` with
// P-1-X decimals; then drop trailing zeros unless `#` asked to keep
// them. This is the conversion behind awk's `%.6g` default, so
// `100000` stays put, `1000000` becomes `1e+06`, and `0.0001` stays
// while `0.00001` becomes `1e-05`.
function general(abs, precision, alt) {
  const p = precision === 0 ? 1 : precision
  if (abs === 0) return alt ? '0.' + '0'.repeat(p - 1) : '0'
  const e = exponential(abs, p - 1)
  const x = Number(e.slice(e.indexOf('e') + 1))
  const at = e.indexOf('e')
  if (x < -4 || x >= p) {
    if (alt) return e.includes('.') ? e : e.slice(0, at) + '.' + e.slice(at)
    return stripZeros(e.slice(0, at)) + e.slice(at)
  }
  const s = fixed(abs, p - 1 - x)
  // `#` keeps the decimal point too: `%#.0g` of 1 is `1.`.
  return alt ? (s.includes('.') ? s : s + '.') : stripZeros(s)
}

const stripZeros = (s) => (s.includes('.') ? s.replace(/\.?0+$/u, '') : s)
