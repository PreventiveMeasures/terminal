// Builtins receive argument nodes: regex, array and lvalue slots need special
// handling. The parser checks arity and shapes; ./math.js handles numbers.

import { AwkError } from './common.js'
import { AwkArray, subscript } from './array.js'
import { evalExpr, getArray, getVar, readRef, readVar, record, regexOf, resolveRef, writeRef } from './eval.js'
import { splitOn } from './input.js'
import { MATH_BUILTINS } from './math.js'
import { awkSprintf } from './printf.js'
import { substituteAll } from './regex.js'
import { StrNum, foldCase, ignoreCase, toNum, toStr, typeName } from './value.js'

const str = (m, node) => toStr(evalExpr(m, node), m)
const num = (m, node) => toNum(evalExpr(m, node))
const FIELD0 = { type: 'field', index: { type: 'num', value: 0 } }
const element = (arr, i) => arr.lookup(subscript(i, String(i)))

// GNU's default sub/gsub rules preserve backslashes except for the
// special runs before '&', and a run of four becomes two backslashes.
function expandReplacement(repl, matched) {
  let out = ''
  for (let i = 0; i < repl.length; i++) {
    const c = repl[i]
    if (c === '\\') {
      if (repl[i + 1] === '\\' && repl[i + 2] === '\\' && (repl[i + 3] === '&' || repl[i + 3] === '\\')) { out += '\\' + repl[i + 3]; i += 3; continue }
      if (repl[i + 1] === '\\' && repl[i + 2] === '&') { out += '\\' + matched; i += 2; continue }
      if (repl[i + 1] === '&') { out += '&'; i++; continue }
    }
    out += c === '&' ? matched : c
  }
  return out
}

// The target is found before anything matches, so a field past NF comes
// into being (NF grows) even when nothing is substituted, as in gawk. A
// constant target (the parser lets nothing else through) is only counted.
function substitute(m, args, global) {
  const re = regexOf(m, args[0])
  const repl = str(m, args[1])
  const node = args[2] ?? FIELD0
  const target = isTarget(node) ? resolveRef(m, node) : null
  const s = target === null ? str(m, node) : toStr(readRef(m, target), m)
  const { out, count } = substituteAll(s, re, (start, end) => expandReplacement(repl, s.slice(start, end)), global ? 'global' : 'first')
  if (count > 0 && target !== null) writeRef(m, target, out)
  return count
}

const isTarget = (node) => node.type === 'var' || node.type === 'index' || node.type === 'field'

// The array a builtin fills: an array, or a name nothing has used yet.
function arrayArg(m, node, message) {
  if (node.type === 'var') {
    const v = getVar(m, node.name)
    if (v === undefined || v instanceof AwkArray) return getArray(m, node.name)
  } else evalExpr(m, node)
  throw new AwkError(message)
}

