// The numeric builtins: the POSIX math functions, rand/srand, and gawk's
// strtonum and bit operations. Each takes the machine and the call's
// argument NODES, like the string builtins in awk-builtins.js.

import { AwkError } from './awk-common.js'
import { evalExpr } from './awk-eval.js'
import { StrNum, toNum, toStr } from './awk-value.js'

const num = (m, node) => toNum(evalExpr(m, node))

// A small deterministic generator (mulberry32) so that, as in awk, the
// sequence repeats from run to run until srand() is called. The state is
// an unsigned 32-bit value; gawk's initial seed is 1, and that is what
// the first srand() reports as the previous seed.
const TWO_32 = 4294967296

function seedState(seed) {
  return Number(BigInt.asUintN(32, BigInt(Math.trunc(seed))))
}

export const initialRng = () => ({ seed: 1, state: seedState(1) })

function rand(m) {
  m.rng.state = (m.rng.state + 0x6D2B79F5) % TWO_32
  let t = m.rng.state
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  const r = t ^ (t >>> 14)
  return (r < 0 ? r + TWO_32 : r) / TWO_32
}

function srand(m, args) {
  const previous = m.rng.seed
  const seed = args.length > 0 ? num(m, args[0]) : Math.floor(Date.now() / 1000)
  m.rng.seed = seed
  m.rng.state = seedState(seed)
  return previous
}

// gawk warns (and returns the IEEE result) where C's math functions
// leave the domain: a negative log or sqrt, an exp that overflows.
function log(m, args) {
  const x = num(m, args[0])
  if (x < 0) m.warn(`log: received negative argument ${toStr(x, m)}`)
  return Math.log(x)
}

function sqrt(m, args) {
  const x = num(m, args[0])
  if (x < 0) m.warn(`sqrt: called with negative argument ${toStr(x, m)}`)
  return Math.sqrt(x)
}

function exp(m, args) {
  const x = num(m, args[0])
  const r = Math.exp(x)
  if (Number.isFinite(x) && !Number.isFinite(r)) m.warn(`exp: argument ${toStr(x, m)} is out of range`)
  return r
}

// strtonum: like a numeric string, except that a string STARTING with
// `0x` is hex and one starting with `0` and octal digits is octal — no
// leading blanks or sign before the prefix, as gawk reads them.
function strtonum(m, args) {
  const v = evalExpr(m, args[0])
  if (typeof v === 'number') return v
  const s = v instanceof StrNum ? v.s : toStr(v, m)
  const hex = /^0[xX]([0-9a-fA-F]*)/u.exec(s)
  if (hex) return hex[1] === '' ? 0 : Number.parseInt(hex[1], 16)
  const oct = /^0[0-7]+(?![.\deE0-9])/u.exec(s)
  if (oct) return Number.parseInt(oct[0], 8)
  return toNum(new StrNum(s))
}

// The bit operations work on non-negative integers, as 64-bit unsigned
// values; a result too wide for a double drops leading bits until it is
// exact (gawk's adjust_uint), which is why compl(0) is 2^53 - 1.
function uintArg(m, name, node, k) {
  const x = num(m, node)
  if (x < 0) throw new AwkError(`${name}: argument ${k} negative value ${toStr(x, m)} is not allowed`)
  if (!Number.isFinite(x)) throw new AwkError(`${name}: argument ${k} is not a finite number`)
  return BigInt.asUintN(64, BigInt(Math.trunc(x)))
}

function adjust(big) {
  let v = big
  while (v > 0n && BigInt(Number(v)) !== v) v &= (1n << BigInt(v.toString(2).length - 1)) - 1n
  return Number(v)
}

function bitwise(name, op) {
  return (m, args) => {
    if (args.length < 2) throw new AwkError(`${name}: called with less than two arguments`)
    let acc = uintArg(m, name, args[0], 1)
    for (let k = 1; k < args.length; k++) acc = op(acc, uintArg(m, name, args[k], k + 1))
    return adjust(acc)
  }
}

function shift(name, left) {
  return (m, args) => {
    const v = uintArg(m, name, args[0], 1)
    // A shift count wraps at 64, as the hardware gawk runs on does.
    const n = uintArg(m, name, args[1], 2) % 64n
    return adjust(BigInt.asUintN(64, left ? v << n : v >> n))
  }
}

export const MATH_BUILTINS = {
  __proto__: null,
  sin: (m, args) => Math.sin(num(m, args[0])),
  cos: (m, args) => Math.cos(num(m, args[0])),
  atan2: (m, args) => Math.atan2(num(m, args[0]), num(m, args[1])),
  exp,
  log,
  sqrt,
  int: (m, args) => Math.trunc(num(m, args[0])),
  rand,
  srand,
  systime: () => Math.floor(Date.now() / 1000),
  strtonum,
  and: bitwise('and', (a, b) => a & b),
  or: bitwise('or', (a, b) => a | b),
  xor: bitwise('xor', (a, b) => a ^ b),
  lshift: shift('lshift', true),
  rshift: shift('rshift', false),
  compl: (m, args) => adjust(BigInt.asUintN(64, ~uintArg(m, 'compl', args[0], 1))),
}
