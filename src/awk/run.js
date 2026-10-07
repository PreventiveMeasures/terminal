// BEGIN, per-file/per-record rules, then END. Statements return control-flow
// signals; user functions throw them across expression evaluation boundaries.

import { classTables } from '../locale.js'
import { AwkError, MAX_STEPS, sourceName } from './common.js'
import { callBuiltin } from './builtins.js'
import { AwkArray, subscript } from './array.js'
import { Signal, evalExpr, getArray, record, regexOf, setRecord, setVar, subscriptOf } from './eval.js'
import { Input } from './input.js'
import { initialRng } from './math.js'
import { redirectMessage } from './parse.js'
import { awkSprintf } from './printf.js'
import { NULL_FIELD, StrNum, byteLocale, compare, toNum, toOutStr, toStr, truthy } from './value.js'

const BREAK = { type: 'break' }
const CONTINUE = { type: 'continue' }
const NEXT = { type: 'next' }
const NEXTFILE = { type: 'nextfile' }
const EXIT = { type: 'exit' }
const BARE_PRINT = { dest: null }

// `once` holds the warnings gawk gives once per run, shared with what the
// parser warned of.
export function createMachine(program, ctx, stdin, operands, once = new Set()) {
  const argv = new AwkArray('ARGV')
  argv.lookup(subscript(0, '0')).value = 'awk'
  operands.forEach((op, i) => { argv.lookup(subscript(i + 1, String(i + 1))).value = new StrNum(op) })
  const procinfo = new SystemArray('PROCINFO')
  procinfo.lookup(subscript('FS', 'FS')).value = 'FS'
  const globals = new Map([
    ['FS', ' '], ['OFS', ' '], ['ORS', '\n'], ['RS', '\n'], ['RT', ''],
    ['NR', 0], ['NF', 0], ['FNR', 0], ['FILENAME', ''],
    ['SUBSEP', '\u001C'], ['CONVFMT', '%.6g'], ['OFMT', '%.6g'],
    ['RSTART', 0], ['RLENGTH', -1], ['ERRNO', ''], ['IGNORECASE', 0],
    ['FIELDWIDTHS', ''], ['FPAT', '[^[:space:]]+'],
    ['ENVIRON', new SystemArray('ENVIRON')], ['PROCINFO', procinfo],
    ['ARGC', operands.length + 1], ['ARGV', argv], ['ARGIND', 0],
  ])
  // Before any input $0 is an empty null field, as in gawk's BEGIN. `line`
  // and `src` are gawk's sourceline and source: where the statement running
  // now was read, which runtime messages name.
  const m = {
    program, globals, frame: undefined, callDepth: 0, record: '', recordValue: NULL_FIELD, dirty: false, fields: [undefined], nf: 0,
    fieldMode: 'FS', out: [], errOut: [], outputs: new Set(), steps: 0, exitCode: 0, ranges: [], rng: initialRng(),
    input: new Input(ctx, stdin), byteLocale: byteLocale(ctx), tables: classTables(ctx.locale),
    hasFileRules: program.beginFile.length > 0, line: 0, src: 0, once,
    // Injected so ./eval.js and ./input.js need no import of this
    // module or of the builtins.
    callBuiltin, execStmts,
    assign: (name, v) => setVar(m, name, v),
    warn: (msg, key) => m.warnAt(where(m), msg, key),
    warnAt: (place, msg, key) => {
      if (key) {
        if (once.has(key)) return
        once.add(key)
      }
      m.errOut.push(`awk: ${place}warning: ${msg}\n`)
    },
    fileRule: (kind) => fileRule(m, kind),
  }
  return m
}

// The place gawk names in a runtime message: the program line running, and
// the input record being read (FNR as an integer above 0).
export function where(m) {
  let place = m.line > 0 ? `${sourceName(m.program.sources, m.src)}:${m.line}: ` : ''
  const fnr = Math.trunc(toNum(m.globals.get('FNR')))
  if (fnr > 0) place += `(FILENAME=${toStr(m.globals.get('FILENAME'), m)} FNR=${fnr}) `
  return place
}

