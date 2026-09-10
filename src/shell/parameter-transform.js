import { UnsupportedError } from '../unsupported.js'
import { evaluateArithmetic } from './arithmetic.js'
import { replaceParameter } from './parameter-pattern.js'
import { INT64_MAX } from '../numeric.js'

const gap = (message) => new UnsupportedError('feature', '${', message)

export function transformParameter(ref, found, ctx, options) {
  if (ref.name === '@' || ref.name === '*') throw gap('substring and replacement of positional parameter lists are not supported')
  // Bash skips operand evaluation for an unset scalar, but not an empty one.
  if (!found.set) return found
  if (ref.operator === ':') {
    try { return { value: substring(found.value, ref.word, ctx, options) } }
    catch (error) { error.halt = true; throw error }
  }
  const raw = ref.word
  let first = 0
  while (raw[first] === '\\' && raw[first + 1] === '\n') first += 2
  const delimiter = separator(raw, '/', options.readExpansion, raw[first] === '/' ? first + 1 : 0)
  const pattern = options.expand(raw.slice(0, delimiter), { pattern: true })
  const replacement = options.expand(delimiter < raw.length ? raw.slice(delimiter + 1) : '', { replacement: true })
  return { value: replaceParameter(found.value, pattern, replacement, ref.operator === '//') }
}

function substring(value, source, ctx, options) {
  if (/\P{ASCII}/u.test(value)) throw gap('locale-dependent slicing of non-ASCII parameters is not supported')
  const delimiter = separator(source, ':', options.readExpansion)
  const arithmetic = (text) => evaluateArithmetic(options.expand(text, { arithmetic: true }).value, ctx)
  let start = arithmetic(source.slice(0, delimiter))
  const size = BigInt(value.length)
  if (start < 0n) start += size
  if (start < 0n || start > size) return ''
  let end = size
  if (delimiter < source.length) {
    const length = arithmetic(source.slice(delimiter + 1))
    end = length < 0n ? size + length : start + length
    if (end > INT64_MAX) throw gap('substring length overflows the shell integer range')
    if (end < start) {
      const error = new Error(`${source.slice(delimiter + 1)}: substring expression < 0`)
      error.exitCode = 1
      error.halt = true
      throw error
    }
  }
  return value.slice(Number(start), Number(end > size ? size : end))
}

// Delimiters inside quotes, nested expansions, arithmetic parentheses, and
// ternary expressions belong to those constructs rather than this operator.
function separator(source, delimiter, readExpansion, start = 0) {
  let parens = 0, quote = null, ternaries = 0
  for (let i = start; i < source.length; i++) {
    const c = source[i]
    if (quote === "'") { if (c === "'") quote = null; continue }
    if (quote === 'ansi') {
      if (c === '\\') i++
      else if (c === "'") quote = null
      continue
    }
    if (c === '\\') { i++; continue }
    if (delimiter === ':' && (c === "'" || c === '"')) throw gap('quoted substring arithmetic is not supported')
    if (c === '"') { quote = quote === '"' ? null : '"'; continue }
    if (c === "'" && !quote) { quote = c; continue }
    if (c === '$') {
      const nested = readExpansion(source, i, 0, delimiter === ':' || quote === '"')
      if (nested) { i += nested.raw.length - 1; continue }
      let next = i + 1
      while (source[next] === '\\' && source[next + 1] === '\n') next += 2
      if (!quote && source[next] === "'") { quote = 'ansi'; i = next; continue }
    }
    if (quote) continue
    if (delimiter === ':') {
      if (c === '(') parens++
      else if (c === ')') parens--
      else if (parens === 0 && c === '?') ternaries++
      else if (parens === 0 && c === ':' && ternaries) { ternaries--; continue }
      if (parens !== 0) continue
    }
    if (c === delimiter) return i
  }
  return source.length
}
