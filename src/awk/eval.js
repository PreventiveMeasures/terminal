// Expression evaluation, fields and calls over the machine in ./run.js.
// Arrays pass by reference and scalars by value. An untyped argument retains
// a reference to its caller slot so a callee can initialize it as an array.

import { AwkError, MAX_CALL_DEPTH, arithmetic } from './common.js'
import { AwkArray, subscript } from './array.js'
import { parseWidths, splitRecord } from './input.js'
import { compileRegex } from './regex.js'
import { NULL_FIELD, StrNum, UNASSIGNED, compare, ignoreCase, subscriptKey, toNum, toStr, truthy } from './value.js'

const makeRef = (scope, name) => ({ isRef: true, scope, name })
const isRef = (v) => typeof v === 'object' && v !== null && v.isRef === true

// Non-`return` control flow escaping a function body (`exit` from a
// helper function is common; `next` is legal too) travels as an
// exception up to the rule loop in ./run.js.
export class Signal extends Error {
  constructor(signal) {
    super(signal.type)
    this.signal = signal
  }
}

function scopeOf(m, name) {
  const frame = m.frame
  return frame !== undefined && frame.has(name) ? frame : m.globals
}

// gawk names an array parameter by the names it was passed through, too:
// `b (from a, from x)`.
function arrayAsScalar(m, name) {
  const chain = scopeOf(m, name).from?.get(name)
  const label = chain === undefined ? name : `${name} (from ${chain.join(', from ')})`
  return new AwkError(`attempt to use array \`${label}' in a scalar context`)
}

// What a name holds, read without using it. Through a reference that is
// the caller's array, or its unassigned scalar, or else nothing yet.
export function getVar(m, name) {
  const v = scopeOf(m, name).get(name)
  if (!isRef(v)) return v
  let target = v
  while (isRef(target)) target = target.scope.get(target.name)
  return target instanceof AwkArray || target === UNASSIGNED ? target : undefined
}

// A name read as a scalar. One nothing has used yet becomes gawk's
// unassigned value, and so does the caller's variable behind an untyped
// parameter — which can then no longer become an array.
export function readVar(m, name) {
  const scope = scopeOf(m, name)
  const v = scope.get(name)
  if (v !== undefined && !isRef(v) && !(v instanceof AwkArray)) return v
  if (v instanceof AwkArray || getVar(m, name) instanceof AwkArray) throw arrayAsScalar(m, name)
  if (v !== undefined) settle(v)
  scope.set(name, UNASSIGNED)
  return UNASSIGNED
}

// The caller's untyped slots behind a reference become unassigned scalars.
function settle(ref) {
  for (let r = ref; isRef(r);) {
    const next = r.scope.get(r.name)
    if (next === undefined) r.scope.set(r.name, UNASSIGNED)
    r = next
  }
}

// Which of FS / FIELDWIDTHS / FPAT splits records is whichever was
// assigned last; PROCINFO["FS"] names it, as in gawk.
const FIELD_MODES = new Set(['FS', 'FIELDWIDTHS', 'FPAT'])

export function setVar(m, name, v) {
  const scope = scopeOf(m, name)
  const old = scope.get(name)
  if (old instanceof AwkArray || (isRef(old) && getVar(m, name) instanceof AwkArray)) throw arrayAsScalar(m, name)
  if (isRef(old)) settle(old)
  if (scope === m.globals) {
    if (name === 'NF') { setNF(m, v); return }
    // gawk rebuilds a record waiting on a new OFS with the old one first.
    if (name === 'OFS') record(m)
    if (name === 'FIELDWIDTHS') m.widths = parseWidths(toStr(v, m))
    if (name === 'FPAT' || ((name === 'FS' || name === 'RS') && toStr(v, m).length > 1)) compileRegex(toStr(v, m), ignoreCase(m), m.warn, m.tables)
    if (FIELD_MODES.has(name)) {
      m.fieldMode = name
      const info = m.globals.get('PROCINFO')
      if (info instanceof AwkArray) info.lookup(subscript('FS', 'FS')).value = name
    }
  }
  scope.set(name, v)
}

