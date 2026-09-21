import { INTEGER_TESTS, fileTest } from '../commands/test.js'
import { expandPattern } from './expand.js'
import { compileGlob, globPattern, hasExtglob } from '../glob.js'
import { UnsupportedError } from '../unsupported.js'
import { evaluateArithmetic } from './arithmetic.js'
import { probeParameter } from './variables.js'

export async function evaluateConditional(expression, ctx) {
  return { stdout: '', stderr: '', exitCode: await evaluate(expression, ctx) ? 0 : 1 }
}

const scalar = async (word, ctx) => (await expandPattern(word, ctx)).value

async function evaluate(expression, ctx) {
  const { kind } = expression
  if (kind === 'not') return !await evaluate(expression.expression, ctx)
  // `&&` and `||` read the right side only where the left leaves the answer
  // open, so the wait for it happens only where bash would ask.
  if (kind === 'and') return await evaluate(expression.left, ctx) && await evaluate(expression.right, ctx)
  if (kind === 'or') return await evaluate(expression.left, ctx) || await evaluate(expression.right, ctx)
  const { op } = expression
  if (kind === 'unary') {
    const value = await scalar(expression.word, ctx)
    if (op === '-n') return value !== ''
    if (op === '-z') return value === ''
    if (['-a', '-e', '-f', '-d'].includes(op)) return fileTest(op, value, ctx)
    if (op === '-v') return variableSet(value, ctx)
    gap(op)
  }
  if (['<', '>', '-nt', '-ot', '-ef'].includes(op)) gap(op)
  const left = await scalar(expression.left, ctx)
  if (Object.hasOwn(INTEGER_TESTS, op)) {
    // Bash expands both operands before evaluating either arithmetic expression.
    const right = await scalar(expression.right, ctx)
    return INTEGER_TESTS[op](evaluateArithmetic(left, ctx), evaluateArithmetic(right, ctx))
  }
  const pattern = await expandPattern(expression.right, ctx)
  if (hasExtglob(pattern)) gap('extglob')
  const matches = compileGlob(globPattern(pattern), { bash: true }).test(left)
  return op === '!=' ? !matches : matches
}

function variableSet(value, ctx) {
  if (value.includes('[')) gap('-v array subscript')
  if (/^[ \t\n\r\f\v]*[+-]?0+[ \t]*$/u.test(value)) gap('-v positional parameter')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) return false
  return probeParameter(value, ctx).set
}

function gap(operator) {
  throw new UnsupportedError('feature', `[[ ${operator}`, `${operator} in [[ is not supported`)
}