// gensub's replacement also knows `\N` for the Nth group and `\0` for
// the whole match.
function expandGroups(repl, groups) {
  let out = ''
  for (let i = 0; i < repl.length; i++) {
    const c = repl[i]
    if (c === '\\' && i + 1 === repl.length) throw new AwkError('gensub with a trailing replacement backslash is not supported', null, 'gensub trailing backslash')
    if (c === '\\' && i + 1 < repl.length) {
      const d = repl[++i]
      if (d >= '0' && d <= '9') out += groups[Number(d)]?.text ?? ''
      else out += d
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
  const s = args[3] ? str(m, args[3]) : record(m)
  const captures = /(?:^|[^\\])(?:\\\\)*\\[1-9]/u.test(repl)
  return substituteAll(s, re, (start, end, nth) => {
    if (!global && nth !== which) return null
    return expandGroups(repl, captures ? re.groups(s, start, end) : [{ text: s.slice(start, end) }])
  }, global ? 'global' : 'nth').out
}

function match(m, args) {
  const s = str(m, args[0])
  const re = regexOf(m, args[1])
  const found = re.search(s, 0)
  const start = found ? Array.from(s.slice(0, found.start)).length + 1 : 0
  m.globals.set('RSTART', start)
  m.globals.set('RLENGTH', found ? Array.from(s.slice(found.start, found.end)).length : -1)
  if (args[2]) {
    const arr = arrayArg(m, args[2], 'match: third argument is not an array')
    arr.clear()
    if (found) {
      const subsep = toStr(m.globals.get('SUBSEP'), m)
      const named = (key) => arr.lookup(subscript(key, key))
      re.groups(s, found.start, found.end).forEach((g, i) => {
        if (g === undefined) return
        element(arr, i).value = new StrNum(g.text)
        named(`${i}${subsep}start`).value = Array.from(s.slice(0, g.start)).length + 1
        named(`${i}${subsep}length`).value = [...g.text].length
      })
    }
  }
  return start
}

// split(s, arr [, sep [, seps]]): sep follows the FS rules when it is a
// string, and is used as-is when it is a regex literal. Elements are
// numeric strings, like fields; seps[i] is the separator after element i
// (seps[0] the blanks before the first, when sep is " ").
function split(m, args) {
  const s = str(m, args[0])
  let sep
  if (args[2] === undefined) sep = toStr(m.globals.get('FS'), m)
  else if (args[2].type === 'regex') sep = regexOf(m, args[2])
  else sep = str(m, args[2])
  const sepArr = args[3] === undefined ? null : arrayArg(m, args[3], 'split: fourth argument is not an array')
  const arr = arrayArg(m, args[1], 'split: second argument is not an array')
  if (sepArr === arr) throw new AwkError('split: cannot use the same array for second and fourth args')
  const seps = sepArr === null ? null : []
  const parts = splitOn(s, sep, false, ignoreCase(m), seps)
  sepArr?.clear()
  arr.clear()
  parts.forEach((part, i) => { element(arr, i + 1).value = new StrNum(part) })
  seps?.forEach(([i, text]) => { element(sepArr, i).value = new StrNum(text) })
  return parts.length
}

// gawk's substr: start and length are truncated to integers; a start
// below 1 acts as 1 (with the length as given, so substr("hello", 0, 3)
// is "hel"); a length of 0 or less, or a NaN, is the empty string.
function substr(m, args) {
  const s = [...str(m, args[0])]
  const start = Math.trunc(num(m, args[1]))
  const from = Number.isNaN(start) ? 1 : Math.max(start, 1)
  let to = s.length + 1
  if (args[2]) {
    const len = Math.trunc(num(m, args[2]))
    if (!(len >= 1)) return ''
    to = Math.min(to, from + len)
  }
  return to > from ? s.slice(from - 1, to - 1).join('') : ''
}

// length(name) of a name nothing has used yet makes it a scalar, as gawk does.
function length(m, args) {
  if (args.length === 0) return [...record(m)].length
  if (args[0].type === 'var') {
    const v = getVar(m, args[0].name)
    if (v instanceof AwkArray) return v.size
    return [...toStr(readVar(m, args[0].name), m)].length
  }
  return [...str(m, args[0])].length
}

function index(m, args) {
  let s = str(m, args[0])
  if (args[1].type === 'regex') throw new AwkError('index: regexp constant as second argument is not allowed')
  let t = str(m, args[1])
  if (ignoreCase(m)) { s = foldCase(s, m.tables); t = foldCase(t, m.tables) }
  const at = s.indexOf(t)
  return at < 0 ? 0 : Array.from(s.slice(0, at)).length + 1
}

// close() and fflush() know the redirections this run has opened: output
// to one of the device names, and `getline < file`. Anything else was
// never opened, which close() answers with -1 and fflush() with a warning.
function close(m, args) {
  if (args[1]) {
    const how = str(m, args[1]).toLowerCase()
    if (how !== 'to' && how !== 'from') throw new AwkError("close: second argument must be `to' or `from'")
  }
  const name = str(m, args[0])
  if (m.outputs.delete(name)) return 0
  return m.input.close(m, name)
}

function fflush(m, args) {
  if (args.length === 0) return 0
  const name = str(m, args[0])
  if (name === '' || m.outputs.has(name) || name === '/dev/stdout' || name === '/dev/stderr') return 0
  if (m.input.readers.has(name)) m.warn(`fflush: cannot flush: file \`${name}' opened for reading, not writing`)
  else m.warn(`fflush: \`${name}' is not an open file, pipe or co-process`)
  return -1
}

function sprintf(m, args) {
  if (args.length === 0) throw new AwkError('sprintf: no arguments')
  return awkSprintf(m, str(m, args[0]), args.slice(1).map((a) => evalExpr(m, a)))
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
  sprintf,
  tolower: (m, args) => foldCase(str(m, args[0]), m.tables),
  toupper: (m, args) => foldCase(str(m, args[0]), m.tables, true),
  close,
  fflush,
  typeof: typeOf,
  isarray: (m, args) => (args[0].type === 'var' && getVar(m, args[0].name) instanceof AwkArray ? 1 : 0),
}

export function callBuiltin(m, n) {
  const fn = BUILTIN[n.name]
  if (!fn) throw new AwkError(`function \`${n.name}\` is not supported`, null, `${n.name}()`)
  return fn(m, n.args)
}