export function getArray(m, name) {
  const origin = scopeOf(m, name)
  let key = name, scope = origin, value = scope.get(key)
  if (value instanceof AwkArray) return value
  const referred = isRef(value)
  while (isRef(value)) {
    scope = value.scope; key = value.name
    value = scope.get(key)
  }
  if (!(value instanceof AwkArray)) {
    if (value !== undefined) {
      throw new AwkError(origin === m.frame && !referred ? `attempt to use scalar parameter \`${name}' as an array` : `attempt to use scalar \`${key}' as an array`)
    }
    value = new AwkArray(key)
    scope.set(key, value)
  }
  // Cache only this caller's reference; intermediate untyped slots stay references.
  if (referred) origin.set(name, value)
  return value
}

// `value` is what `$0` evaluates to: a numeric string for a record that
// came from input (the default), the assigned value after `$0 = ...` —
// `$0 = 5` keeps the number 5, split as "5" — and a plain string once
// fields were assigned and the record rebuilt, so `$1 = $1` turns the
// line `10` into a string and `$0 < 9` becomes a string comparison, as in
// gawk.
export function setRecord(m, text, value = new StrNum(text)) {
  m.record = text
  m.recordValue = value
  m.dirty = false
  m.fields = [undefined, ...splitRecord(m, text).map((s) => new StrNum(s))]
  m.nf = m.fields.length - 1
  m.globals.set('NF', m.nf)
}

// Assigning a field, or NF, leaves $0 to be rebuilt when something next
// reads it — with OFS and CONVFMT as they are then, as gawk does.
export function record(m) {
  if (m.dirty) {
    const ofs = toStr(m.globals.get('OFS'), m)
    m.record = m.fields.slice(1).map((v) => toStr(v, m)).join(ofs)
    m.recordValue = m.record
    m.dirty = false
  }
  return m.record
}

export function getField(m, i) {
  if (i === 0) { record(m); return m.recordValue }
  return i <= m.nf ? m.fields[i] : NULL_FIELD
}

// A field named as a target (of an assignment, sub(), getline...) exists
// from then on: NF grows to reach it, with null fields between, whether or
// not anything is then stored in it.
function reachField(m, i) {
  if (i <= m.nf) return
  while (m.nf < i) m.fields[++m.nf] = NULL_FIELD
  m.globals.set('NF', m.nf)
}

// Assigning $0 re-splits it from its text (a number's CONVFMT text);
// assigning any other field rebuilds $0 when it is next read.
export function setField(m, i, v) {
  if (i === 0) {
    setRecord(m, toStr(v, m), v === undefined ? UNASSIGNED : v)
    return
  }
  reachField(m, i)
  m.fields[i] = v
  m.dirty = true
}

// NF keeps the value assigned to it (`NF = 2.7` prints as 2.7) while the
// record keeps that many fields.
function setNF(m, v) {
  const n = Math.trunc(toNum(v))
  if (n < 0) throw new AwkError('NF set to negative value')
  record(m)
  while (m.nf < n) m.fields[++m.nf] = NULL_FIELD
  m.fields.length = n + 1
  m.nf = n
  m.globals.set('NF', v)
  m.dirty = true
}

// A field reference names its own line, as gawk's message does.
function fieldIndex(m, node) {
  const n = toNum(evalExpr(m, node.index))
  if (!(n >= 0)) {
    m.line = node.line
    throw new AwkError(`attempt to access field ${Number.isNaN(n) ? n : Math.trunc(n)}`)
  }
  return Math.trunc(n)
}

// The subscript of `a[...]`: one value as it is, or several joined by SUBSEP.
export function subscriptOf(m, nodes) {
  if (nodes.length === 1) {
    const v = evalExpr(m, nodes[0])
    return subscript(v, subscriptKey(v, m))
  }
  const subsep = toStr(m.globals.get('SUBSEP'), m)
  const key = nodes.map((n) => subscriptKey(evalExpr(m, n), m)).join(subsep)
  return subscript(key, key)
}

