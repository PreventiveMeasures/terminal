// Assignment and ?: associate right; binary precedence lives in BINARY_LEVELS.
// Comparisons cannot chain. In print lists, noGt reserves > for redirection.
// Power binds above unary minus (-2^2 is -4), while $ binds above increment
// ($i++ increments the field). Regex literals remain distinct from strings.

import { BUILTIN_ARITY, NO_PROCESSES, UNSUPPORTED_BUILTINS, arithmetic } from './common.js'
import { compileRegex } from './regex.js'

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '^=', '**='])
const REL_OPS = new Set(['<', '<=', '==', '!=', '>', '>='])
const isLvalue = (n) => n.type === 'var' || n.type === 'index' || n.type === 'field'

// Expression starts for optional operands (exit/return) and concatenation.
export function startsExpr(p) {
  const t = p.tok
  return startsConcat(p) || t.type === 'regex' || (t.type === 'keyword' && t.value === 'getline')
    || (t.type === 'punct' && ['!', '-', '+'].includes(t.value))
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
  const test = parseBinary(p, opts)
  if (!p.accept('?')) return test
  p.skipNewlines()
  const consequent = parseExpr(p, opts)
  p.skipNewlines()
  p.expect(':')
  p.skipNewlines()
  return { type: 'cond', test, consequent, alternate: parseExpr(p, opts) }
}

const BINARY_LEVELS = [
  ['or', ['||']], ['and', ['&&']], ['in', ['in']], ['match', ['~', '!~']],
  ['compare', [...REL_OPS]], ['concat', []], ['binary', ['+', '-']], ['binary', ['*', '/', '%']],
]

const BINARY_OPERATORS = new Map(BINARY_LEVELS.flatMap(([type, operators], precedence) =>
  operators.map((op) => [op, { type, precedence }]),
))
const CONCAT = { type: 'concat', precedence: 5 }

function parseBinary(p, opts, minimum = 0) {
  let left = parseUnary(p, opts)
  let maximum = Infinity
  for (;;) {
    const t = p.tok
    // Once a comparison/match/in tier finishes, a following pipe belongs to
    // its caller. Before that, only an unsupported command | getline fits.
    if (minimum <= 4 && maximum > 4 && !opts.noGt && (p.is('|') || p.is('|&'))) {
      p.fail(`command pipelines (\`"cmd" | getline\`) are not supported: ${NO_PROCESSES}`, '"cmd" | getline')
    }
    const operator = startsConcat(p) ? CONCAT
      : t.type === 'punct' || (t.type === 'keyword' && t.value === 'in') ? BINARY_OPERATORS.get(t.value) : undefined
    if (!operator || operator.precedence < minimum || operator.precedence > maximum || (opts.noGt && p.is('>'))) return left
    const { type, precedence } = operator
    const op = type === 'concat' ? null : p.next().value
    maximum = precedence
    if (type === 'or' || type === 'and') p.skipNewlines()
    if (type === 'in') {
      left = { type, keys: [left], array: expectArrayName(p) }
      continue
    }
    const right = parseBinary(p, opts, precedence + 1)
    if ((op === '/' || op === '%') && constValue(right) === 0 && constValue(left) !== null) {
      p.fail(op === '/' ? 'division by zero attempted' : 'division by zero attempted in `%`')
    }
    if (type === 'compare' && isRelOp(p, opts)) {
      p.fail(`comparison operators do not chain (\`a ${op} b ${p.tok.value} c\`); parenthesize the first comparison`)
    }
    if (type === 'binary' || type === 'compare') left = { type, op, left, right }
    else if (type === 'match') left = { type, negate: op === '!~', left, right }
    else left = { type, left, right }
  }
}

function expectArrayName(p) {
  if (p.tok.type !== 'name') p.fail(`expected an array name after \`in\` but found \`${p.tok.value}\``)
  return p.next().value
}

const isRelOp = (p, opts) => p.tok.type === 'punct' && REL_OPS.has(p.tok.value) && !(opts.noGt && p.tok.value === '>')

// Concatenation has no operator: two operands side by side. Anything
// that can start an operand continues one — except `+`, `-` (binary
// operators here, so `1 -1` is 0, not "1-1") and `!`.
function startsConcat(p) {
  const t = p.tok
  if (t.type === 'number' || t.type === 'string' || t.type === 'name' || t.type === 'funcname' || t.type === 'builtin') return true
  return t.type === 'punct' && ['$', '(', '++', '--'].includes(t.value)
}

