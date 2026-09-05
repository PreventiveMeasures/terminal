// Expression evaluation, variables, fields and user-function calls.
// `m` is the machine built by awk-run.js: globals (a Map from name to
// value), a stack of call frames (each a Map of the function's params),
// the current record and its fields, the input source, and the output
// buffers. Values follow awk-value.js.
//
// Arrays are Maps. A user function receives an array by reference and
// a scalar by value; an argument that is still UNTYPED at the call
// (never assigned, never subscripted) is passed as a reference back to
// the caller's slot, so that if the callee uses it as an array the
// array materializes in the caller — awk's rule for `function
// fill(arr)` called on a fresh name.

import { AwkError, MAX_CALL_DEPTH } from './awk-common.js'
import { splitRecord } from './awk-input.js'
import { compileRegex } from './awk-regex.js'
import { StrNum, compare, ignoreCase, subscriptKey, toNum, toStr, truthy } from './awk-value.js'

const makeRef = (scope, name) => ({ isRef: true, scope, name })
const isRef = (v) => typeof v === 'object' && v !== null && v.isRef === true

// Non-`return` control flow escaping a function body (`exit` from a
// helper function is common; `next` is legal too) travels as an
// exception up to the rule loop in awk-run.js.
export class Signal extends Error {
  constructor(signal) {
    super(signal.type)
    this.signal = signal
  }
}

const arrayAsScalar = (name) => new AwkError(`attempt to use array \`${name}\` in a scalar context`)

function scopeOf(m, name) {
  const frame = m.frames.at(-1)
  return frame !== undefined && frame.has(name) ? frame : m.globals
}

// A reference reads as an array once its target holds one, otherwise
// as uninitialized.
function derefScalar(ref) {
  const v = ref.scope.get(ref.name)
  if (isRef(v)) return derefScalar(v)
  return v instanceof Map ? v : undefined
}

function derefArray(ref) {
  const v = ref.scope.get(ref.name)
  if (isRef(v)) return derefArray(v)
  if (v instanceof Map) return v
  if (v !== undefined) throw new AwkError(`attempt to use scalar \`${ref.name}\` as an array`)
  const arr = new Map()
  ref.scope.set(ref.name, arr)
  return arr
}

export function getVar(m, name) {
  const v = scopeOf(m, name).get(name)
  return isRef(v) ? derefScalar(v) : v
}

// Which of FS / FIELDWIDTHS / FPAT splits records is whichever was
// assigned last; PROCINFO["FS"] names it, as in gawk.
const FIELD_MODES = new Set(['FS', 'FIELDWIDTHS', 'FPAT'])

export function setVar(m, name, v) {
  const scope = scopeOf(m, name)
  if (scope.get(name) instanceof Map) throw arrayAsScalar(name)
  if (scope === m.globals) {
    if (name === 'NF') { setNF(m, v); return }
    if (FIELD_MODES.has(name)) {
      m.fieldMode = name
      const info = m.globals.get('PROCINFO')
      if (info instanceof Map) info.set('FS', name)
    }
  }
  scope.set(name, v)
}

export function getArray(m, name) {
  const scope = scopeOf(m, name)
  let v = scope.get(name)
  if (isRef(v)) {
    v = derefArray(v)
    scope.set(name, v)
  }
  if (v instanceof Map) return v
  if (v !== undefined) throw new AwkError(`attempt to use scalar \`${name}\` as an array`)
  const arr = new Map()
  scope.set(name, arr)
  return arr
}

// --- record and fields ---------------------------------------------

// `value` is what `$0` evaluates to: a numeric string for a record that
// came from input (the default), the assigned value after `$0 = ...`,
// and a plain string once fields were assigned and the record rebuilt —
// so `$1 = $1` turns the line `10` into a string and `$0 < 9` becomes
// a string comparison, as in gawk.
export function setRecord(m, text, value = new StrNum(text)) {
  m.record = text
  m.recordValue = value
  m.fields = [undefined, ...splitRecord(m, text).map((s) => new StrNum(s))]
  m.nf = m.fields.length - 1
  m.globals.set('NF', m.nf)
}

