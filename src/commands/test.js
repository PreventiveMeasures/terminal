import { lookup } from '../fs.js'
import { encodeUtf8, err, ok, quoteLocale } from '../util.js'
import { UnsupportedError, unsupported, unsupportedFrom } from '../unsupported.js'
import { INT64_MAX, INT64_MIN } from '../numeric.js'

const UNARY_GAPS = new Set(['-b', '-c', '-g', '-k', '-p', '-r', '-t', '-u', '-v', '-w', '-x', '-G', '-N', '-O', '-R', '-S', '-o'])
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
  return runTest('test', tokens, ctx, BASH)
}

export function bracket(_stdin, tokens, ctx) {
  if (tokens.at(-1) !== ']') return err("[: missing `]'", 2)
  return runTest('[', tokens.slice(0, -1), ctx, BASH)
}

// coreutils' test and `[`, which a path, xargs and find -exec run. They
// read an expression as bash's builtin does, and say different things about
// one they cannot read: the operand quoted as quote() quotes it, a missing
// argument where bash expects a unary operator, and an extra one where bash
// counts too many. Their integers have no width, so a long one compares as
// the number it spells. `[ --help` and `[ --version` are questions `[`
// answers, which `test` reads as strings.
export function testProgram(_stdin, tokens, ctx, name = 'test') {
  return runTest(name, tokens, ctx, coreutilsFlavor(ctx))
}

export function bracketProgram(_stdin, tokens, ctx, name = '[') {
  if (tokens.length === 1 && (tokens[0] === '--help' || tokens[0] === '--version')) {
    return unsupported('option', '[', tokens[0], `${name}: ${tokens[0]} is not supported`, 2)
  }
  const flavor = coreutilsFlavor(ctx)
  if (tokens.at(-1) !== ']') return err(`${name}: missing ${flavor.quote(']')}`, 2)
  return runTest(name, tokens.slice(0, -1), ctx, flavor)
}

function runTest(name, tokens, ctx, flavor) {
  try {
    return { ...ok(), exitCode: evaluate(tokens, ctx, flavor) ? 0 : 1 }
  } catch (e) {
    return unsupportedFrom(e, name, `${name}: ${e.message}`, 2)
  }
}

// What each test says it could not read. bash names the word bare; coreutils
// quotes it, and past three words reads one expression and calls whatever
// is left over an extra argument.
const BASH = {
  unaryGap: (operator) => UNARY_GAPS.has(operator),
  integer: bashInteger,
  unary: (first) => `${first}: unary operator expected`,
  binary: (second) => `${second}: binary operator expected`,
  leftover: () => 'too many arguments',
}

// `-v` and `-R` are bash's alone; to coreutils they are no operators at all.
function coreutilsFlavor(ctx) {
  const quote = (text) => quoteLocale(text, ctx)
  const flavor = {
    quote,
    unaryGap: (operator) => UNARY_GAPS.has(operator) && operator !== '-v' && operator !== '-R',
    integer: (operand) => coreutilsInteger(operand, quote),
    unary: (first, last) => (SWITCH.test(first) ? `${quote(first)}: unary operator expected` : `missing argument after ${quote(last)}`),
    binary: (second) => `${quote(second)}: binary operator expected`,
    leftover: (tokens) => `extra argument ${quote(tokens[posixTerm(tokens, ctx, flavor)])}`,
  }
  return flavor
}

// The one term coreutils reads before the rest is extra: a binary test, a
// unary one, or a lone string; a term it cannot read is that term's error.
function posixTerm(tokens, ctx, flavor) {
  const width = tokens.length >= 3 && (BINARY_TESTS.has(tokens[1]) || BINARY_GAPS.has(tokens[1])) ? 3 : SWITCH.test(tokens[0]) ? 2 : 1
  if (width > 1) evaluate(tokens.slice(0, width), ctx, flavor)
  return width
}

const SWITCH = /^-.$/su
const BINARY_TESTS = new Set(['=', '==', '!=', ...Object.keys(INTEGER_TESTS)])

// Argument-count rules make lone operators strings and give binary tests
// precedence over negation: `test ! = !` is a string comparison.
function evaluate(tokens, ctx, flavor) {
  const [first, second, third] = tokens
  if (tokens.length === 0) return false
  if (tokens.length === 1) return first !== ''
  if (tokens.length === 2) {
    if (first === '!') return second === ''
    if (first === '-n') return second !== ''
    if (first === '-z') return second === ''
    if (['-a', '-e', '-f', '-d', '-h', '-L', '-s'].includes(first)) return fileTest(first, second, ctx)
    if (flavor.unaryGap(first)) gap(first)
    throw new Error(flavor.unary(first, second))
  }
  if (tokens.length === 3) {
    if (second === '=' || second === '==') return first === third
    if (second === '!=') return first !== third
    if (Object.hasOwn(INTEGER_TESTS, second)) return INTEGER_TESTS[second](flavor.integer(first), flavor.integer(third))
    if (BINARY_GAPS.has(second)) gap(second)
    if (second === '-a' || second === '-o') gap('compound expressions')
  }
  if (tokens.length <= 4) {
    if (first === '!') return !evaluate(tokens.slice(1), ctx, flavor)
    if (first === '(' && tokens.at(-1) === ')') return evaluate(tokens.slice(1, -1), ctx, flavor)
  }
  if (tokens.some((token) => ['-a', '-o', '!', '(', ')'].includes(token))) gap('compound expressions')
  throw new Error(tokens.length > 3 ? flavor.leftover(tokens, ctx) : flavor.binary(second))
}

// coreutils' find_int: blanks, a sign and decimal digits, then blanks, read
// at any length.
function coreutilsInteger(operand, quote) {
  const match = /^[ \t]*([+-]?\d+)[ \t]*$/u.exec(operand)
  if (match === null) throw new Error(`invalid integer ${quote(operand)}`)
  return BigInt(match[1])
}

function bashInteger(operand) {
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
    isLink: (path) => ctx.fs.isLink?.(path) === true,
    readLink: (path) => ctx.fs.readLink?.(path),
  }
  // `-h` and `-L` ask about the name itself; every other test asks about what
  // it leads to, so a link to nothing is not there for any of them.
  const link = operator === '-h' || operator === '-L'
  const { path, error } = lookup(ctx.cwd, operand, fs, { follow: !link })
  if (error) return false
  if (isStream(path)) gap('stream device metadata')
  if (link) return fs.isLink(path)
  if (operator === '-e' || operator === '-a') return true
  if (operator === '-d') return fs.isDir(path)
  // `-s` asks how much is there rather than what is: a directory has a size
  // of its own, an empty file has none, and the sink holds nothing.
  if (operator === '-s') return fs.isDir(path) || (path !== '/dev/null' && sizeOf(ctx, path) > 0)
  return path !== '/dev/null' && ctx.fs.isFile(path)
}

// What `ls -l` and `du` report, which is what `-s` asks after: the bytes a
// file holds, or the path a link holds where the name was not followed.
const sizeOf = (ctx, path) => ctx.fs.fileSize?.(path) ?? encodeUtf8(ctx.fs.readFile(path)).length

function isStream(path) {
  return STREAMS.has(path) || /^\/dev\/fd\/\d+$/u.test(path)
}

function gap(detail) {
  throw new UnsupportedError('feature', detail, `${detail} is not supported`)
}
