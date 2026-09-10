import { lookup } from '../fs.js'
import { err, ok } from '../util.js'
import { UnsupportedError, unsupportedFrom } from '../unsupported.js'
import { INT64_MAX, INT64_MIN } from '../numeric.js'

const UNARY_GAPS = new Set(['-b', '-c', '-g', '-h', '-k', '-p', '-r', '-s', '-t', '-u', '-v', '-w', '-x', '-G', '-L', '-N', '-O', '-R', '-S', '-o'])
const BINARY_GAPS = new Set(['-nt', '-ot', '-ef', '<', '>'])
export const INTEGER_TESTS = {
  __proto__: null,
  '-eq': (left, right) => left === right,
  '-ne': (left, right) => left !== right,
  '-lt': (left, right) => left < right,
  '-le': (left, right) => left <= right,
  '-gt': (left, right) => left > right,
  '-ge': (left, right) => left >= right,
}
const INTEGER_DIGITS = String(INT64_MAX).length
const STREAMS = new Set(['/dev/stdin', '/dev/stdout', '/dev/stderr'])

export function test(_stdin, tokens, ctx) {
  return runTest('test', tokens, ctx)
}

export function bracket(_stdin, tokens, ctx) {
  if (tokens.at(-1) !== ']') return err("[: missing `]'", 2)
  return runTest('[', tokens.slice(0, -1), ctx)
}

function runTest(name, tokens, ctx) {
  try {
    return { ...ok(), exitCode: evaluate(tokens, ctx) ? 0 : 1 }
  } catch (e) {
    return unsupportedFrom(e, name, `${name}: ${e.message}`, 2)
  }
}

// Argument-count rules make lone operators strings and give binary tests
// precedence over negation: `test ! = !` is a string comparison.
function evaluate(tokens, ctx) {
  const [first, second, third] = tokens
  if (tokens.length === 0) return false
  if (tokens.length === 1) return first !== ''
  if (tokens.length === 2) {
    if (first === '!') return second === ''
    if (first === '-n') return second !== ''
    if (first === '-z') return second === ''
    if (['-a', '-e', '-f', '-d'].includes(first)) return fileTest(first, second, ctx)
    if (UNARY_GAPS.has(first)) gap(first)
    throw new Error(`${first}: unary operator expected`)
  }
  if (tokens.length === 3) {
    if (second === '=' || second === '==') return first === third
    if (second === '!=') return first !== third
    if (Object.hasOwn(INTEGER_TESTS, second)) return INTEGER_TESTS[second](integerOperand(first), integerOperand(third))
    if (BINARY_GAPS.has(second)) gap(second)
    if (second === '-a' || second === '-o') gap('compound expressions')
  }
  if (tokens.length <= 4) {
    if (first === '!') return !evaluate(tokens.slice(1), ctx)
    if (first === '(' && tokens.at(-1) === ')') return evaluate(tokens.slice(1, -1), ctx)
  }
  if (tokens.some((token) => ['-a', '-o', '!', '(', ')'].includes(token))) gap('compound expressions')
  throw new Error(tokens.length > 3 ? 'too many arguments' : `${second}: binary operator expected`)
}

function integerOperand(operand) {
  // Bash test uses decimal strtoimax, with C leading whitespace but only
  // space/tab after the number. Check the full match because JS $ permits LF.
  const match = /^[ \t\n\r\f\v]*([+-]?)(\d+)[ \t]*$/u.exec(operand)
  if (match && match[0].length === operand.length) {
    const digits = match[2].replace(/^0+/u, '') || '0'
    if (digits.length <= INTEGER_DIGITS) {
      const value = BigInt(match[1] + digits)
      if (value >= INT64_MIN && value <= INT64_MAX) return value
    }
  }
  throw new Error(`${operand}: integer expression expected`)
}

export function fileTest(operator, operand, ctx) {
  // Stream paths and /dev/null are reserved by the shell even without source
  // map entries. Their parent must exist for component-by-component lookup.
  const fs = {
    isDir: (path) => path === '/dev' || path === '/dev/fd' || ctx.fs.isDir(path),
    isFile: (path) => path === '/dev/null' || isStream(path) || ctx.fs.isFile(path),
  }
  const { path, error } = lookup(ctx.cwd, operand, fs)
  if (error) return false
  if (isStream(path)) gap('stream device metadata')
  if (operator === '-e' || operator === '-a') return true
  if (operator === '-d') return fs.isDir(path)
  return path !== '/dev/null' && ctx.fs.isFile(path)
}

function isStream(path) {
  return STREAMS.has(path) || /^\/dev\/fd\/\d+$/u.test(path)
}

function gap(detail) {
  throw new UnsupportedError('feature', detail, `${detail} is not supported`)
}
