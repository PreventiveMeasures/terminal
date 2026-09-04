// awk parser: program structure and statements. Expressions live in
// awk-expr.js. The result is a plain AST:
//   program    { begin, end, beginFile, endFile: [stmt], rules: [rule],
//                functions: Map, warnings: [string] }
//   rule       { pattern: null | expr | { type: 'range', from, to }, action: null | [stmt] }
//   function   { params: [name], body: [stmt] }
// Statement nodes carry a `type` of block / expr / print / printf / if /
// while / do / for / forin / switch / break / continue / next / nextfile /
// exit / return / delete / empty; awk-run.js executes them by type.
//
// The unsupported forms are refused HERE, not at run time, so a program
// is rejected as a whole even when the offending statement sits in a
// branch that would never run: output to files (`print > "f"`; only
// `/dev/stdout`, `/dev/stderr` and `/dev/null` are accepted), output
// pipes (`print | "cmd"`), and — in awk-expr.js — `cmd | getline`,
// `system()` and the other builtins listed in awk-common.js.

import { AwkError, NO_PROCESSES } from './awk-common.js'
import { compileRegex } from './awk-regex.js'
import { parseConcat, parseExpr, parseExprList, startsExpr } from './awk-expr.js'
import { tokenize } from './awk-lex.js'

export const OUTPUT_TARGETS = new Set(['/dev/stdout', '/dev/stderr', '/dev/null'])

export class Parser {
  constructor(tokens, warnings) {
    this.toks = tokens
    this.i = 0
    this.warnings = warnings
    // Every `function NAME` in the program, collected up front so a call
    // may precede its definition (and `f (x)` with a space still reads
    // as a call when `f` is a function).
    this.funcs = new Set()
    for (let k = 0; k + 1 < tokens.length; k++) {
      const t = tokens[k]
      const n = tokens[k + 1]
      if (t.type === 'keyword' && t.value === 'function' && (n.type === 'name' || n.type === 'funcname')) this.funcs.add(n.value)
    }
    this.loopDepth = 0
    this.switchDepth = 0
    this.context = 'main'  // 'begin' | 'end' | 'beginfile' | 'endfile' | 'main' | 'function'
  }

  get tok() { return this.toks[this.i] }
  peek(k) { return this.toks[Math.min(this.i + k, this.toks.length - 1)] }
  is(value, type = 'punct') { return this.tok.type === type && this.tok.value === value }
  isKw(value) { return this.is(value, 'keyword') }
  next() { return this.toks[this.i++] }
  accept(value, type = 'punct') { return this.is(value, type) ? this.next() : null }
  expect(value, type = 'punct') {
    if (!this.is(value, type)) this.fail(`expected \`${value}\` but found ${describe(this.tok)}`)
    return this.next()
  }
  skipNewlines() { while (this.tok.type === 'newline') this.i++ }
  skipTerminators() { while (this.tok.type === 'newline' || this.is(';')) this.i++ }
  fail(msg) { throw new AwkError(msg, this.tok.line) }
  warn(msg) { this.warnings.push(msg) }
  unexpected() { this.fail(`unexpected ${describe(this.tok)}`) }
}

function describe(t) {
  if (t.type === 'eof') return 'end of program'
  if (t.type === 'newline') return 'newline'
  if (t.type === 'string') return `string "${t.value}"`
  if (t.type === 'regex') return `regex /${t.value}/`
  return `\`${t.value}\``
}

const SECTIONS = { __proto__: null, BEGIN: 'begin', END: 'end', BEGINFILE: 'beginFile', ENDFILE: 'endFile' }
const CONTEXTS = { __proto__: null, BEGIN: 'begin', END: 'end', BEGINFILE: 'beginfile', ENDFILE: 'endfile' }