export function parseConcat(p, opts) {
  return parseBinary(p, opts, 5)
}

// The value of a constant numeric expression, or null. gawk folds
// these while reading the program, so `1 / 0` — or `2 ^ 3 % 0` in a
// branch that never runs — is refused before anything executes.
function constValue(node) {
  if (node.type === 'num') return node.value
  if (node.type === 'neg' || node.type === 'plus') {
    const v = constValue(node.expr)
    return v === null ? null : node.type === 'neg' ? -v : v
  }
  if (node.type !== 'binary') return null
  const a = constValue(node.left)
  const b = constValue(node.right)
  if (a === null || b === null) return null
  return arithmetic(node.op, a, b)
}

const UNARY_TYPES = { __proto__: null, '!': 'not', '-': 'neg', '+': 'plus' }

function parseUnary(p, opts, field = false) {
  if (field && (p.is('$') || p.is('++') || p.is('--'))) return parsePrefix(p, opts)
  const type = p.tok.type === 'punct' && UNARY_TYPES[p.tok.value]
  if (type) {
    p.next()
    return { type, expr: parseUnary(p, opts, field) }
  }
  return field ? parsePrimary(p, opts) : parsePower(p, opts)
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
  if (p.accept('$')) return { type: 'field', index: parseUnary(p, opts, true) }
  if (p.is('++') || p.is('--')) {
    const op = p.next().value
    const target = parsePrefix(p, opts)
    if (!isLvalue(target)) p.fail(`\`${op}\` needs a variable, field or array element`)
    return { type: 'preinc', op, target }
  }
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
  try { return compileRegex(source, false, (msg) => p.warn(msg)) } catch (e) { return p.fail(e.message, e.gap ?? null) }
}

export function parseSubscripts(p) {
  if (!p.accept('[')) return null
  const subs = parseExprList(p, {})
  p.expect(']')
  if (p.is('[')) p.fail('arrays of arrays are not supported', 'arrays of arrays')
  return subs
}

function parseName(p) {
  const name = p.next().value
  const subs = parseSubscripts(p)
  if (subs !== null) return { type: 'index', name, subs }
  // `f (x)` — a space before the paren — is how awk writes `f`
  // concatenated with `(x)`; when `f` is a function gawk refuses the
  // ambiguity outright rather than guess.
  if (p.is('(') && p.funcs.has(name)) p.fail(`function \`${name}\` called with space between name and \`(\``)
  return { type: 'var', name }
}

function parseCall(p) {
  const name = p.next().value
  if (!p.funcs.has(name)) p.fail(`function \`${name}\` is never defined`)
  return { type: 'call', name, args: parseCallArgs(p) }
}

function parseCallArgs(p) {
  p.expect('(')
  const args = p.is(')') ? [] : parseExprList(p, {})
  p.expect(')')
  return args
}

// `(expr)`, or `(a, b) in arr` — the multi-subscript membership test,
// the only place a parenthesized list is an expression.
function parseGroup(p) {
  // Collapse pure enclosing pairs without spending stack frames per pair.
  let wrappers = 0
  while (p.parens.get(p.i + 1) === p.parens.get(p.i) - 1) { p.next(); wrappers++ }
  p.next()
  const list = parseExprList(p, {})
  p.expect(')')
  if (list.length === 1) {
    while (wrappers-- > 0) p.expect(')')
    return list[0]
  }
  if (!p.isKw('in')) p.fail('a parenthesized list must be followed by `in ARRAY`')
  p.next()
  return { type: 'in', keys: list, array: expectArrayName(p) }
}

function parseBuiltin(p) {
  const name = p.next().value
  if (UNSUPPORTED_BUILTINS.has(name)) p.fail(UNSUPPORTED_BUILTINS.get(name), `${name}()`)
  if (!p.is('(')) {
    // `length` alone is `length($0)`; every other builtin needs its parens.
    if (name === 'length') return { type: 'builtin', name, args: [] }
    p.fail(`\`${name}\` needs parentheses: ${name}(...)`)
  }
  const args = parseCallArgs(p)
  const [min, max] = BUILTIN_ARITY[name]
  if (args.length < min || args.length > max) {
    p.fail(`${name}() called with ${args.length} argument${args.length === 1 ? '' : 's'}; it takes ${min === max ? min : `${min} to ${max === Infinity ? 'any number' : max}`}`)
  }
  if ((name === 'sub' || name === 'gsub') && args[2] && !isLvalue(args[2])) p.fail(`${name}(): substitution into a temporary value is not supported`, 'substitution into temporary value')
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