function rebuildRecord(m) {
  const ofs = toStr(m.globals.get('OFS'), m)
  m.record = m.fields.slice(1).map((v) => toStr(v, m)).join(ofs)
  m.recordValue = m.record
}

export function getField(m, i) {
  if (i === 0) return m.recordValue
  return i <= m.nf ? m.fields[i] : undefined
}

// Assigning past NF extends the record with empty fields; any field
// assignment rebuilds $0 with OFS between fields. Assigning $0 re-splits
// (a number becomes its CONVFMT text).
export function setField(m, i, v) {
  if (i === 0) {
    const text = toStr(v, m)
    setRecord(m, text, typeof v === 'number' ? text : v)
    return
  }
  while (m.nf < i) m.fields[++m.nf] = ''
  m.fields[i] = v
  m.globals.set('NF', m.nf)
  rebuildRecord(m)
}

function setNF(m, v) {
  const n = Math.trunc(toNum(v))
  if (n < 0) throw new AwkError(`NF set to negative value ${n}`)
  while (m.nf < n) m.fields[++m.nf] = ''
  m.fields.length = n + 1
  m.nf = n
  m.globals.set('NF', n)
  rebuildRecord(m)
}

function fieldIndex(m, node) {
  const n = toNum(evalExpr(m, node))
  if (!(n >= 0)) throw new AwkError(`attempt to access field ${Number.isNaN(n) ? n : Math.trunc(n)}`)
  return Math.trunc(n)
}

// --- lvalues ---------------------------------------------------------

export function subscriptKeys(m, nodes) {
  if (nodes.length === 1) return subscriptKey(evalExpr(m, nodes[0]), m)
  const subsep = toStr(m.globals.get('SUBSEP'), m)
  return nodes.map((n) => subscriptKey(evalExpr(m, n), m)).join(subsep)
}

function resolveRef(m, node) {
  if (node.type === 'var') return { kind: 'var', name: node.name }
  if (node.type === 'index') return { kind: 'index', arr: getArray(m, node.name), key: subscriptKeys(m, node.subs) }
  return { kind: 'field', i: fieldIndex(m, node.index) }
}

function readRef(m, ref) {
  if (ref.kind === 'var') {
    const v = getVar(m, ref.name)
    if (v instanceof Map) throw arrayAsScalar(ref.name)
    return v
  }
  if (ref.kind === 'index') return ref.arr.get(ref.key)
  return getField(m, ref.i)
}

function writeRef(m, ref, v) {
  if (ref.kind === 'var') setVar(m, ref.name, v)
  else if (ref.kind === 'index') ref.arr.set(ref.key, v)
  else setField(m, ref.i, v)
}

export function assignTo(m, node, v) {
  writeRef(m, resolveRef(m, node), v)
}

// --- operators -------------------------------------------------------