// An assignment target, found once: an array element is created and a
// field past NF comes into being here.
export function resolveRef(m, node) {
  if (node.type === 'var') return node
  if (node.type === 'index') {
    const arr = getArray(m, node.name)
    return { type: 'cell', cell: arr.lookup(subscriptOf(m, node.subs)) }
  }
  const i = fieldIndex(m, node)
  if (i > 0) reachField(m, i)
  return { type: 'field', i }
}

export function readRef(m, ref) {
  if (ref.type === 'var') return readVar(m, ref.name)
  if (ref.type === 'cell') return ref.cell.value
  return getField(m, ref.i)
}

export function writeRef(m, ref, v) {
  if (ref.type === 'var') setVar(m, ref.name, v)
  else if (ref.type === 'cell') ref.cell.value = v
  else setField(m, ref.i, v)
}

export function assignTo(m, node, v) {
  writeRef(m, resolveRef(m, node), v)
}

// gawk's words for a division by zero name the operator, but for plain `/`.
const BY_ZERO = { __proto__: null, '/': '', '%': " in `%'", '/=': " in `/='", '%=': " in `%='" }

function arith(op, a, b, written = op) {
  if (b === 0 && (op === '/' || op === '%')) throw new AwkError(`division by zero attempted${BY_ZERO[written]}`)
  return arithmetic(op, a, b)
}

// `compare` yields NaN for an unordered pair; every test but `!=` is
// then false, as in C.
const COMPARE = {
  __proto__: null,
  '<': (c) => c < 0, '<=': (c) => c <= 0, '==': (c) => c === 0,
  '!=': (c) => c !== 0, '>': (c) => c > 0, '>=': (c) => c >= 0,
}

// A regex literal in a `~` right-hand side (or a builtin's regex slot)
// is the pattern itself; anything else evaluates to a string that is
// compiled as a dynamic regex. Both honor IGNORECASE.
// A dynamic regex is compiled again — and warned of again — only when its
// text (or IGNORECASE) changed since that expression last made one, as
// gawk keeps it.
export function regexOf(m, node) {
  const ic = ignoreCase(m)
  if (node.type === 'regex') return ic ? compileRegex(node.source, true, null, m.tables) : node.re
  const src = toStr(evalExpr(m, node), m)
  const last = node.compiled
  if (last !== undefined && last.src === src && last.ic === ic) return last.re
  const re = compileRegex(src, ic, m.warn, m.tables)
  node.compiled = { src, ic, re }
  return re
}

function increment(m, n, post) {
  const ref = resolveRef(m, n.target)
  const before = toNum(readRef(m, ref))
  const after = n.op === '++' ? before + 1 : before - 1
  writeRef(m, ref, after)
  return post ? before : after
}

// An assignment evaluates its right-hand side first, then finds its target:
// in `a[i++] = i` the element is a[5] and its value 5, as gawk has it. A
// value nothing assigned (an untyped element, a function that returned
// none) is stored as gawk's unassigned value.
function assign(m, n) {
  let v = evalExpr(m, n.value)
  if (v === undefined) v = UNASSIGNED
  const ref = resolveRef(m, n.target)
  if (n.op !== '=') v = arith(n.op[0], toNum(readRef(m, ref)), toNum(v), n.op)
  writeRef(m, ref, v)
  return v
}