export function parseProgram(src) {
  const warnings = []
  const p = new Parser(tokenize(src, (msg) => warnings.push(msg)), warnings)
  const program = { begin: [], end: [], beginFile: [], endFile: [], rules: [], functions: new Map(), warnings }
  // Items are separated by newlines; a single `;` may follow an item. A
  // `;` with no item before it is an empty rule, which awk rejects.
  p.skipNewlines()
  while (p.tok.type !== 'eof') {
    if (p.is(';')) p.fail('each rule must have a pattern or an action part')
    parseItem(p, program)
    p.accept(';')
    p.skipNewlines()
  }
  return program
}

function parseItem(p, program) {
  if (p.isKw('function')) { parseFunction(p, program); return }
  if (p.tok.type === 'keyword' && p.tok.value in SECTIONS) {
    const which = p.next().value
    if (!p.is('{')) p.fail(`${which} requires an action: ${which} { ... }`)
    program[SECTIONS[which]].push(...parseBlock(p, CONTEXTS[which]))
    return
  }
  if (p.is('{')) { program.rules.push({ pattern: null, action: parseBlock(p, 'main') }); return }
  const first = parseExpr(p, {})
  let pattern = first
  if (p.accept(',')) {
    p.skipNewlines()
    pattern = { type: 'range', from: first, to: parseExpr(p, {}) }
  }
  // The action must open on the pattern's line; a pattern alone prints
  // the record, and a `{` on the next line is a separate, unconditional
  // rule — exactly as awk reads it.
  const action = p.is('{') ? parseBlock(p, 'main') : null
  if (action === null && !(p.tok.type === 'newline' || p.tok.type === 'eof' || p.is(';'))) p.unexpected()
  program.rules.push({ pattern, action })
}

function parseFunction(p, program) {
  p.next()
  const nameTok = p.tok
  if (nameTok.type === 'builtin') p.fail(`cannot redefine builtin function \`${nameTok.value}\``)
  if (nameTok.type !== 'name' && nameTok.type !== 'funcname') p.fail(`expected a function name but found ${describe(nameTok)}`)
  p.next()
  const name = nameTok.value
  if (program.functions.has(name)) p.fail(`function \`${name}\` is defined twice`)
  p.expect('(')
  const params = []
  while (!p.is(')')) {
    const t = p.tok
    if (t.type !== 'name') p.fail(`expected a parameter name but found ${describe(t)}`)
    if (t.value === name || params.includes(t.value)) p.fail(`duplicate parameter \`${t.value}\` in function \`${name}\``)
    params.push(p.next().value)
    if (!p.accept(',')) break
    p.skipNewlines()
  }
  p.expect(')')
  p.skipNewlines()
  program.functions.set(name, { params, body: parseBlock(p, 'function') })
}

function parseBlock(p, context = p.context) {
  const saved = p.context
  p.context = context
  p.expect('{')
  const body = []
  p.skipTerminators()
  while (!p.is('}')) {
    if (p.tok.type === 'eof') p.fail('missing `}` at end of program')
    body.push(parseStatement(p))
    p.skipTerminators()
  }
  p.next()
  p.context = saved
  return body
}

// A simple statement ends at `;`, a newline, `}` or the end of the
// program; the first two are consumed here.
function endSimple(p) {
  if (p.is(';') || p.tok.type === 'newline') { p.next(); return }
  if (p.is('}') || p.tok.type === 'eof') return
  p.unexpected()
}

const STATEMENTS = {
  __proto__: null,
  if: parseIf,
  while: parseWhile,
  do: parseDo,
  for: parseFor,
  switch: parseSwitch,
  break: (p) => simpleJump(p, 'break'),
  continue: (p) => simpleJump(p, 'continue'),
  next: (p) => simpleJump(p, 'next'),
  nextfile: (p) => simpleJump(p, 'nextfile'),
  exit: (p) => valueJump(p, 'exit'),
  return: (p) => valueJump(p, 'return'),
  delete: parseDelete,
  print: (p) => parsePrint(p, 'print'),
  printf: (p) => parsePrint(p, 'printf'),
}

