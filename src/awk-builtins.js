// The string and regex builtins. Each takes the machine and the call's
// argument NODES (not values): a few arguments are special — a regex
// literal in a pattern slot, an array name, the lvalue that sub/gsub
// write back to — so evaluation happens here, per function. Arity and
// the shape checks were done by the parser. The numeric builtins live in
// awk-math.js.

import { AwkError } from './awk-common.js'
import { assignTo, evalExpr, getArray, getVar, regexOf } from './awk-eval.js'
import { splitOn } from './awk-input.js'
import { MATH_BUILTINS } from './awk-math.js'
import { awkSprintf } from './awk-printf.js'
import { substituteAll } from './awk-regex.js'
import { StrNum, ignoreCase, toNum, toStr, typeName } from './awk-value.js'

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
  const s = str(m, target)
  const { out, count } = substituteAll(s, re, (start, end) => expandReplacement(repl, s.slice(start, end)), global ? 'global' : 'first')
  if (count > 0) assignTo(m, target, out)
  return count
}

// gensub's replacement also knows `\N` for the Nth group and `\0` for
// the whole match.
function expandGroups(repl, groups) {
  let out = ''
  for (let i = 0; i < repl.length; i++) {
    const c = repl[i]
    if (c === '\\' && i + 1 < repl.length) {
      const d = repl[++i]
      if (d >= '0' && d <= '9') out += groups[Number(d)]?.text ?? ''
      else if (d === '&' || d === '\\') out += d
      else out += '\\' + d
      continue
    }
    out += c === '&' ? groups[0].text : c
  }
  return out
}

function gensub(m, args) {
  const re = regexOf(m, args[0])
  const repl = str(m, args[1])
  const how = evalExpr(m, args[2])
  const howStr = toStr(how, m)
  const global = howStr.startsWith('g') || howStr.startsWith('G')
  let which = 0
  if (!global) {
    which = Math.trunc(toNum(how))
    if (which < 1) { m.warn(`gensub: third argument \`${howStr}' treated as 1`); which = 1 }
  }
  const s = args[3] ? str(m, args[3]) : m.record
  return substituteAll(s, re, (start, end, nth) => (global || nth === which ? expandGroups(repl, re.groups(s, start, end)) : null), global ? 'global' : 'nth').out
}

function match(m, args) {
  const s = str(m, args[0])
  const re = regexOf(m, args[1])
  const found = re.search(s, 0)
  m.globals.set('RSTART', found ? found.start + 1 : 0)
  m.globals.set('RLENGTH', found ? found.end - found.start : -1)
  if (args[2]) {
    const arr = getArray(m, args[2].name)
    arr.clear()
    if (found) {
      const subsep = toStr(m.globals.get('SUBSEP'), m)
      re.groups(s, found.start, found.end).forEach((g, i) => {
        if (g === undefined) return
        arr.set(String(i), new StrNum(g.text))
        arr.set(`${i}${subsep}start`, g.start + 1)
        arr.set(`${i}${subsep}length`, g.end - g.start)
      })
    }
  }
  return found ? found.start + 1 : 0
}

// split(s, arr [, sep]): sep follows the FS rules when it is a string,
// and is used as-is when it is a regex literal. Elements are numeric
// strings, like fields.
function split(m, args) {
  const s = str(m, args[0])
  const arr = getArray(m, args[1].name)
  let sep
  if (args[2] === undefined) sep = toStr(m.globals.get('FS'), m)
  else if (args[2].type === 'regex') sep = regexOf(m, args[2])
  else sep = str(m, args[2])
  const parts = splitOn(s, sep, false, ignoreCase(m))
  arr.clear()
  parts.forEach((part, i) => arr.set(String(i + 1), new StrNum(part)))
  return parts.length
}

// gawk's substr: start and length are truncated to integers; a start
// below 1 acts as 1 (with the length as given, so substr("hello", 0, 3)
// is "hel"); a length of 0 or less, or a NaN, is the empty string.
function substr(m, args) {
  const s = str(m, args[0])
  const start = Math.trunc(num(m, args[1]))
  const from = Number.isNaN(start) ? 1 : Math.max(start, 1)
  let to = s.length + 1
  if (args[2]) {
    const len = Math.trunc(num(m, args[2]))
    if (!(len >= 1)) return ''
    to = Math.min(to, from + len)
  }
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

function index(m, args) {
  let s = str(m, args[0])
  let t = str(m, args[1])
  if (ignoreCase(m)) { s = s.toLowerCase(); t = t.toLowerCase() }
  return s.indexOf(t) + 1
}

function close(m, args) {
  const name = str(m, args[0])
  if (name === '/dev/stdout' || name === '/dev/stderr' || name === '/dev/null') return 0
  return m.input.close(m, name)
}

const typeOf = (m, args) => (args[0].type === 'var' ? typeName(getVar(m, args[0].name)) : typeName(evalExpr(m, args[0])))

const BUILTIN = {
  __proto__: null,
  ...MATH_BUILTINS,
  length,
  substr,
  index,
  split,
  sub: (m, args) => substitute(m, args, false),
  gsub: (m, args) => substitute(m, args, true),
  gensub,
  match,
  sprintf: (m, args) => awkSprintf(m, str(m, args[0]), args.slice(1).map((a) => evalExpr(m, a))),
  tolower: (m, args) => str(m, args[0]).toLowerCase(),
  toupper: (m, args) => str(m, args[0]).toUpperCase(),
  close,
  fflush: () => 0,
  typeof: typeOf,
  isarray: (m, args) => (args[0].type === 'var' && getVar(m, args[0].name) instanceof Map ? 1 : 0),
}

export function callBuiltin(m, n) {
  const fn = BUILTIN[n.name]
  if (!fn) throw new AwkError(`function \`${n.name}\` is not supported`, null, `${n.name}()`)
  return fn(m, n.args)
}
