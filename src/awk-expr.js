// awk expression parser, precedence-climbing over the Parser from
// awk-parse.js. Lowest to highest:
//   assignment  = += -= *= /= %= ^= **=       (right)
//   ?:                                        (right)
//   ||   &&   in   ~ !~                       (left)
//   < <= == != > >=   (a `>` is a redirection inside print — opts.noGt)
//   concatenation (juxtaposition)
//   + -   * / %
//   unary ! - +
//   ^ **                                      (right; binds above unary
//                                             minus, so -2^2 is -4)
//   ++ -- (prefix / postfix)   $ (field)   grouping, literals, calls
// Nodes: num str regex var index field assign cond or and in match
// compare concat binary not neg plus preinc postinc call builtin getline.

import { NO_PROCESSES, UNSUPPORTED_BUILTINS } from './awk-common.js'
import { compileRegex } from './awk-regex.js'

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '^=', '**='])
const REL_OPS = new Set(['<', '<=', '==', '!=', '>', '>='])
const isLvalue = (n) => n.type === 'var' || n.type === 'index' || n.type === 'field'

// Can the current token begin an expression? Used for optional
// operands (`exit`, `return`) and for the concatenation test.
export function startsExpr(p) {
  const t = p.tok
  if (t.type === 'number' || t.type === 'string' || t.type === 'regex' || t.type === 'name' || t.type === 'funcname' || t.type === 'builtin') return true
  if (t.type === 'keyword') return t.value === 'getline'
  return t.type === 'punct' && ['$', '!', '-', '+', '(', '++', '--'].includes(t.value)
}

export function parseExprList(p, opts) {
  const items = [parseExpr(p, opts)]
  while (p.accept(',')) {
    p.skipNewlines()
    items.push(parseExpr(p, opts))
  }
  return items
}

export function parseExpr(p, opts) {
  const left = parseTernary(p, opts)
  const t = p.tok
  if (t.type === 'punct' && ASSIGN_OPS.has(t.value)) {
    if (!isLvalue(left)) p.fail(`cannot assign to ${left.type === 'regex' ? 'a regex' : 'a non-variable'} (left side of \`${t.value}\`)`)
    p.next()
    const value = parseExpr(p, opts)
    return { type: 'assign', op: t.value === '**=' ? '^=' : t.value, target: left, value }
  }
  return left
}

function parseTernary(p, opts) {
  const test = parseOr(p, opts)
  if (!p.accept('?')) return test
  p.skipNewlines()
  const consequent = parseExpr(p, opts)
  p.skipNewlines()
  p.expect(':')
  p.skipNewlines()
  return { type: 'cond', test, consequent, alternate: parseExpr(p, opts) }
}

function parseOr(p, opts) {
  let left = parseAnd(p, opts)
  while (p.accept('||')) {
    p.skipNewlines()
    left = { type: 'or', left, right: parseAnd(p, opts) }
  }
  return left
}

function parseAnd(p, opts) {
  let left = parseIn(p, opts)
  while (p.accept('&&')) {
    p.skipNewlines()
    left = { type: 'and', left, right: parseIn(p, opts) }
  }
  return left
}

function parseIn(p, opts) {
  let left = parseMatch(p, opts)
  while (p.isKw('in')) {
    p.next()
    left = { type: 'in', keys: [left], array: expectArrayName(p) }
  }
  return left
}

function expectArrayName(p) {
  if (p.tok.type !== 'name') p.fail(`expected an array name after \`in\` but found \`${p.tok.value}\``)
  return p.next().value
}

function parseMatch(p, opts) {
  let left = parseComparison(p, opts)
  while (p.is('~') || p.is('!~')) {
    const negate = p.next().value === '!~'
    left = { type: 'match', negate, left, right: parseComparison(p, opts) }
  }
  return left
}

