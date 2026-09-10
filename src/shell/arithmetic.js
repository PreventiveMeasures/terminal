import { reason } from '../util.js'
import { parseArithmetic } from './arithmetic-parse.js'
import { arithmeticError, binaryArithmetic, signed } from './arithmetic-ops.js'
import { probeParameter } from './variables.js'

export function evaluateArithmetic(source, ctx, depth = 0) {
  const state = { ctx, steps: 10_000, characters: 200_000 }
  return evaluateSource(source, state, depth, true)
}

function evaluateSource(source, state, depth, active) {
  if (typeof source !== 'string') throw arithmeticError('value', 'expression must be a string')
  state.characters -= source.length
  if (source.length > 100_000 || state.characters < 0) throw arithmeticError('limit', 'expression size limit exceeded')
  if (depth > 128) throw arithmeticError('limit', 'variable recursion limit exceeded')
  return evaluateNode(parseArithmetic(source), state, depth + 1, active)
}

function variable(name, state, depth, active) {
  if (!active) return 0n
  let found
  try { found = probeParameter(name, state.ctx) } catch (e) {
    throw arithmeticError('variable', reason(e))
  }
  return found.set && found.value !== '' ? evaluateSource(found.value, state, depth + 1, true) : 0n
}

function write(name, value, state, active) {
  if (active) {
    try {
      probeParameter(name, state.ctx)
      state.ctx.vars.set(name, value.toString())
    } catch (e) {
      throw arithmeticError('assignment', reason(e))
    }
  }
  return value
}

// Bash parses skipped branches with noeval: variables become zero and writes
// stop, while numeric syntax and negative literal exponents still fail.
function evaluateNode(node, state, depth, active) {
  if (--state.steps < 0 || depth > 128) throw arithmeticError('limit', 'expression evaluation limit exceeded')
  const evaluate = (child, enabled = active) => evaluateNode(child, state, depth + 1, enabled)
  switch (node.type) {
    case 'number': return node.value
    case 'name': return variable(node.value, state, depth, active)
    case 'group': return evaluate(node.value)
    case 'unary': {
      const value = evaluate(node.value)
      if (node.op === '+') return value
      if (node.op === '-') return signed(-value)
      return node.op === '!' ? BigInt(value === 0n) : ~value
    }
    case 'increment': {
      const before = variable(node.name, state, depth, active)
      const after = write(node.name, signed(before + (node.op === '++' ? 1n : -1n)), state, active)
      return node.post ? before : after
    }
    case 'assignment': {
      const name = node.left.value
      const before = node.op === '=' ? 0n : variable(name, state, depth, active)
      const value = evaluate(node.right)
      return write(name, node.op === '=' ? value : binaryArithmetic(node.op.slice(0, -1), before, value, active), state, active)
    }
    case 'condition': {
      const condition = evaluate(node.test) !== 0n
      const consequent = evaluate(node.consequent, active && condition)
      const alternate = evaluate(node.alternate, active && !condition)
      return condition ? consequent : alternate
    }
    case 'binary': {
      const left = evaluate(node.left)
      const enabled = active && (node.op === '&&' ? left !== 0n : node.op === '||' ? left === 0n : true)
      const right = evaluate(node.right, enabled)
      if (node.op === ',') return right
      if (node.op === '&&') return BigInt(left !== 0n && right !== 0n)
      if (node.op === '||') return BigInt(left !== 0n || right !== 0n)
      return binaryArithmetic(node.op, left, right, active)
    }
    default: throw arithmeticError('syntax', 'unsupported expression')
  }
}
