// BEGIN, per-file/per-record rules, then END. Statements return control-flow
// signals; user functions throw them across expression evaluation boundaries.

import { AwkError, MAX_STEPS } from './common.js'
import { callBuiltin } from './builtins.js'
import { Signal, evalExpr, getArray, regexOf, setRecord, setVar, subscriptKeys } from './eval.js'
import { Input } from './input.js'
import { initialRng } from './math.js'
import { redirectMessage } from './parse.js'
import { awkSprintf } from './printf.js'
import { StrNum, byteLocale, compare, toNum, toOutStr, toStr, truthy } from './value.js'

const BREAK = { type: 'break' }
const CONTINUE = { type: 'continue' }
const NEXT = { type: 'next' }
const NEXTFILE = { type: 'nextfile' }
const EXIT = { type: 'exit' }

export function createMachine(program, ctx, stdin, operands) {
  const argv = new Map([['0', 'awk']])
  operands.forEach((op, i) => argv.set(String(i + 1), new StrNum(op)))
  const globals = new Map([
    ['FS', ' '], ['OFS', ' '], ['ORS', '\n'], ['RS', '\n'], ['RT', ''],
    ['NR', 0], ['NF', 0], ['FNR', 0], ['FILENAME', ''],
    ['SUBSEP', '\u001C'], ['CONVFMT', '%.6g'], ['OFMT', '%.6g'],
    ['RSTART', 0], ['RLENGTH', -1], ['ERRNO', ''], ['IGNORECASE', 0],
    ['FIELDWIDTHS', ''], ['FPAT', '[^[:space:]]+'],
    ['ENVIRON', new SystemArray('ENVIRON')], ['PROCINFO', new SystemArray('PROCINFO', [['FS', 'FS']])],
    ['ARGC', operands.length + 1], ['ARGV', argv], ['ARGIND', 0],
  ])
  const m = {
    program, globals, frame: undefined, callDepth: 0, record: '', recordValue: new StrNum(''), fields: [undefined], nf: 0,
    fieldMode: 'FS', out: [], errOut: [], steps: 0, exitCode: 0, ranges: [], rng: initialRng(),
    input: new Input(ctx, stdin), byteLocale: byteLocale(ctx),
    hasFileRules: program.beginFile.length > 0,
    // Injected so ./eval.js and ./input.js need no import of this
    // module or of the builtins.
    callBuiltin, execStmts,
    assign: (name, v) => setVar(m, name, v),
    warn: (msg) => m.errOut.push(`awk: warning: ${msg}\n`),
    fileRule: (kind) => fileRule(m, kind),
  }
  return m
}

// Never present an absent process environment or a partial PROCINFO as
// complete data. In particular sorted_in controls iteration in gawk;
// accepting that key as an ordinary array entry silently ignores it.
class SystemArray extends Map {
  constructor(name, entries = []) { super(entries); this.systemName = name }
  check(key) {
    if (!this.systemName || (this.systemName === 'PROCINFO' && key === 'FS')) return
    const detail = this.systemName === 'ENVIRON' ? 'ENVIRON' : `PROCINFO[${key ?? '*'}]`
    throw new AwkError(`${detail} is not supported without the corresponding environment or process metadata`, null, detail)
  }
  get(key) { this.check(key); return super.get(key) }
  has(key) { this.check(key); return super.has(key) }
  set(key, value) { this.check(key); return super.set(key, value) }
  delete(key) { this.check(key); return super.delete(key) }
  clear() { this.check(); return super.clear() }
  get size() { this.check(); return super.size }
  keys() { this.check(); return super.keys() }
  values() { this.check(); return super.values() }
  entries() { this.check(); return super.entries() }
  [Symbol.iterator]() { this.check(); return super[Symbol.iterator]() }
}

// The whole program. Returns the exit status; fatal errors propagate
// as AwkError for awk.js to report.
export function runProgram(m) {
  const { program } = m
  const sig = runSection(m, program.begin, 'BEGIN')
  const readsInput = program.rules.length > 0 || program.end.length > 0 || program.beginFile.length > 0 || program.endFile.length > 0
  if (!isExit(sig) && readsInput) mainLoop(m)
  // END still runs after `exit` in BEGIN or a rule (POSIX); an `exit`
  // inside END ends it.
  runSection(m, program.end, 'END')
  return m.exitCode
}

const isExit = (sig) => sig !== undefined && sig.type === 'exit'

// A BEGIN / END / BEGINFILE / ENDFILE body. `next` reaching one of them
// through a function call is the runtime form of the parse-time rule.
function runSection(m, stmts, label) {
  const sig = execAction(m, stmts)
  if (sig !== undefined && (sig.type === 'next' || (sig.type === 'nextfile' && (label === 'BEGIN' || label === 'END')))) {
    throw new AwkError(`\`${sig.type}' cannot be called from a ${label} rule`)
  }
  return sig
}

function fileRule(m, kind) {
  const stmts = kind === 'begin' ? m.program.beginFile : m.program.endFile
  return stmts.length === 0 ? undefined : runSection(m, stmts, kind === 'begin' ? 'BEGINFILE' : 'ENDFILE')
}

function mainLoop(m) {
  for (;;) {
    const rec = m.input.next(m)
    if (rec === null) return m.input.exitSignal
    setRecord(m, rec)
    const sig = runRules(m)
    if (isExit(sig)) return sig
    if (sig !== undefined && sig.type === 'nextfile') m.input.closeFile(m)
  }
}

