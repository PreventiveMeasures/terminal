// Reads a program as gawk 5.2.1 reads it: with its grammar (./grammar.js)
// in tables built the way Bison builds them (./lalr.js), its lexer
// (./lex.js), and its grammar actions' checks (./build.js), so that a
// program gawk runs is read the same, and a program it rejects is rejected
// at the same token with what gawk prints before it.
//
// The program is { begin, end, beginFile, endFile, rules, functions,
// sources }: statements per section, rules { pattern, action, line, src },
// and functions by name { params, body, file }. Every statement carries
// the line and source it starts on, for gawk's runtime messages; statement
// types dispatch in ./run.js.
//
// What is wrong with a program goes to the parse log as gawk prints it:
// errors gawk reads on past (`error: ...`; the run then exits 1), warnings,
// and plain messages. An error gawk stops at ends the parse: a syntax error
// is thrown as an AwkError of kind 'syntax' carrying the text yyerror()
// prints, one gawk aborts at as kind 'abort' (its message already logged).

import { AwkError, SPECIAL_VARS } from './common.js'
import { GRAMMAR } from './grammar.js'
import { Lexer } from './lex.js'
import { ERROR, buildTables } from './lalr.js'

export { redirectMessage } from './build.js'

let tables = null

// What the grammar's actions and the lexer share, as gawk's globals: how
// the lexer is to read on, which rule is being read, and the names gawk's
// symbol table holds so far (the built-in variables and -v assignments
// from the start, then each variable as it is read, functions as they are
// defined, and a function's parameters while its body is read).
class ParseState {
  constructor(sources, log, vars) {
    this.log = log
    this.wantRegexp = false
    this.inPrint = false
    this.inParens = 0
    this.wantParamNames = null
    this.breakAllowed = 0
    this.continueAllowed = 0
    this.rule = null
    this.inFunction = false
    this.printKind = null
    // SYMTAB and FUNCTAB are names gawk's symbol table holds besides.
    this.globals = new Set([...SPECIAL_VARS, 'SYMTAB', 'FUNCTAB', ...vars])
    this.functions = new Set()
    this.params = null
    this.program = { begin: [], end: [], beginFile: [], endFile: [], rules: [], functions: new Map(), sources }
    this.lexer = new Lexer(sources, this)
  }

  isParam(name) { return this.params?.includes(name) ?? false }

  lookup(name) {
    if (this.isParam(name)) return 'param'
    if (this.functions.has(name)) return 'func'
    return this.globals.has(name) ? 'var' : null
  }

  // gawk's variable(): a name read as a variable or array becomes one,
  // unless it is already a function's.
  variable(tok) {
    const kind = this.lookup(tok.value)
    if (kind === 'func') this.error(`function \`${tok.value}' called with space between name and \`(',\nor used as a variable or an array`, tok.line)
    else if (kind === null) this.globals.add(tok.value)
  }

  warn(msg, once, line) { this.log.warn(msg, once, line, this.lexer.src) }
  error(msg, line) { this.log.add('error', msg, line, this.lexer.src) }
  message(msg) { this.log.add('msg', msg, this.lexer.line, this.lexer.src) }
  abort() { throw new AwkError('parse aborted', this.lexer.line, null, 'abort') }
}

export function parseProgram(sources, log, vars = []) {
  tables ??= buildTables(GRAMMAR)
  const p = new ParseState(sources, log, vars)
  const states = [0]
  const values = [null]
  const starts = [null]
  let la = null
  for (;;) {
    const s = states.at(-1)
    if (s === tables.final) return p.program
    let rule = tables.defaults[s]
    if (!tables.defaultOnly[s]) {
      la ??= p.lexer.next()
      const action = tables.actions[s].get(tables.tokenIndex.get(la.type))
      if (action === ERROR || (action === undefined && rule < 0)) p.lexer.syntaxError()
      if (action >= 0) {
        states.push(action)
        values.push(la)
        starts.push(la)
        la = null
        continue
      }
      if (action !== undefined) rule = -1 - action
    }
    const { lhs, length } = tables.rules[rule]
    const args = values.splice(values.length - length)
    // The first token the rule covers; an empty symbol covers none.
    const first = starts.splice(starts.length - length).find((t) => t !== null) ?? null
    states.length -= length
    values.push(GRAMMAR.rules[rule - 1].action(p, args, first))
    starts.push(first)
    states.push(tables.gotos[states.at(-1)].get(lhs))
  }
}
