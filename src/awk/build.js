// The checks gawk's grammar actions make as they build a program, with
// their messages, and the expression nodes they build (./grammar.js). The
// node types are the ones ./eval.js evaluates; a node read inside
// parentheses is marked `parens`, which gawk's checks see (`(x)` cannot be
// assigned to, `(0)` is not a constant).

import { AT_GAP, AwkError, BUILTIN_ARITY, NO_PROCESSES, UNSUPPORTED_BUILTINS, arithmetic } from './common.js'
import { compileRegex, regexErrorMessage } from './regex.js'

export const OUTPUT_TARGETS = new Set(['/dev/stdout', '/dev/stderr', '/dev/null'])

export function redirectMessage(name) {
  return `cannot redirect output to \`${name}\`: the filesystem is read-only (only /dev/stdout, /dev/stderr and /dev/null). To print a comparison, parenthesize it: print (a > b)`
}

// What gawk folds into a single constant as it reads the program, and so
// treats as one: a number or string constant, a negated number, `!` of a
// constant, arithmetic on two numbers, two strings side by side. Null for
// anything else.
export function constant(node) {
  if (node.parens) return null
  switch (node.type) {
    case 'num': return { value: node.value, number: true }
    case 'str': return { value: node.value, number: false }
    case 'neg': {
      const c = constant(node.expr)
      return c?.number ? { value: -c.value, number: true } : null
    }
    case 'not': {
      const c = constant(node.expr)
      if (c === null) return null
      return { value: (c.number ? c.value === 0 : c.value === '') ? 1 : 0, number: true }
    }
    case 'binary': case 'concat': return node.folded ?? null
    default: return null
  }
}

// mk_binary(): a division by a constant 0 is an error gawk reports and
// reads on past; arithmetic on two numeric constants is folded.
export function binary(p, left, opTok, right) {
  const op = opTok.type
  const node = { type: 'binary', op, left, right }
  if (op === '/' || op === '%') node.line = opTok.line
  const r = constant(right)
  if (r === null) return node
  const l = constant(left)
  const byZero = (op === '/' || op === '%') && r.number && r.value === 0
  if (byZero) p.error(op === '/' ? 'division by zero attempted' : "division by zero attempted in `%'", opTok.line)
  else if (l?.number && r.number) node.folded = { value: arithmetic(op, l.value, r.value), number: true }
  return node
}

export function concat(left, right) {
  const node = { type: 'concat', left, right }
  const l = constant(left)
  const r = constant(right)
  if (l !== null && r !== null && !l.number && !r.number) node.folded = { value: l.value + r.value, number: false }
  return node
}

// An assignment's target, or what `++` or `--` works on: `$i++` has
// already done its own assignment.
export function assignable(p, target) {
  if (target.fieldIncrement) p.lexer.syntaxError('cannot assign a value to the result of a field post-increment expression')
  return target
}

// A regex constant, compiled as gawk compiles it when it has read one; what
// is wrong with one is an error gawk stops at.
export function regex(p, tok) {
  const line = p.lexer.line
  let re
  try {
    re = compileRegex(tok.value, false, (msg, once) => p.warn(msg, once, line))
  } catch (e) {
    if (!(e instanceof AwkError) || e.gap !== null) throw e
    const message = regexErrorMessage(e)
    if (message === null) throw new AwkError(e.message, tok.line, 'regex error message')
    p.error(`${message}: /${tok.value}/`, line)
    p.abort()
  }
  return { type: 'regex', source: tok.value, re, line: tok.line, src: tok.src }
}

// A builtin's call, as snode() checks it: the number of arguments, and
// that sub() and gsub() can change what they are given (a constant, which
// they leave alone, will do).
export function builtin(p, tok, args) {
  const name = tok.value
  if (UNSUPPORTED_BUILTINS.has(name)) throw new AwkError(UNSUPPORTED_BUILTINS.get(name), tok.line, `${name}()`)
  const [min, max] = BUILTIN_ARITY[name]
  if (args.length < min || args.length > max) p.lexer.syntaxError(`${args.length} is invalid as number of arguments for ${name}`)
  if ((name === 'sub' || name === 'gsub') && args.length === 3 && constant(args[2]) === null && !changeable(args[2])) {
    p.lexer.syntaxError(`${name} third parameter is not a changeable object`)
  }
  if (name === 'typeof' && args.length === 2) throw new AwkError("typeof()'s second argument is not supported", tok.line, 'typeof debug array')
  return { type: 'builtin', name, args, line: tok.line }
}

const changeable = (node) => !node.parens && (node.type === 'var' || node.type === 'index' || node.type === 'field')

// A call to a function of the program's: a name already a variable is an
// error; a regex constant as an argument passes the result of matching it,
// with a warning.
export function call(p, tok, args) {
  const kind = p.lookup(tok.value)
  if (kind === 'var' || kind === 'param') p.error(`attempt to use non-function \`${tok.value}' in function call`, tok.line)
  args.forEach((arg, i) => {
    if (arg.type === 'regex' && !arg.parens) p.warn(`regexp constant for parameter #${i + 1} yields boolean value`, null, arg.line)
  })
  return { type: 'call', name: tok.value, args, line: tok.line }
}

// `print ... > file` and `| cmd`: a pipe runs a process, and a file other
// than awk's three devices would be written; neither is possible here.
export function redirect(p, opTok, dest) {
  const kind = p.printKind
  if (opTok.value === '|' || opTok.value === '|&') throw new AwkError(`output pipes (\`${kind} ... | "cmd"\`) are not supported: ${NO_PROCESSES}`, opTok.line, `${kind} | "cmd"`)
  if (dest.type === 'str' && !dest.parens && dest.value !== '' && !OUTPUT_TARGETS.has(dest.value)) throw new AwkError(redirectMessage(dest.value), opTok.line, `${kind} > FILE`)
  return { mode: opTok.value, dest }
}

export function pipeGetline(tok) {
  throw new AwkError(`command pipelines (\`"cmd" | getline\`) are not supported: ${NO_PROCESSES}`, tok.line, '"cmd" | getline')
}

// `getline $i++`: gawk itself stops on an internal assertion there.
export function unsupportedTarget(tok) {
  throw new AwkError('getline into a field incremented after it is not supported', tok.line, 'getline $i++')
}

export function indirectCall(tok) {
  throw new AwkError(AT_GAP, tok.line, '@ extensions')
}

export function arraysOfArrays(tok) {
  throw new AwkError('arrays of arrays are not supported', tok?.line ?? null, 'arrays of arrays')
}
