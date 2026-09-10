import { UnsupportedError } from '../unsupported.js'
import { parseParameter } from './parameter.js'

const gap = (detail, message) => new UnsupportedError('feature', detail, message)
const limit = (depth) => {
  if (depth >= 64) throw gap('expansion depth', 'shell expansion nesting above 64 levels is not supported')
}

// Compound expansions retain raw source until evaluation. Inner quoting must
// not leak into the enclosing word, and embedded substitutions own their ends.
export function readBracedExpansion(line, start, open, depth, quoted, helpers) {
  limit(depth)
  const body = open + 1
  let quote = null
  for (let i = body; i < line.length; i++) {
    const c = line[i]
    if (quote === "'") { if (c === "'") quote = null; continue }
    if (c === '\\') { i++; continue }
    if (c === '"') { quote = quote === '"' ? null : '"'; continue }
    if (c === "'" && !quote) { quote = "'"; continue }
    if (c === '`') throw gap('`', 'command substitution (backticks) is not supported')
    if (c === '$') {
      let next = i + 1
      while (line[next] === '\\' && line[next + 1] === '\n') next += 2
      if (line[next] === "'" && !quote) {
        const ansi = helpers.decodeAnsiC(line, next + 1)
        // Bash inserts decoded ANSI text into quoted default operands before
        // finding their closing brace, even when the operand is not selected.
        const operator = parseParameter(line.slice(body, i)).operator
        if (quoted && /[-+?=]/u.test(operator) && /[$`"'\\}]/u.test(ansi.text)) {
          throw gap('${', 'active characters in ANSI-C quoted parameter operands are not supported')
        }
        i = ansi.end - 1
        continue
      }
      const nested = helpers.readExpansion(line, i, depth + 1, quoted || quote === '"')
      if (nested) { i += nested.raw.length - 1; continue }
    }
    if (c === '}' && !quote) {
      const parameter = parseParameter(line.slice(body, i))
      return { raw: line.slice(start, i + 1), parameter }
    }
  }
  throw gap('${', 'unterminated parameter expansion')
}

export function readArithmeticExpansion(line, start, open, depth, helpers) {
  limit(depth)
  let parens = 0
  for (let i = open + 1; i < line.length; i++) {
    const c = line[i]
    if (c === '\\') { i++; continue }
    if (c === '$') {
      const nested = helpers.readExpansion(line, i, depth + 1, true)
      if (nested) { i += nested.raw.length - 1; continue }
    }
    if (c === '`') throw gap('`', 'command substitution (backticks) is not supported')
    // Arithmetic quote removal is not implemented. Refuse quotes before a
    // quoted parenthesis could be mistaken for the end of this expansion.
    if (c === '"' || c === "'") throw gap('$((', 'quotes in arithmetic expressions are not supported')
    if (c === '(') parens++
    if (c !== ')') continue
    if (parens) { parens--; continue }
    let end = i + 1
    while (line[end] === '\\' && line[end + 1] === '\n') end += 2
    if (line[end] !== ')') throw gap('$((', 'arithmetic expansion requires a closing `))`')
    return { raw: line.slice(start, end + 1), arithmetic: line.slice(open + 1, i) }
  }
  throw gap('$((', 'unterminated arithmetic expansion')
}
