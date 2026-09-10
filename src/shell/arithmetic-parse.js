import { arithmeticError, integerLiteral } from './arithmetic-ops.js'

const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '^=', '|='])
const LEVELS = [
  ['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '<=', '>', '>='],
  ['<<', '>>'], ['+', '-'], ['*', '/', '%'], ['**'],
]
const BINARY = new Map(LEVELS.flatMap((operators, level) => operators.map((operator) => [operator, level + 3])))
const OPERATOR = /^(?:<<=|>>=|\+\+|--|\*\*|&&|\|\||<<|>>|[+\-*/%&^|=!<>]=|[+\-*/%&^|=!~<>?:,()])/u

function tokenize(source) {
  const tokens = []
  for (let at = 0; at < source.length;) {
    if (tokens.length >= 10_000) throw arithmeticError('limit', 'expression token limit exceeded')
    const rest = source.slice(at)
    const space = /^[ \t\n]+/u.exec(rest)
    if (space) { at += space[0].length; continue }
    const number = /^[0-9][A-Za-z0-9#@_]*/u.exec(rest)
    const name = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(rest)
    const operator = OPERATOR.exec(rest)
    if (number) tokens.push({ type: 'number', value: integerLiteral(number[0]), raw: number[0] })
    else if (name) tokens.push({ type: 'name', value: name[0], raw: name[0] })
    else if (operator) tokens.push({ type: 'operator', value: operator[0], raw: operator[0] })
    else throw arithmeticError(rest[0] === '[' || rest[0] === ']' ? 'arrays' : 'syntax', 'unsupported expression token ' + JSON.stringify(rest[0]))
    at += tokens.at(-1).raw.length
  }
  tokens.push({ type: 'end', value: '' })
  return tokens
}

export function parseArithmetic(source) {
  const parser = new ArithmeticParser(tokenize(source))
  if (parser.token.type === 'end') return { type: 'number', value: 0n }
  const result = parser.expression()
  if (parser.token.type !== 'end') throw arithmeticError('syntax', 'unexpected token ' + parser.token.value)
  return result
}

class ArithmeticParser {
  constructor(tokens) {
    this.tokens = tokens
    this.at = 0
    this.depth = 0
  }

  get token() { return this.tokens[this.at] }
  next() { return this.tokens[this.at++] }
  accept(value) { return this.token.value === value ? this.next() : null }
  expect(value) {
    if (!this.accept(value)) throw arithmeticError('syntax', 'expected ' + value)
  }

  expression(minimum = 0) {
    if (++this.depth > 128) throw arithmeticError('limit', 'expression nesting limit exceeded')
    let left = this.prefix()
    for (;;) {
      const op = this.token.value
      if (op === '?' && minimum <= 2) {
        this.next()
        const consequent = this.expression()
        this.expect(':')
        left = { type: 'condition', test: left, consequent, alternate: this.expression(2) }
        continue
      }
      const assignment = ASSIGN.has(op)
      const level = op === ',' ? 0 : assignment ? 1 : BINARY.get(op)
      if (level === undefined || level < minimum) break
      this.next()
      if (assignment && left.type !== 'name') throw arithmeticError('assignment', 'attempted assignment to non-variable')
      const right = this.expression(level + (assignment || op === '**' ? 0 : 1))
      left = { type: assignment ? 'assignment' : 'binary', op, left, right }
    }
    this.depth--
    return left
  }

  prefix() {
    const token = this.next()
    if (['+', '-', '!', '~'].includes(token.value)) {
      return { type: 'unary', op: token.value, value: this.expression(14) }
    }
    if (token.value === '++' || token.value === '--') {
      const target = this.next()
      if (target.type !== 'name') throw arithmeticError('increment', 'increment requires a scalar variable')
      return { type: 'increment', op: token.value, name: target.value, post: false }
    }
    if (token.value === '(') {
      const value = this.expression()
      this.expect(')')
      return { type: 'group', value }
    }
    if (token.type !== 'number' && token.type !== 'name') throw arithmeticError('syntax', 'operand expected')
    if (token.type === 'name' && (this.token.value === '++' || this.token.value === '--')) {
      return { type: 'increment', op: this.next().value, name: token.value, post: true }
    }
    return token
  }
}