export function evalExpr(m, n) {
  switch (n.type) {
    case 'num': case 'str': return n.value
    case 'regex': return regexOf(m, n).test(record(m)) ? 1 : 0
    case 'var': return readVar(m, n.name)
    // Referencing an element creates it (POSIX), which is why `in` exists.
    case 'index': return getArray(m, n.name).lookup(subscriptOf(m, n.subs)).value
    case 'field': return getField(m, fieldIndex(m, n))
    case 'assign': return assign(m, n)
    case 'cond': return evalExpr(m, truthy(evalExpr(m, n.test)) ? n.consequent : n.alternate)
    case 'or': return truthy(evalExpr(m, n.left)) || truthy(evalExpr(m, n.right)) ? 1 : 0
    case 'and': return truthy(evalExpr(m, n.left)) && truthy(evalExpr(m, n.right)) ? 1 : 0
    case 'not': return truthy(evalExpr(m, n.expr)) ? 0 : 1
    case 'neg': return -toNum(evalExpr(m, n.expr))
    case 'plus': return toNum(evalExpr(m, n.expr))
    case 'binary': {
      const a = toNum(evalExpr(m, n.left))
      const b = toNum(evalExpr(m, n.right))
      // Only a division carries a line: it is the one that can fail.
      if (n.line !== undefined) m.line = n.line
      return arith(n.op, a, b)
    }
    case 'concat': return toStr(evalExpr(m, n.left), m) + toStr(evalExpr(m, n.right), m)
    case 'compare': return COMPARE[n.op](compare(evalExpr(m, n.left), evalExpr(m, n.right), m)) ? 1 : 0
    case 'match': {
      const s = toStr(evalExpr(m, n.left), m)
      return regexOf(m, n.right).test(s) === n.negate ? 0 : 1
    }
    case 'in': return getArray(m, n.array).has(subscriptOf(m, n.keys)) ? 1 : 0
    case 'preinc': return increment(m, n, false)
    case 'postinc': return increment(m, n, true)
    case 'call': return callUser(m, n)
    case 'builtin':
      m.line = n.line
      return m.callBuiltin(m, n)
    case 'getline': return getline(m, n)
    default: throw new AwkError(`unknown expression: ${n.type}`)
  }
}

// Arguments beyond the parameters are evaluated and dropped, with gawk's
// warning (once per call site).
// The arguments are evaluated before the function is looked up, as gawk
// pushes them before its call instruction runs.
function callUser(m, n) {
  m.line = n.line
  const fn = m.program.functions.get(n.name)
  const params = fn?.params ?? []
  const frame = new Map()
  for (let i = 0; i < n.args.length; i++) {
    const v = argValue(m, n.args[i])
    if (i >= params.length) continue
    frame.set(params[i], v)
    const chain = passedThrough(m, n.args[i], v)
    if (chain !== null) (frame.from ??= new Map()).set(params[i], chain)
  }
  if (fn === undefined) throw new AwkError(`function \`${n.name}' not defined`)
  if (n.args.length > params.length) m.warn(`function \`${n.name}' called with more arguments than declared`)
  if (m.callDepth >= MAX_CALL_DEPTH) throw new AwkError(`function call nesting deeper than ${MAX_CALL_DEPTH} levels (runaway recursion?)`, null, 'call depth limit')
  const caller = m.frame
  for (let i = n.args.length; i < params.length; i++) frame.set(params[i], undefined)
  m.frame = frame
  m.callDepth++
  try {
    const sig = m.execStmts(m, fn.body)
    if (sig === undefined || sig.type === 'return') return sig?.value ?? UNASSIGNED
    throw new Signal(sig)
  } finally {
    m.frame = caller
    m.callDepth--
  }
}

// A bare name is passed by reference when it holds an array or is
// still untyped; everything else is evaluated to a scalar.
function argValue(m, node) {
  if (node.type !== 'var') return evalExpr(m, node)
  const scope = scopeOf(m, node.name)
  const v = scope.get(node.name)
  if (v instanceof AwkArray || isRef(v)) return v
  return v === undefined ? makeRef(scope, node.name) : v
}

// The names an array (or a name that may become one) was passed through
// to reach a parameter, nearest first; null for a scalar.
function passedThrough(m, node, v) {
  if (node.type !== 'var' || !(v instanceof AwkArray || isRef(v))) return null
  return [node.name, ...scopeOf(m, node.name).from?.get(node.name) ?? []]
}

function getline(m, n) {
  // The target is found first: an untyped variable is a scalar from here,
  // read or not.
  if (n.target !== null && n.target.type === 'var' && getVar(m, n.target.name) === undefined) readVar(m, n.target.name)
  let text
  if (n.file === null) {
    text = m.input.next(m)
    if (text === null) return 0
  } else {
    const r = m.input.readNamed(m, toStr(evalExpr(m, n.file), m))
    if (r.status !== 1) return r.status
    text = r.record
  }
  if (n.target === null) setRecord(m, text)
  else assignTo(m, n.target, new StrNum(text))
  return 1
}