function runRules(m) {
  const { rules } = m.program
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]
    if (!ruleMatches(m, rule, i)) continue
    if (rule.action === null) {
      emit(m, null, m.record + toStr(m.globals.get('ORS'), m))
      continue
    }
    const sig = execAction(m, rule.action)
    if (sig !== undefined) return sig
  }
}

// Unwrap control flow crossing a user-function boundary at the action.
function execAction(m, stmts) {
  try { return execStmts(m, stmts) } catch (e) {
    if (!(e instanceof Signal)) throw e
    return e.signal
  }
}

// A range pattern is armed by its start expression and disarmed by its
// end expression, which is checked on the same record that armed it.
function ruleMatches(m, rule, i) {
  const { pattern } = rule
  if (pattern === null) return true
  if (pattern.type !== 'range') return truthy(evalExpr(m, pattern))
  if (!m.ranges[i]) {
    if (!truthy(evalExpr(m, pattern.from))) return false
    m.ranges[i] = true
  }
  if (truthy(evalExpr(m, pattern.to))) m.ranges[i] = false
  return true
}

export function execStmts(m, stmts) {
  for (const s of stmts) {
    const sig = execStmt(m, s)
    if (sig !== undefined) return sig
  }
}

function execStmt(m, s) {
  if (++m.steps > MAX_STEPS) throw new AwkError(`execution stopped after ${MAX_STEPS} statements (infinite loop?)`, null, 'execution limit')
  switch (s.type) {
    case 'block': return execStmts(m, s.body)
    case 'empty': return
    case 'expr': evalExpr(m, s.expr); return
    case 'print': return execPrint(m, s)
    case 'printf': return execPrintf(m, s)
    case 'if':
      if (truthy(evalExpr(m, s.test))) return execStmt(m, s.consequent)
      return s.alternate === null ? undefined : execStmt(m, s.alternate)
    case 'while': case 'do': case 'for': return execLoop(m, s)
    case 'forin': return execForIn(m, s)
    case 'switch': return execSwitch(m, s)
    case 'break': return BREAK
    case 'continue': return CONTINUE
    case 'next': return NEXT
    case 'nextfile': return NEXTFILE
    case 'exit': return execExit(m, s)
    case 'return': return { type: 'return', value: s.value === null ? undefined : evalExpr(m, s.value) }
    case 'delete': {
      const arr = getArray(m, s.name)
      if (s.subs === null) arr.clear()
      else arr.delete(subscriptKeys(m, s.subs))
      return
    }
    default: throw new AwkError(`unknown statement: ${s.type}`)
  }
}

function execLoop(m, s) {
  if (s.init) evalExpr(m, s.init)
  let first = true
  while ((s.type === 'do' && first) || s.test === null || truthy(evalExpr(m, s.test))) {
    first = false
    const sig = execStmt(m, s.body)
    // break exits before a for-loop's step expression; continue still runs it.
    if (sig === BREAK) return
    if (sig !== undefined && sig !== CONTINUE) return sig
    if (s.step) evalExpr(m, s.step)
  }
}

// Snapshot keys before iteration, including keys the body later deletes.
// Numeric-looking keys retain their numeric-string type.
function execForIn(m, s) {
  const arr = getArray(m, s.array)
  for (const key of Array.from(arr.keys())) {
    setVar(m, s.name, new StrNum(key))
    const sig = execStmt(m, s.body)
    if (sig === BREAK) return
    if (sig !== undefined && sig !== CONTINUE) return sig
  }
}

// The first matching case (or `default`) starts execution, which then
// falls through the following cases until a `break`.
function execSwitch(m, s) {
  const v = evalExpr(m, s.expr)
  const hit = (c) => (c.test.type === 'regex' ? regexOf(m, c.test).test(toStr(v, m)) : compare(v, c.test.value, m) === 0)
  let start = s.cases.findIndex((c) => c.test !== null && hit(c))
  if (start === -1) start = s.cases.findIndex((c) => c.test === null)
  if (start === -1) return
  for (let i = start; i < s.cases.length; i++) {
    const sig = execStmts(m, s.cases[i].body)
    if (sig === BREAK) return
    if (sig !== undefined) return sig
  }
}

// Output goes to stdout unless redirected to one of the three device
// names the parser lets through as literals; a computed name is checked
// here with the same rule.
function emit(m, dest, text) {
  if (dest === null) { m.out.push(text); return }
  const name = toStr(evalExpr(m, dest), m)
  if (name === '/dev/stdout') m.out.push(text)
  else if (name === '/dev/stderr') m.errOut.push(text)
  else if (name !== '/dev/null') throw new AwkError(redirectMessage(name), null, 'output redirection')
}

function execPrint(m, s) {
  const ors = toStr(m.globals.get('ORS'), m)
  let text
  if (s.args.length === 0) text = m.record
  else {
    const ofs = toStr(m.globals.get('OFS'), m)
    text = s.args.map((a) => toOutStr(evalExpr(m, a), m)).join(ofs)
  }
  emit(m, s.dest, text + ors)
}

function execPrintf(m, s) {
  const values = s.args.map((a) => evalExpr(m, a))
  emit(m, s.dest, awkSprintf(m, toStr(values[0], m), values.slice(1)))
}

// `exit N` sets the status as the OS would see it; a later bare `exit`
// keeps it.
function execExit(m, s) {
  if (s.value !== null) {
    const n = Math.trunc(toNum(evalExpr(m, s.value)))
    m.exitCode = ((n % 256) + 256) % 256
  }
  return EXIT
}