function parseStatement(p) {
  if (p.is('{')) return { type: 'block', body: parseBlock(p) }
  if (p.is(';')) { p.next(); return { type: 'empty' } }
  const handler = p.tok.type === 'keyword' ? STATEMENTS[p.tok.value] : undefined
  if (handler) return handler(p)
  const expr = parseExpr(p, {})
  endSimple(p)
  return { type: 'expr', expr }
}

// The body of a control statement may start on the next line.
function parseBody(p, isLoop) {
  p.skipNewlines()
  if (isLoop) p.loopDepth++
  const body = parseStatement(p)
  if (isLoop) p.loopDepth--
  return body
}

function parseIf(p) {
  p.next()
  p.expect('(')
  const test = parseExpr(p, {})
  p.expect(')')
  const consequent = parseBody(p, false)
  // `else` may follow line breaks after the then-branch (its own `;` or
  // newline was consumed with it); a `;` after a `}` is a stray one.
  const mark = p.i
  p.skipNewlines()
  if (!p.isKw('else')) { p.i = mark; return { type: 'if', test, consequent, alternate: null } }
  p.next()
  return { type: 'if', test, consequent, alternate: parseBody(p, false) }
}

function parseWhile(p) {
  p.next()
  p.expect('(')
  const test = parseExpr(p, {})
  p.expect(')')
  return { type: 'while', test, body: parseBody(p, true) }
}

function parseDo(p) {
  p.next()
  const body = parseBody(p, true)
  p.skipTerminators()
  if (!p.isKw('while')) p.fail('`do` body must be followed by `while (...)`')
  p.next()
  p.expect('(')
  const test = parseExpr(p, {})
  p.expect(')')
  endSimple(p)
  return { type: 'do', body, test }
}

function parseFor(p) {
  p.next()
  p.expect('(')
  if (p.tok.type === 'name' && p.peek(1).type === 'keyword' && p.peek(1).value === 'in' && p.peek(2).type === 'name' && p.peek(3).value === ')') {
    const name = p.next().value
    p.next()
    const array = p.next().value
    p.next()
    return { type: 'forin', name, array, body: parseBody(p, true) }
  }
  const init = p.is(';') ? null : parseExpr(p, {})
  p.expect(';')
  p.skipNewlines()
  const test = p.is(';') ? null : parseExpr(p, {})
  p.expect(';')
  p.skipNewlines()
  const step = p.is(')') ? null : parseExpr(p, {})
  p.expect(')')
  return { type: 'for', init, test, step, body: parseBody(p, true) }
}

// gawk's switch: `case` values are constants (a number, possibly signed,
// a string, or a regex); matching follows `==` (or `~` for a regex),
// cases fall through until `break`, and `default` may sit anywhere.
function parseSwitch(p) {
  p.next()
  p.expect('(')
  const expr = parseExpr(p, {})
  p.expect(')')
  p.skipNewlines()
  p.expect('{')
  const cases = []
  const seen = new Set()
  p.switchDepth++
  for (p.skipTerminators(); !p.is('}'); p.skipTerminators()) {
    let test = null
    if (p.accept('case', 'keyword')) test = parseCaseValue(p)
    else if (!p.accept('default', 'keyword')) p.fail(`expected \`case\` or \`default\` in switch body but found ${describe(p.tok)}`)
    const key = test === null ? 'default' : test.type === 'regex' ? `/${test.source}/` : String(test.value)
    if (seen.has(key)) p.fail(`duplicate case values in switch body: ${key}`)
    seen.add(key)
    p.expect(':')
    const body = []
    p.skipTerminators()
    while (!p.is('}') && !p.isKw('case') && !p.isKw('default')) {
      if (p.tok.type === 'eof') p.fail('missing `}` at end of program')
      body.push(parseStatement(p))
      p.skipTerminators()
    }
    cases.push({ test, body })
  }
  p.switchDepth--
  p.next()
  return { type: 'switch', expr, cases }
}