// Never present an absent process environment or a partial PROCINFO as
// complete data. In particular sorted_in controls iteration in gawk;
// accepting that key as an ordinary array entry silently ignores it.
class SystemArray extends AwkArray {
  constructor(name) { super(name); this.systemName = name }
  check(sub) {
    if (this.systemName === 'PROCINFO' && sub?.key === 'FS') return
    const detail = this.systemName === 'ENVIRON' ? 'ENVIRON' : `PROCINFO[${sub?.key ?? '*'}]`
    throw new AwkError(`${detail} is not supported without the corresponding environment or process metadata`, null, detail)
  }
  lookup(sub) { this.check(sub); return super.lookup(sub) }
  get(sub) { this.check(sub); return super.get(sub) }
  has(sub) { this.check(sub); return super.has(sub) }
  remove(sub) { this.check(sub); return super.remove(sub) }
  clear() { this.check(); super.clear() }
  get size() { this.check(); return super.size }
  keys() { this.check(); return super.keys() }
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
    throw new AwkError(`\`${sig.type}' cannot be called from a \`${label}' rule`)
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
      emit(m, BARE_PRINT, record(m) + toStr(m.globals.get('ORS'), m))
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
  m.line = rule.line
  m.src = rule.src
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
  m.line = s.line
  m.src = s.src
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
      else arr.remove(subscriptOf(m, s.subs))
      return
    }
    default: throw new AwkError(`unknown statement: ${s.type}`)
  }
}

function execLoop(m, s) {
  if (s.init) execSimple(m, s.init)
  let first = true
  while ((s.type === 'do' && first) || s.test === null || truthy(evalExpr(m, s.test))) {
    first = false
    const sig = execStmt(m, s.body)
    // break exits before a for-loop's step expression; continue still runs it.
    if (sig === BREAK) return
    if (sig !== undefined && sig !== CONTINUE) return sig
    if (s.step) execSimple(m, s.step)
  }
}

// A for loop's first and third parts are simple statements: an expression,
// or — as gawk's grammar has it — a print or a delete.
function execSimple(m, s) {
  if (s.type === 'expr') evalExpr(m, s.expr)
  else execStmt(m, s)
}

// Snapshot keys before iteration, including keys the body later deletes,
// in gawk's order (./array.js). A key is a string — even an integer one —
// unless it is input text a str array kept as it came.
function execForIn(m, s) {
  const arr = getArray(m, s.array)
  for (const key of arr.keys()) {
    setVar(m, s.name, key)
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
// here with the same rule. An empty name is gawk's own runtime error.
function emit(m, s, text) {
  if (s.dest === null) { m.out.push(text); return }
  const name = toStr(evalExpr(m, s.dest), m)
  if (name === '') throw new AwkError(`expression for \`${s.mode}' redirection has null string value`)
  if (name === '/dev/stdout') m.out.push(text)
  else if (name === '/dev/stderr') m.errOut.push(text)
  else if (name !== '/dev/null') throw new AwkError(redirectMessage(name), null, 'output redirection')
  m.outputs.add(name)
}

function execPrint(m, s) {
  const ors = toStr(m.globals.get('ORS'), m)
  let text
  if (s.args.length === 0) text = record(m)
  else {
    const ofs = toStr(m.globals.get('OFS'), m)
    text = s.args.map((a) => toOutStr(evalExpr(m, a), m)).join(ofs)
  }
  emit(m, s, text + ors)
}

function execPrintf(m, s) {
  if (s.args.length === 0) throw new AwkError('printf: no arguments')
  const values = s.args.map((a) => evalExpr(m, a))
  emit(m, s, awkSprintf(m, toStr(values[0], m), values.slice(1)))
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
