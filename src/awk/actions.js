// The larger of the grammar's actions (./grammar.js): what gawk's actions
// in awkgram.y do when a rule is reduced, here building the program and its
// nodes (./build.js) and making gawk's checks in the order it makes them.
// Each takes the parse state, the values of the rule's symbols, and the
// first token the rule covers.

import * as B from './build.js'
import { SPECIAL_VARS } from './common.js'
import { numToStr } from './value.js'

const PROGRAM = { __proto__: null, BEGIN: 'begin', END: 'end', BEGINFILE: 'beginFile', ENDFILE: 'endFile' }

// A statement node, placed where its first token is.
export const at = (node, first) => { node.line = first.line; node.src = first.src; return node }
export const loopDone = (p) => { p.breakAllowed--; p.continueAllowed-- }

export function rule(p, v, first) {
  const [pattern, action] = v
  if (pattern?.section) p.program[PROGRAM[pattern.section]].push(...action)
  else p.program.rules.push({ pattern, action, line: first.line, src: first.src })
}

// A pattern with no action: a section keyword alone, or nothing at all
// before a `;`, is an error gawk reports and reads on past.
export function patternOnly(p, v, first) {
  if (p.rule !== 'Rule') p.message(`${p.rule} blocks must have an action part`)
  else if (v[0] === null) p.message('each rule must have a pattern or an action part')
  else rule(p, [v[0], null], first)
}

// install_function(): a name the program already has ends the parse; each
// parameter that will not do is an error.
export function prologue(p, v) {
  const [keyword, nameTok, , , paramToks] = v
  const name = nameTok.value
  if (p.lookup(name) !== null) {
    p.error(`function name \`${name}' previously defined`, keyword.line)
    p.abort()
  }
  paramToks.forEach((t, i) => {
    if (t.value === name) p.error(`function \`${name}': cannot use function name as parameter name`, t.line)
    else if (SPECIAL_VARS.has(t.value)) p.error(`function \`${name}': cannot use special variable \`${t.value}' as a function parameter`, t.line)
    for (let j = 0; j < i; j++) {
      if (paramToks[j].value === t.value) p.error(`function \`${name}': parameter #${i + 1}, \`${t.value}', duplicates parameter #${j + 1}`, t.line)
    }
  })
  p.functions.add(name)
  p.params = paramToks.map((t) => t.value)
  p.inFunction = true
  p.wantParamNames = 'body'
  return { name, params: p.params, keyword }
}

export function functionRule(p, v) {
  const [{ name, params, keyword }, body] = v
  p.inFunction = false
  p.program.functions.set(name, { params, body, file: keyword.src })
  p.wantParamNames = null
  p.params = null
}

// Repeated case values are found once the switch is read, last case first
// (a regex is never one); the value is the constant's string.
export function switchStatement(p, v, first) {
  const cases = v[6]
  const seen = new Set()
  let defaulted = false
  for (const c of cases.toReversed()) {
    if (c.test === null) {
      if (defaulted) p.error("duplicate `default' detected in switch body", c.at.line)
      defaulted = true
    } else if (c.test.type !== 'regex') {
      const key = c.test.type === 'num' ? numToStr(c.test.value, '%.6g') : c.test.value
      if (seen.has(key)) p.error(`duplicate case values in switch body: ${key}`, c.at.line)
      seen.add(key)
    }
  }
  p.breakAllowed--
  return at({ type: 'switch', expr: v[2], cases: cases.map(({ test, body }) => ({ test, body })) }, first)
}

export function forIn(p, v, first) {
  const [, , nameTok, , array, , , body] = v
  p.variable(nameTok)
  loopDone(p)
  if (array.type === 'index') B.arraysOfArrays(nameTok)
  return at({ type: 'forin', name: nameTok.value, array: array.name, body }, first)
}

export function jump(type, check) {
  return (p, v, first) => {
    check?.(p, v[0])
    return at({ type }, first)
  }
}

export const breakCheck = (p, tok) => { if (p.breakAllowed === 0) p.error("`break' is not allowed outside a loop or switch", tok.line) }
export const continueCheck = (p, tok) => { if (p.continueAllowed === 0) p.error("`continue' is not allowed outside a loop", tok.line) }
export const nextCheck = (p, tok) => { if (p.rule !== null && p.rule !== 'Rule') p.error(`\`next' used in ${p.rule} action`, tok.line) }
export const nextfileCheck = (p, tok) => {
  if (p.rule === 'BEGIN' || p.rule === 'END' || p.rule === 'ENDFILE') p.error(`\`nextfile' used in ${p.rule} action`, tok.line)
}

export function print(p, v, first) {
  const redir = v[3]
  return at({ type: v[0].value, args: v[2], dest: redir?.dest ?? null, mode: redir?.mode ?? null }, first)
}

export function getline(p, v) {
  const [tok, target, file] = v
  if ((p.rule === 'BEGINFILE' || p.rule === 'ENDFILE') && file === null) p.error(`non-redirected \`getline' invalid inside \`${p.rule}' rule`, tok.line)
  if (target?.fieldIncrement) B.unsupportedTarget(tok)
  return { type: 'getline', target, file, line: tok.line }
}

export function membership(keys, array) {
  if (array.type === 'index') B.arraysOfArrays(null)
  return { type: 'in', keys, array: array.name }
}

// `(expr)`: a regex constant in parentheses is no longer one — gawk passes
// the result of matching it where a regex is wanted.
export function parens(p, v) {
  const e = v[1]
  if (e.type === 'regex') return { type: 'match', negate: false, left: { type: 'field', index: { type: 'num', value: 0 } }, right: e, parens: true }
  e.parens = true
  return e
}

export function field(p, v) {
  const node = { type: 'field', index: v[1], line: v[0].line }
  return v[2] === null ? node : { type: 'postinc', op: v[2].value, target: node, fieldIncrement: true }
}

export function simpleVariable(p, v) {
  p.variable(v[0])
  const base = { name: v[0].value, line: v[0].line }
  return v.length === 1 ? { type: 'var', ...base } : { type: 'index', ...base, subs: v[1] }
}

export function match(p, v) {
  const [left, op, right] = v
  if (left.type === 'regex' && !left.parens) p.warn("regular expression on left of `~' or `!~' operator", null, op.line)
  return { type: 'match', negate: op.value === '!~', left, right }
}