function parseComparison(p, opts) {
  let left = parseConcat(p, opts)
  for (;;) {
    const t = p.tok
    // Inside a print list (`noGt`) a `|` is an output pipe, which
    // parsePrint reports; anywhere else it can only be `cmd | getline`.
    if (t.type === 'punct' && (t.value === '|' || t.value === '|&') && !opts.noGt) {
      p.fail(`command pipelines (\`"cmd" | getline\`) are not supported: ${NO_PROCESSES}`)
    }
    if (t.type !== 'punct' || !REL_OPS.has(t.value) || (opts.noGt && t.value === '>')) return left
    p.next()
    left = { type: 'compare', op: t.value, left, right: parseConcat(p, opts) }
  }
}

// Concatenation has no operator: two operands side by side. Anything
// that can start an operand continues one — except `+`, `-` (binary
// operators here, so `1 -1` is 0, not "1-1") and `!`.
function startsConcat(p) {
  const t = p.tok
  if (t.type === 'number' || t.type === 'string' || t.type === 'name' || t.type === 'funcname' || t.type === 'builtin') return true
  return t.type === 'punct' && ['$', '(', '++', '--'].includes(t.value)
}

export function parseConcat(p, opts) {
  let left = parseAdditive(p, opts)
  while (startsConcat(p)) left = { type: 'concat', left, right: parseAdditive(p, opts) }
  return left
}

function parseAdditive(p, opts) {
  let left = parseMultiplicative(p, opts)
  while (p.is('+') || p.is('-')) {
    const op = p.next().value
    left = { type: 'binary', op, left, right: parseMultiplicative(p, opts) }
  }
  return left
}

function parseMultiplicative(p, opts) {
  let left = parseUnary(p, opts)
  while (p.is('*') || p.is('/') || p.is('%')) {
    const op = p.next().value
    left = { type: 'binary', op, left, right: parseUnary(p, opts) }
  }
  return left
}

function parseUnary(p, opts) {
  if (p.accept('!')) return { type: 'not', expr: parseUnary(p, opts) }
  if (p.accept('-')) return { type: 'neg', expr: parseUnary(p, opts) }
  if (p.accept('+')) return { type: 'plus', expr: parseUnary(p, opts) }
  return parsePower(p, opts)
}

function parsePower(p, opts) {
  const base = parsePostfix(p, opts)
  if (!p.is('^') && !p.is('**')) return base
  p.next()
  return { type: 'binary', op: '^', left: base, right: parseUnary(p, opts) }
}

function parsePostfix(p, opts) {
  let e = parsePrefix(p, opts)
  while ((p.is('++') || p.is('--')) && isLvalue(e)) e = { type: 'postinc', op: p.next().value, target: e }
  return e
}

// `$` binds tighter than `++`: `$i++` is `($i)++`. Its operand is a
// primary, another `$`, a prefix increment, or a unary sign (`$-1`
// parses, and fails at run time as it does in gawk).
function parsePrefix(p, opts) {
  if (p.accept('$')) return { type: 'field', index: parseFieldOperand(p, opts) }
  if (p.is('++') || p.is('--')) {
    const op = p.next().value
    const target = parsePrefix(p, opts)
    if (!isLvalue(target)) p.fail(`\`${op}\` needs a variable, field or array element`)
    return { type: 'preinc', op, target }
  }
  return parsePrimary(p, opts)
}

function parseFieldOperand(p, opts) {
  if (p.is('$') || p.is('++') || p.is('--')) return parsePrefix(p, opts)
  if (p.accept('-')) return { type: 'neg', expr: parseFieldOperand(p, opts) }
  if (p.accept('+')) return { type: 'plus', expr: parseFieldOperand(p, opts) }
  if (p.accept('!')) return { type: 'not', expr: parseFieldOperand(p, opts) }
  return parsePrimary(p, opts)
}

function parsePrimary(p, opts) {
  const t = p.tok
  switch (t.type) {
    case 'number': p.next(); return { type: 'num', value: Number(t.value) }
    case 'string': p.next(); return { type: 'str', value: t.value }
    case 'regex': p.next(); return { type: 'regex', source: t.value, re: compileOrFail(p, t.value) }
    case 'name': return parseName(p)
    case 'funcname': return parseCall(p)
    case 'builtin': return parseBuiltin(p)
    case 'keyword':
      if (t.value === 'getline') return parseGetline(p, opts)
      return p.unexpected()
    case 'punct':
      if (t.value === '(') return parseGroup(p)
      return p.unexpected()
    default: return p.unexpected()
  }
}

