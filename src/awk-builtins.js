// The builtin functions. Each takes the machine and the call's argument
// NODES (not values): a few arguments are special — a regex literal in
// a pattern slot, an array name, the lvalue that sub/gsub write back
// to — so evaluation happens here, per function. Arity and the shape
// checks were done by the parser.

import { AwkError } from './awk-common.js'
import { assignTo, evalExpr, getArray, getVar, regexOf } from './awk-eval.js'
import { splitFields } from './awk-input.js'
import { awkSprintf } from './awk-printf.js'
import { withFlags } from './awk-regex.js'
import { StrNum, toNum, toStr } from './awk-value.js'

const str = (m, node) => toStr(evalExpr(m, node), m)
const num = (m, node) => toNum(evalExpr(m, node))
const FIELD0 = { type: 'field', index: { type: 'num', value: 0 } }

// `\&` is a literal ampersand and `\\` a backslash; a bare `&` is the
// matched text. Any other backslash stays.
function expandReplacement(repl, matched) {
  let out = ''
  for (let i = 0; i < repl.length; i++) {
    const c = repl[i]
    if (c === '\\' && (repl[i + 1] === '&' || repl[i + 1] === '\\')) { out += repl[++i]; continue }
    out += c === '&' ? matched : c
  }
  return out
}

function substitute(m, args, global) {
  const re = regexOf(m, args[0])
  const repl = str(m, args[1])
  const target = args[2] ?? FIELD0
  let count = 0
  const out = str(m, target).replace(global ? withFlags(re, 'g') : re, (matched) => {
    count++
    return expandReplacement(repl, matched)
  })
  if (count > 0) assignTo(m, target, out)
  return count
}

// gensub's replacement also knows `\N` for the Nth group and `\0` for
// the whole match.
function expandGroups(repl, matched, groups) {
  let out = ''
  for (let i = 0; i < repl.length; i++) {
    const c = repl[i]
    if (c === '\\' && i + 1 < repl.length) {
      const d = repl[++i]
      if (d >= '0' && d <= '9') out += d === '0' ? matched : (groups[Number(d) - 1] ?? '')
      else if (d === '&' || d === '\\') out += d
      else out += '\\' + d
      continue
    }
    out += c === '&' ? matched : c
  }
  return out
}

function gensub(m, args) {
  const re = regexOf(m, args[0])
  const repl = str(m, args[1])
  const how = evalExpr(m, args[2])
  const howStr = toStr(how, m)
  const global = howStr.startsWith('g') || howStr.startsWith('G')
  const which = global ? 0 : Math.max(1, Math.trunc(toNum(how)))
  const target = args[3] ? str(m, args[3]) : m.record
  let seen = 0
  return target.replace(withFlags(re, 'g'), (matched, ...rest) => {
    seen++
    if (!global && seen !== which) return matched
    // The callback's trailing arguments are offset, input, and (when
    // named groups exist) a groups object; captures precede the offset.
    const groups = rest.slice(0, rest.findIndex((x) => typeof x === 'number'))
    return expandGroups(repl, matched, groups)
  })
}

function match(m, args) {
  const s = str(m, args[0])
  const re = args[2] ? withFlags(regexOf(m, args[1]), 'd') : regexOf(m, args[1])
  const found = re.exec(s)
  m.globals.set('RSTART', found ? found.index + 1 : 0)
  m.globals.set('RLENGTH', found ? found[0].length : -1)
  if (args[2]) {
    const arr = getArray(m, args[2].name)
    arr.clear()
    if (found) {
      const subsep = toStr(m.globals.get('SUBSEP'), m)
      for (let i = 0; i < found.length; i++) {
        if (found[i] === undefined) continue
        arr.set(String(i), new StrNum(found[i]))
        arr.set(`${i}${subsep}start`, found.indices[i][0] + 1)
        arr.set(`${i}${subsep}length`, found[i].length)
      }
    }
  }
  return found ? found.index + 1 : 0
}

// split(s, arr [, sep]): sep follows the FS rules when it is a string,
// and is used as-is when it is a regex literal. Elements are numeric
// strings, like fields.
function split(m, args) {
  const s = str(m, args[0])
  const arr = getArray(m, args[1].name)
  let sep
  if (args[2] === undefined) sep = toStr(m.globals.get('FS'), m)
  else if (args[2].type === 'regex') sep = args[2].re
  else sep = str(m, args[2])
  const parts = splitFields(s, sep, false)
  arr.clear()
  parts.forEach((part, i) => arr.set(String(i + 1), new StrNum(part)))
  return parts.length
}

// POSIX: the characters from position m to m+n-1, 1-based, clipped to
// the string — so substr("hello", 0, 3) is "he" and a negative start
// eats into the length rather than wrapping.
function substr(m, args) {
  const s = str(m, args[0])
  const start = Math.round(num(m, args[1]))
  const len = args[2] ? Math.round(num(m, args[2])) : Infinity
  if (Number.isNaN(start) || Number.isNaN(len)) return ''
  const from = Math.max(start, 1)
  const to = Math.min(len === Infinity ? Infinity : start + len, s.length + 1)
  return to > from ? s.slice(from - 1, to - 1) : ''
}

function length(m, args) {
  if (args.length === 0) return m.record.length
  if (args[0].type === 'var') {
    const v = getVar(m, args[0].name)
    if (v instanceof Map) return v.size
    return toStr(v, m).length
  }
  return str(m, args[0]).length
}

// A small deterministic generator (mulberry32) so that, as in awk, the
// sequence repeats from run to run until srand() is called. The state
// is kept as an unsigned 32-bit value.
const TWO_32 = 4294967296

function seedState(seed) {
  return Number(BigInt.asUintN(32, BigInt(Math.trunc(seed))))
}

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

function close(m, args) {
  const name = str(m, args[0])
  if (name === '/dev/stdout' || name === '/dev/stderr' || name === '/dev/null') return 0
  return m.input.close(name)
}

const BUILTIN = {
  __proto__: null,
  length,
  substr,
  index: (m, args) => {
    const s = str(m, args[0])
    const t = str(m, args[1])
    return t === '' ? 0 : s.indexOf(t) + 1
  },
  split,
  sub: (m, args) => substitute(m, args, false),
  gsub: (m, args) => substitute(m, args, true),
  gensub,
  match,
  sprintf: (m, args) => awkSprintf(m, str(m, args[0]), args.slice(1).map((a) => evalExpr(m, a))),
  sin: (m, args) => Math.sin(num(m, args[0])),
  cos: (m, args) => Math.cos(num(m, args[0])),
  atan2: (m, args) => Math.atan2(num(m, args[0]), num(m, args[1])),
  exp: (m, args) => Math.exp(num(m, args[0])),
  log: (m, args) => Math.log(num(m, args[0])),
  sqrt: (m, args) => Math.sqrt(num(m, args[0])),
  int: (m, args) => Math.trunc(num(m, args[0])),
  rand,
  srand,
  tolower: (m, args) => str(m, args[0]).toLowerCase(),
  toupper: (m, args) => str(m, args[0]).toUpperCase(),
  close,
  fflush: () => 0,
  systime: () => Math.floor(Date.now() / 1000),
}

export function callBuiltin(m, n) {
  const fn = BUILTIN[n.name]
  if (!fn) throw new AwkError(`function \`${n.name}\` is not supported`)
  return fn(m, n.args)
}

export const initialRng = () => ({ seed: 0, state: seedState(0) })
