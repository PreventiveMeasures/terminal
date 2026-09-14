import { formatNumeric, padField } from '../awk/format.js'
import { UnsupportedError } from '../unsupported.js'
import { decodeUtf8 } from '../bytes.js'
import { encodeUtf8Loose } from '../util.js'
import { INT64_MAX, INT64_MIN, UINT64_MAX } from '../numeric.js'

// strtoimax reads a binary literal as well as the hexadecimal and octal ones,
// and only for an integer: `%f` reads `0b1` as `0` and the rest left over.
const INTEGER = /^[+-]?(?:0[bB][01]+|0[xX][\da-fA-F]+|0[0-7]*|[1-9]\d*)/u
const FLOAT = /^[+-]?(?:0[xX](?:[\da-fA-F]+(?:\.[\da-fA-F]*)?|\.[\da-fA-F]+)(?:[pP][+-]?\d+)?|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|inf(?:inity)?|nan(?:\([\w]*\))?)/iu

// A quote with nothing after it is no character constant, so it is read as
// the number it is not. What follows the character is ignored, and said to be.
function charConstant(arg, state) {
  if (arg?.[0] !== "'" && arg?.[0] !== '"') return null
  const body = arg.slice(1)
  if (body === '') return null
  const bytes = encodeUtf8Loose(body)
  const width = state.byteLocale ? 1 : encodeUtf8Loose(String.fromCodePoint(body.codePointAt(0))).length
  if (bytes.length > width) {
    state.stderr += `printf: warning: ${decodeUtf8(bytes.slice(width))}: character(s) following character constant have been ignored\n`
  }
  return state.byteLocale ? bytes[0] : body.codePointAt(0)
}

// An operand with nothing in it is zero, which is what strtoimax makes of it.
function numberPrefix(arg, pattern, state) {
  if (arg === undefined || arg === '') return '0'
  const text = arg.replace(/^[ \t\n\r\f\v]+/u, '')
  const parsed = pattern.exec(text)?.[0] ?? ''
  if (parsed.length !== text.length || parsed === '') {
    state.stderr += `printf: ${quoted(arg, state)}: ${parsed ? 'value not completely converted' : 'expected a numeric value'}\n`
    state.failed = true
  }
  return parsed || '0'
}