function compileOrFail(p, source) {
  try { return compileRegex(source) } catch (e) { return p.fail(e.message) }
}

function parseName(p) {
  const name = p.next().value
  if (p.accept('[')) {
    const subs = parseExprList(p, {})
    p.expect(']')
    return { type: 'index', name, subs }
  }
  // `f (x)` — a space before the paren — is still a call when `f` is a
  // defined function; otherwise it is `f` concatenated with `(x)`.
  if (p.is('(') && p.funcs.has(name)) return finishCall(p, name)
  return { type: 'var', name }
}

function parseCall(p) {
  const name = p.next().value
  if (!p.funcs.has(name)) p.fail(`function \`${name}\` is never defined`)
  return finishCall(p, name)
}

function finishCall(p, name) {
  p.expect('(')
  const args = p.is(')') ? [] : parseExprList(p, {})
  p.expect(')')
  return { type: 'call', name, args }
}

// `(expr)`, or `(a, b) in arr` — the multi-subscript membership test,
// the only place a parenthesized list is an expression.
function parseGroup(p) {
  p.next()
  const list = parseExprList(p, {})
  p.expect(')')
  if (list.length === 1) return list[0]
  if (!p.isKw('in')) p.fail('a parenthesized list must be followed by `in ARRAY`')
  p.next()
  return { type: 'in', keys: list, array: expectArrayName(p) }
}

const ARITY = {
  __proto__: null,
  length: [0, 1], substr: [2, 3], index: [2, 2], split: [2, 3], sub: [2, 3], gsub: [2, 3],
  gensub: [3, 4], match: [2, 3], sprintf: [1, Infinity], sin: [1, 1], cos: [1, 1],
  atan2: [2, 2], exp: [1, 1], log: [1, 1], sqrt: [1, 1], int: [1, 1], rand: [0, 0],
  srand: [0, 1], tolower: [1, 1], toupper: [1, 1], close: [1, 2], fflush: [0, 1], systime: [0, 0],
}

function parseBuiltin(p) {
  const name = p.next().value
  if (UNSUPPORTED_BUILTINS.has(name)) p.fail(UNSUPPORTED_BUILTINS.get(name))
  if (!p.is('(')) {
    // `length` alone is `length($0)`; every other builtin needs its parens.
    if (name === 'length') return { type: 'builtin', name, args: [] }
    p.fail(`\`${name}\` needs parentheses: ${name}(...)`)
  }
  p.next()
  const args = p.is(')') ? [] : parseExprList(p, {})
  p.expect(')')
  const [min, max] = ARITY[name]
  if (args.length < min || args.length > max) {
    p.fail(`${name}() called with ${args.length} argument${args.length === 1 ? '' : 's'}; it takes ${min === max ? min : `${min} to ${max === Infinity ? 'any number' : max}`}`)
  }
  if ((name === 'sub' || name === 'gsub') && args[2] && !isLvalue(args[2])) p.fail(`${name}(): third argument must be a variable, field or array element`)
  if (name === 'split' && args[1].type !== 'var') p.fail('split(): second argument must be an array name')
  if (name === 'match' && args[2] && args[2].type !== 'var') p.fail('match(): third argument must be an array name')
  return { type: 'builtin', name, args }
}

// `getline`, `getline var`, `getline < file`, `getline var < file`.
// The `cmd | getline` form is caught in parseComparison, where the `|`
// shows up after `cmd` has been parsed.
function parseGetline(p, opts) {
  p.next()
  let target = null
  if (p.tok.type === 'name' || p.is('$')) {
    target = parsePrefix(p, opts)
    if (!isLvalue(target)) p.fail('getline: target must be a variable, field or array element')
  }
  let file = null
  if (p.accept('<')) file = parsePostfix(p, opts)
  return { type: 'getline', target, file }
}