function arith(op, a, b) {
  switch (op) {
    case '+': return a + b
    case '-': return a - b
    case '*': return a * b
    case '/':
      if (b === 0) throw new AwkError('division by zero attempted')
      return a / b
    case '%':
      if (b === 0) throw new AwkError('division by zero attempted in `%`')
      return a % b
    default: return a ** b
  }
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
export function regexOf(m, node) {
  const ic = ignoreCase(m)
  if (node.type === 'regex') return ic ? compileRegex(node.source, true) : node.re
  return compileRegex(toStr(evalExpr(m, node), m), ic, m.warn)
}

function scalar(v, name) {
  if (v instanceof Map) throw arrayAsScalar(name)
  return v
}

function increment(m, n, post) {
  const ref = resolveRef(m, n.target)
  const before = toNum(readRef(m, ref))
  const after = n.op === '++' ? before + 1 : before - 1
  writeRef(m, ref, after)
  return post ? before : after
}

const EVAL = {
  __proto__: null,
  num: (m, n) => n.value,
  str: (m, n) => n.value,
  regex: (m, n) => (regexOf(m, n).test(m.record) ? 1 : 0),
  var: (m, n) => scalar(getVar(m, n.name), n.name),
  index: (m, n) => {
    const arr = getArray(m, n.name)
    const key = subscriptKeys(m, n.subs)
    // Referencing an element creates it (POSIX), which is why `in` exists.
    if (!arr.has(key)) arr.set(key, undefined)
    return arr.get(key)
  },
  field: (m, n) => getField(m, fieldIndex(m, n.index)),
  assign: (m, n) => {
    const ref = resolveRef(m, n.target)
    let v = evalExpr(m, n.value)
    if (v instanceof Map) throw new AwkError('attempt to use an array in a scalar context')
    if (n.op !== '=') v = arith(n.op[0], toNum(readRef(m, ref)), toNum(v))
    writeRef(m, ref, v)
    return v
  },
  cond: (m, n) => evalExpr(m, truthy(evalExpr(m, n.test)) ? n.consequent : n.alternate),
  or: (m, n) => (truthy(evalExpr(m, n.left)) || truthy(evalExpr(m, n.right)) ? 1 : 0),
  and: (m, n) => (truthy(evalExpr(m, n.left)) && truthy(evalExpr(m, n.right)) ? 1 : 0),
  not: (m, n) => (truthy(evalExpr(m, n.expr)) ? 0 : 1),
  neg: (m, n) => -toNum(evalExpr(m, n.expr)),
  plus: (m, n) => toNum(evalExpr(m, n.expr)),
  binary: (m, n) => arith(n.op, toNum(evalExpr(m, n.left)), toNum(evalExpr(m, n.right))),
  concat: (m, n) => toStr(evalExpr(m, n.left), m) + toStr(evalExpr(m, n.right), m),
  compare: (m, n) => (COMPARE[n.op](compare(evalExpr(m, n.left), evalExpr(m, n.right), m)) ? 1 : 0),
  match: (m, n) => {
    const s = toStr(evalExpr(m, n.left), m)
    return regexOf(m, n.right).test(s) === n.negate ? 0 : 1
  },
  in: (m, n) => (getArray(m, n.array).has(subscriptKeys(m, n.keys)) ? 1 : 0),
  preinc: (m, n) => increment(m, n, false),
  postinc: (m, n) => increment(m, n, true),
  call: (m, n) => callUser(m, n),
  builtin: (m, n) => m.callBuiltin(m, n),
  getline: (m, n) => getline(m, n),
}

export function evalExpr(m, n) {
  return EVAL[n.type](m, n)
}

// --- user functions --------------------------------------------------

function callUser(m, n) {
  const fn = m.program.functions.get(n.name)
  if (n.args.length > fn.params.length) {
    throw new AwkError(`function \`${n.name}\` called with ${n.args.length} arguments, but it accepts only ${fn.params.length}`)
  }
  if (m.frames.length >= MAX_CALL_DEPTH) throw new AwkError(`function call nesting deeper than ${MAX_CALL_DEPTH} levels (runaway recursion?)`)
  const frame = new Map()
  for (let i = 0; i < fn.params.length; i++) frame.set(fn.params[i], i < n.args.length ? argValue(m, n.args[i]) : undefined)
  m.frames.push(frame)
  try {
    const sig = m.execStmts(m, fn.body)
    if (sig === undefined || sig.type === 'return') return sig?.value
    throw new Signal(sig)
  } finally {
    m.frames.pop()
  }
}

// A bare name is passed by reference when it holds an array or is
// still untyped; everything else is evaluated to a scalar.
function argValue(m, node) {
  if (node.type !== 'var') return evalExpr(m, node)
  const scope = scopeOf(m, node.name)
  const v = scope.get(node.name)
  if (v instanceof Map || isRef(v)) return v
  return v === undefined ? makeRef(scope, node.name) : v
}

// --- getline ---------------------------------------------------------

function getline(m, n) {
  let record
  if (n.file === null) {
    record = m.input.next(m)
    if (record === null) return 0
  } else {
    const r = m.input.readNamed(m, toStr(evalExpr(m, n.file), m))
    if (r.status !== 1) return r.status
    record = r.record
  }
  if (n.target === null) setRecord(m, record)
  else assignTo(m, n.target, new StrNum(record))
  return 1
}
