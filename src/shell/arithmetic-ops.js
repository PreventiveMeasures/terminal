import { UnsupportedError } from '../unsupported.js'

export const signed = (value) => BigInt.asIntN(64, value)
export const arithmeticError = (detail, message) => new UnsupportedError('feature', 'arithmetic ' + detail, 'arithmetic expansion: ' + message)

export function integerLiteral(text) {
  let base = 10n, foundBase = false, value = 0n
  let at = 0
  if (text[0] === '0') {
    at = 1
    base = 8n
    foundBase = true
    if (text[1] === 'x' || text[1] === 'X') { base = 16n; at = 2 }
  }
  if (at === 2 && text.length === 2) throw arithmeticError('number', 'hexadecimal constant has no digits')
  for (; at < text.length; at++) {
    const c = text[at]
    if (c === '#') {
      if (foundBase || value < 2n || value > 64n || at === text.length - 1) throw arithmeticError('number', 'invalid arithmetic base or integer constant')
      base = value
      value = 0n
      foundBase = true
      continue
    }
    const code = c.codePointAt(0)
    const digit = code >= 48 && code <= 57 ? code - 48 : code >= 97 && code <= 122 ? code - 87
      : code >= 65 && code <= 90 ? code - (base <= 36n ? 55 : 29) : c === '@' ? 62 : c === '_' ? 63 : -1
    if (digit < 0 || BigInt(digit) >= base) throw arithmeticError('number', 'value too great for base in ' + text.slice(0, 40))
    value = signed(value * base + BigInt(digit))
  }
  return value
}

function power(base, exponent) {
  if (exponent < 0n) throw arithmeticError('exponent', 'exponent less than zero')
  let result = 1n
  for (let n = exponent, value = base; n !== 0n; n >>= 1n, value = signed(value * value)) {
    if (n & 1n) result = signed(result * value)
  }
  return result
}

export function binaryArithmetic(op, a, b, active) {
  switch (op) {
    case '+': return signed(a + b)
    case '-': return signed(a - b)
    case '*': return signed(a * b)
    case '/': case '%': {
      if (b === 0n && active) throw arithmeticError('division', 'division by zero')
      const divisor = b === 0n ? 1n : b
      return signed(op === '/' ? a / divisor : a % divisor)
    }
    case '**': return power(a, b)
    case '<<': case '>>': {
      if (b < 0n || b > 63n) throw arithmeticError('shift count', 'shift counts outside 0..63 are not supported')
      return signed(op === '<<' ? a << b : a >> b)
    }
    case '&': return a & b
    case '^': return a ^ b
    case '|': return a | b
    case '<': return BigInt(a < b)
    case '<=': return BigInt(a <= b)
    case '>': return BigInt(a > b)
    case '>=': return BigInt(a >= b)
    case '==': return BigInt(a === b)
    case '!=': return BigInt(a !== b)
    default: throw arithmeticError('operator', 'unsupported operator ' + op)
  }
}
