// Statement execution and the program driver: BEGIN, then the rules
// over every input record, then END. Control flow (`break`,
// `continue`, `next`, `nextfile`, `exit`, `return`) is returned from
// execStmt as a signal object and threaded outward; a signal that has
// to cross a function boundary is re-thrown as a `Signal` (awk-eval.js)
// and caught at the rule level.

import { AwkError, MAX_STEPS } from './awk-common.js'
import { callBuiltin, initialRng } from './awk-builtins.js'
import { Signal, evalExpr, getArray, setRecord, setVar, subscriptKeys } from './awk-eval.js'
import { Input } from './awk-input.js'
import { redirectMessage } from './awk-parse.js'
import { awkSprintf } from './awk-printf.js'
import { StrNum, toNum, toOutStr, toStr, truthy } from './awk-value.js'

const BREAK = { type: 'break' }
const CONTINUE = { type: 'continue' }
const NEXT = { type: 'next' }
const NEXTFILE = { type: 'nextfile' }
const EXIT = { type: 'exit' }

export function createMachine(program, ctx, stdin, operands) {
  const argv = new Map([['0', 'awk']])
  operands.forEach((op, i) => argv.set(String(i + 1), new StrNum(op)))
  const globals = new Map([
    ['FS', ' '], ['OFS', ' '], ['ORS', '\n'], ['RS', '\n'],
    ['NR', 0], ['NF', 0], ['FNR', 0], ['FILENAME', ''],
    ['SUBSEP', '\u001C'], ['CONVFMT', '%.6g'], ['OFMT', '%.6g'],
    ['RSTART', 0], ['RLENGTH', -1],
    ['ENVIRON', new Map()], ['ARGC', operands.length + 1], ['ARGV', argv],
  ])
  const m = {
    program, globals, frames: [], record: '', fields: [undefined], nf: 0,
    out: [], errOut: [], steps: 0, exitCode: 0, ranges: [], rng: initialRng(),
    input: new Input(ctx, stdin),
    // Injected so awk-eval.js and awk-input.js need no import of this
    // module or of the builtins.
    callBuiltin, execStmts,
    assign: (name, v) => setVar(m, name, v),
    warn: (msg) => m.errOut.push(`awk: ${msg}\n`),
  }
  return m
}

// The whole program. Returns the exit status; fatal errors propagate
// as AwkError for awk.js to report.
export function runProgram(m) {
  const { program } = m
  let sig = runSection(m, program.begin)
  if (!isExit(sig) && (program.rules.length > 0 || program.end.length > 0)) sig = mainLoop(m)
  // END still runs after `exit` in BEGIN or a rule (POSIX); an `exit`
  // inside END ends it.
  runSection(m, program.end)
  return m.exitCode
}

const isExit = (sig) => sig !== undefined && sig.type === 'exit'

function runSection(m, stmts) {
  try {
    return execStmts(m, stmts)
  } catch (e) {
    if (e instanceof Signal) return e.signal
    throw e
  }
}

function mainLoop(m) {
  for (;;) {
    const rec = m.input.next(m)
    if (rec === null) return
    setRecord(m, rec)
    const sig = runRules(m)
    if (isExit(sig)) return sig
    if (sig !== undefined && sig.type === 'nextfile') m.input.skipFile()
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
    const sig = runSection(m, rule.action)
    if (sig !== undefined) return sig
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

// --- statements ------------------------------------------------------

export function execStmts(m, stmts) {
  for (const s of stmts) {
    const sig = execStmt(m, s)
    if (sig !== undefined) return sig
  }
}

function execStmt(m, s) {
  if (++m.steps > MAX_STEPS) throw new AwkError(`execution stopped after ${MAX_STEPS} statements (infinite loop?)`)
  return EXEC[s.type](m, s)
}

// Loop bodies: `break` ends the loop, `continue` the iteration, and
// any other signal propagates. Returns the signal to propagate, or
// undefined to keep looping (the `broken` flag ends the loop quietly).
function loopStep(m, body, state) {
  const sig = execStmt(m, body)
  if (sig === undefined || sig === CONTINUE) return
  if (sig === BREAK) { state.broken = true; return }
  return sig
}

function execWhile(m, s) {
  const state = { broken: false }
  while (!state.broken && truthy(evalExpr(m, s.test))) {
    const sig = loopStep(m, s.body, state)
    if (sig !== undefined) return sig
  }
}

function execDo(m, s) {
  const state = { broken: false }
  do {
    const sig = loopStep(m, s.body, state)
    if (sig !== undefined) return sig
  } while (!state.broken && truthy(evalExpr(m, s.test)))
}

function execFor(m, s) {
  const state = { broken: false }
  if (s.init) evalExpr(m, s.init)
  while (!state.broken && (s.test === null || truthy(evalExpr(m, s.test)))) {
    const sig = loopStep(m, s.body, state)
    if (sig !== undefined) return sig
    if (s.step) evalExpr(m, s.step)
  }
}

// Iterates a snapshot of the keys (insertion order), skipping any the
// body deleted before reaching them. Keys are numeric strings, so a
// key that looks like a number compares as one.
function execForIn(m, s) {
  const arr = getArray(m, s.array)
  const state = { broken: false }
  for (const key of Array.from(arr.keys())) {
    if (state.broken) break
    if (!arr.has(key)) continue
    setVar(m, s.name, new StrNum(key))
    const sig = loopStep(m, s.body, state)
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
  else if (name !== '/dev/null') throw new AwkError(redirectMessage(name))
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

const EXEC = {
  __proto__: null,
  block: (m, s) => execStmts(m, s.body),
  empty: () => {},
  expr: (m, s) => { evalExpr(m, s.expr) },
  print: (m, s) => { execPrint(m, s) },
  printf: (m, s) => { execPrintf(m, s) },
  if: (m, s) => {
    if (truthy(evalExpr(m, s.test))) return execStmt(m, s.consequent)
    if (s.alternate !== null) return execStmt(m, s.alternate)
  },
  while: execWhile,
  do: execDo,
  for: execFor,
  forin: execForIn,
  break: () => BREAK,
  continue: () => CONTINUE,
  next: () => NEXT,
  nextfile: () => NEXTFILE,
  exit: execExit,
  return: (m, s) => ({ type: 'return', value: s.value === null ? undefined : evalExpr(m, s.value) }),
  delete: (m, s) => {
    const arr = getArray(m, s.name)
    if (s.subs === null) arr.clear()
    else arr.delete(subscriptKeys(m, s.subs))
  },
}