const ESCAPES = { '\u0007': '\\a', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\v': '\\v', '\f': '\\f', '\r': '\\r', '\\': '\\\\', "'": "\\'" }
const octal = (byte) => '\\' + byte.toString(8).padStart(3, '0')

// GNU names an operand it could not read the way it would have to be written
// to be handed back: single-quoted, with what the quotes cannot carry spelled
// out. A byte locale has no character above 127 to print, so those are octal.
function quoted(text, state) {
  let out = ''
  for (const char of text) {
    if (ESCAPES[char] !== undefined) { out += ESCAPES[char]; continue }
    const code = char.codePointAt(0)
    if (code < 0x20 || code === 0x7f) { out += octal(code); continue }
    out += code > 0x7f && state.byteLocale ? encodeUtf8Loose(char).map(octal).join('') : char
  }
  return `'${out}'`
}

export function printfInteger(arg, unsigned, state) {
  const char = charConstant(arg, state)
  if (char !== null) return BigInt(char)
  const parsed = numberPrefix(arg, INTEGER, state)
  const negative = parsed[0] === '-'
  const digits = parsed.replace(/^[+-]/u, '')
  const magnitude = BigInt(/^0[0-7]+$/u.test(digits) ? '0o' + digits : digits)
  const value = negative ? -magnitude : magnitude
  if (unsigned ? magnitude > UINT64_MAX : value < INT64_MIN || value > INT64_MAX) {
    state.stderr += `printf: ${quoted(arg, state)}: Numerical result out of range\n`
    state.failed = true
    return unsigned ? UINT64_MAX : negative ? INT64_MIN : INT64_MAX
  }
  return unsigned ? BigInt.asUintN(64, value) : value
}

export function printfIntegerField(value, spec) {
  const { conv } = spec
  const signed = conv === 'd' || conv === 'i'
  const negative = value < 0n
  const base = conv === 'o' ? 8 : conv === 'x' || conv === 'X' ? 16 : 10
  let digits = (negative ? -value : value).toString(base)
  if (conv === 'X') digits = digits.toUpperCase()
  if (value === 0n && spec.precision === 0) digits = ''
  digits = digits.padStart(spec.precision ?? 0, '0')
  let prefix = negative ? '-' : signed ? spec.plus ? '+' : spec.space ? ' ' : '' : ''
  if (spec.alt) {
    if (conv === 'o' && !digits.startsWith('0')) digits = '0' + digits
    if (value !== 0n && (conv === 'x' || conv === 'X')) prefix = conv === 'x' ? '0x' : '0X'
  }
  return padField(prefix, digits, spec, spec.precision === null)
}

export function printfFloatField(arg, spec, state) {
  const char = charConstant(arg, state)
  const parsed = char === null ? numberPrefix(arg, FLOAT, state) : String(char)
  const unsigned = parsed.replace(/^[+-]/u, '')
  if (/^(?:inf|nan)/iu.test(unsigned)) {
    const prefix = parsed.startsWith('-') ? '-' : spec.plus ? '+' : spec.space ? ' ' : ''
    let body = /^nan/iu.test(unsigned) ? 'nan' : 'inf'
    if (spec.conv === spec.conv.toUpperCase()) body = body.toUpperCase()
    return padField(prefix, body, spec, false)
  }
  const number = floatNumber(unsigned)
  const value = parsed.startsWith('-') ? -number.value : number.value
  // The shared formatter works in binary64. Guard its bounded decimal
  // expansion rather than silently rounding extra requested digits away.
  if (spec.precision > 100 || ('gG'.includes(spec.conv) && spec.precision > 96)) {
    throw new UnsupportedError('feature', 'float precision limit', 'floating-point precision exceeds the supported limit')
  }
  try {
    const result = formatNumeric(value, spec)
    if (!number.exact) {
      const [lower, upper] = neighbors(number.value)
      for (const adjacent of [lower, upper]) {
        if (formatNumeric(parsed.startsWith('-') ? -adjacent : adjacent, spec) !== result) {
          throw new UnsupportedError('feature', 'floating-point precision', 'floating-point formatting at this precision is not supported')
        }
      }
    }
    return result
  } catch (e) {
    if (e.gap) throw new UnsupportedError('feature', e.gap, e.message)
    throw e
  }
}

const bitsView = new DataView(new ArrayBuffer(8))

function floatBits(value) {
  bitsView.setFloat64(0, value)
  return bitsView.getBigUint64(0)
}

function neighbors(value) {
  const bits = floatBits(value)
  bitsView.setBigUint64(0, bits - 1n)
  const lower = bitsView.getFloat64(0)
  bitsView.setBigUint64(0, bits + 1n)
  return [lower, bitsView.getFloat64(0)]
}

function binaryParts(value) {
  const bits = floatBits(value)
  const exponent = Number(bits >> 52n)
  return { coefficient: (bits & ((1n << 52n) - 1n)) | (exponent ? 1n << 52n : 0n), exponent: exponent ? exponent - 1075 : -1074 }
}

function decimalParts(digits, exponent) {
  const significant = digits.replace(/^0+|0+$/gu, '')
  return { digits: significant || '0', exponent: significant ? exponent + digits.length - digits.replace(/0+$/u, '').length : 0 }
}

function numberDecimal({ coefficient, exponent }) {
  return exponent < 0
    ? decimalParts((coefficient * 5n ** BigInt(-exponent)).toString(), exponent)
    : decimalParts((coefficient << BigInt(exponent)).toString(), 0)
}

function sameBinary(left, right) {
  const shift = left.exponent - right.exponent
  return shift >= 0
    ? left.coefficient << BigInt(shift) === right.coefficient
    : left.coefficient === right.coefficient << BigInt(-shift)
}

// Shell printf may parse floats more precisely than binary64. Inexact inputs
// are usable only when both adjacent doubles format identically. Exact inputs
// can bypass that guard if their complete decimal expansion fits the shared
// formatter's 100-digit tie detection window.
function floatNumber(text) {
  const hex = /^0x/iu.test(text)
  let source, value
  if (hex) {
    source = hexParts(text)
    value = hexNumber(source)
  } else {
    const [mantissa, exponent = '0'] = text.split(/[eE]/u)
    const [whole, fraction = ''] = mantissa.split('.')
    source = decimalParts(whole + fraction, Number(exponent) - fraction.length)
    value = Number(text)
  }
  if (!Number.isFinite(value)) throw new UnsupportedError('feature', 'floating-point range', 'floating-point values outside the JavaScript number range are not supported')
  if (value === 0) {
    if (hex ? source.coefficient !== 0n : source.digits !== '0') throw new UnsupportedError('feature', 'floating-point range', 'floating-point underflow is not supported')
    return { value, exact: true }
  }
  const binary = binaryParts(value)
  const decimal = numberDecimal(binary)
  const same = hex ? sameBinary(source, binary) : source.digits === decimal.digits && source.exponent === decimal.exponent
  return { value, exact: same && decimal.exponent >= -100 && decimal.digits.length <= 101 }
}

function hexParts(text) {
  const [mantissa, exponent = '0'] = text.slice(2).split(/[pP]/u)
  const [whole, fraction = ''] = mantissa.split('.')
  const digits = (whole + fraction).replace(/^0+/u, '') || '0'
  if (digits.length > 4096) throw new UnsupportedError('feature', 'floating-point input limit', 'hexadecimal floating-point significands above 4096 digits are not supported')
  return { coefficient: BigInt('0x' + digits), exponent: Number(exponent) - 4 * fraction.length }
}

// Round the full significand once, including at the subnormal boundary.
// Scaling separate whole/fraction pieces can overflow even for finite input.
function hexNumber({ coefficient, exponent }) {
  if (coefficient === 0n) return 0
  const length = coefficient.toString(2).length
  const power = exponent + length - 1
  if (power > 1023) return Infinity
  if (power < -1075) return 0
  const shift = Math.max(0, length - 53, -1074 - exponent)
  let rounded = coefficient >> BigInt(shift)
  if (shift > 0) {
    const remainder = coefficient - (rounded << BigInt(shift))
    const half = 1n << BigInt(shift - 1)
    if (remainder > half || (remainder === half && rounded % 2n !== 0n)) rounded++
  }
  return Number(rounded) * 2 ** (exponent + shift)
}
