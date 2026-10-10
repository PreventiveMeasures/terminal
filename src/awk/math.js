// The numeric builtins: the POSIX math functions, rand/srand, and gawk's
// strtonum and bit operations. Each takes the machine and the call's
// argument NODES, like the string builtins in ./builtins.js.

import { AwkError } from './common.js'
import { evalExpr } from './eval.js'
import { formatNumeric, parseFormat } from './format.js'
import { StrNum, toNum, toStr } from './value.js'

const num = (m, node) => toNum(evalExpr(m, node))

// gawk's own random(3), so that rand() gives gawk's numbers: the BSD
// additive feedback generator in the form gawk's 256-byte state selects
// (x^63 + x + 1, the state seeded by a Park-Miller LCG and stirred 630
// times), read through a 512-entry shuffle buffer. As in gawk, the
// generator starts out seeded with 1 — which is what the first srand()
// reports as the previous seed — and srand() with no argument seeds it with
// the time of day, as systime() reads it.
const DEG = 63
const SEP = 1
const SHUFFLE = 512

export const initialRng = () => ({ seed: 1, g: null })

function generator(m) {
  if (m.rng.g === null) {
    const state = new Uint32Array(DEG)
    // The state seen as signed, as good_rand() takes each word.
    m.rng.g = { state, signed: new Int32Array(state.buffer), f: 0, r: 0, buffer: new Int32Array(SHUFFLE), s: 0, fill: true }
    srandom(m.rng.g, 1)
  }
  return m.rng.g
}

function goodRand(x) {
  if (x === 0) x = 123459876
  const hi = Math.trunc(x / 127773)
  const lo = x % 127773
  let next = 16807 * lo - 2836 * hi
  if (next < 0) next += 0x7fffffff
  return next
}

function srandom(g, seed) {
  g.fill = true
  g.state[0] = seed
  for (let i = 1; i < DEG; i++) g.state[i] = goodRand(g.signed[i - 1])
  g.f = SEP
  g.r = 0
  for (let i = 0; i < 10 * DEG; i++) random(g)
}

function randomOld(g) {
  const { state } = g
  state[g.f] += state[g.r]
  const i = state[g.f] >>> 1
  if (++g.f >= DEG) { g.f = 0; ++g.r } else if (++g.r >= DEG) g.r = 0
  return i
}

function random(g) {
  if (g.fill) {
    for (let k = 0; k < SHUFFLE; k++) g.buffer[k] = randomOld(g)
    g.s = randomOld(g)
    g.fill = false
  }
  const r = randomOld(g)
  const k = g.s & (SHUFFLE - 1)
  g.s = g.buffer[k]
  g.buffer[k] = r
  return g.s
}

// Two draws make one double, as gawk builds it, never 1.
function rand(m) {
  const g = generator(m)
  let value
  do {
    const d1 = random(g)
    const d2 = random(g)
    value = 0.5 + ((d1 / 2147483648 + d2) / 2147483648)
    value -= 0.5
  } while (value === 1)
  return value
}

// The seed is the argument converted as C converts a double to a long
// (a value out of range, or NaN, is the most negative one), which the
// generator then takes as an unsigned int.
const LONG_MIN = -(2 ** 63)

function srand(m, args) {
  const g = generator(m)
  const previous = m.rng.seed
  const x = args.length > 0 ? num(m, args[0]) : Math.floor(Date.now() / 1000)
  const seed = Number.isFinite(x) && Math.abs(x) < 2 ** 63 ? Math.trunc(x) : LONG_MIN
  m.rng.seed = seed
  srandom(g, Number(BigInt.asUintN(32, BigInt(seed))))
  return previous
}

// gawk warns (and returns the IEEE result) where C's math functions
// leave the domain: a negative log or sqrt, an exp that overflows. The
// argument is shown as C's %g shows it.
const G = parseFormat('%g')[0]
const formatG = (x) => formatNumeric(x, G)
function log(m, args) {
  const x = num(m, args[0])
  if (x < 0) m.warn(`log: received negative argument ${formatG(x)}`)
  return Math.log(x)
}

function sqrt(m, args) {
  const x = num(m, args[0])
  if (x < 0) m.warn(`sqrt: received negative argument ${formatG(x)}`)
  return Math.sqrt(x)
}

function exp(m, args) {
  const x = num(m, args[0])
  const r = Math.exp(x)
  if (Number.isFinite(x) && !Number.isFinite(r)) m.warn(`exp: argument ${formatG(x)} is out of range`)
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