function parseCaseValue(p) {
  const sign = p.accept('-') ? -1 : (p.accept('+'), 1)
  const t = p.tok
  if (t.type === 'number') { p.next(); return { type: 'num', value: sign * Number(t.value) } }
  if (sign === 1 && t.type === 'string') { p.next(); return { type: 'str', value: t.value } }
  if (sign === 1 && t.type === 'regex') {
    p.next()
    return { type: 'regex', source: t.value, re: compileRegex(t.value, false, (msg) => p.warn(msg)) }
  }
  return p.fail(`case value must be a number, string or regex constant, found ${describe(t)}`)
}

function simpleJump(p, type) {
  if (type === 'break' && p.loopDepth === 0 && p.switchDepth === 0) p.fail('`break` is not allowed outside a loop or switch')
  if (type === 'continue' && p.loopDepth === 0) p.fail('`continue` is not allowed outside a loop')
  if (type === 'next' && p.context !== 'main' && p.context !== 'function') p.fail(`\`next\` cannot be used in a ${p.context.toUpperCase()} action`)
  if (type === 'nextfile' && (p.context === 'begin' || p.context === 'end' || p.context === 'endfile')) p.fail(`\`nextfile\` cannot be used in a ${p.context.toUpperCase()} action`)
  p.next()
  endSimple(p)
  return { type }
}

function valueJump(p, type) {
  if (type === 'return' && p.context !== 'function') p.fail('`return` is only allowed inside a function')
  p.next()
  const value = startsExpr(p) ? parseExpr(p, {}) : null
  endSimple(p)
  return { type, value }
}

function parseDelete(p) {
  p.next()
  if (p.tok.type !== 'name') p.fail(`\`delete\` needs an array name but found ${describe(p.tok)}`)
  const name = p.next().value
  let subs = null
  if (p.accept('[')) {
    subs = parseExprList(p, {})
    p.expect(']')
  }
  endSimple(p)
  return { type: 'delete', name, subs }
}

const isPrintEnd = (p) => p.is(';') || p.is('}') || p.is('>') || p.is('>>') || p.is('|') || p.is('|&')
  || p.tok.type === 'newline' || p.tok.type === 'eof'

// `print a, b > "/dev/stderr"`: inside a print list an unparenthesized
// `>` is a redirection, not a comparison (awk's own rule). A leading
// `(` is ambiguous — `print (a, b)` is a parenthesized list, `print
// (a)(b)` a concatenation, `print (a > b) ? c : d` an expression — so
// the list reading is tried first and abandoned unless a terminator or
// redirection follows the `)`.
function parsePrint(p, kind) {
  p.next()
  let args = null
  if (p.is('(')) {
    const mark = p.i
    p.next()
    const list = p.is(')') ? [] : parseExprList(p, {})
    if (p.accept(')') && isPrintEnd(p)) args = list
    else p.i = mark
  }
  if (args === null) args = isPrintEnd(p) ? [] : parseExprList(p, { noGt: true })
  if (kind === 'printf' && args.length === 0) p.fail('printf needs a format string')
  let dest = null
  if (p.is('|') || p.is('|&')) p.fail(`output pipes (\`${kind} ... | "cmd"\`) are not supported: ${NO_PROCESSES}`)
  if (p.accept('>') || p.accept('>>')) {
    dest = parseConcat(p, { noGt: true })
    if (dest.type === 'str' && !OUTPUT_TARGETS.has(dest.value)) p.fail(redirectMessage(dest.value))
  }
  endSimple(p)
  return { type: kind, args, dest }
}

export function redirectMessage(name) {
  return `cannot redirect output to \`${name}\`: the filesystem is read-only (only /dev/stdout, /dev/stderr and /dev/null are supported; to print a comparison, parenthesize it: print (a > b))`
}
