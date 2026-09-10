import { compileGlob, globPattern, hasExtglob } from '../glob.js'
import { UnsupportedError } from '../unsupported.js'

const MAX_MATCH_WORK = 16_000_000
const error = (message) => new UnsupportedError('feature', '${', message)

export function trimParameter(value, word, operator) {
  if (hasExtglob(word)) throw error('extended glob patterns in parameter expansion are not supported')
  const pattern = globPattern({ value: word.value, mask: word.mask ?? null })
  const prefix = operator[0] === '#'
  const literal = literalPattern(pattern)
  if (literal !== null) {
    if (prefix) return value.startsWith(literal) ? value.slice(literal.length) : value
    return value.endsWith(literal) ? value.slice(0, value.length - literal.length) : value
  }
  const re = compileGlob(pattern, { bash: true })
  const longest = operator.length === 2
  const backward = prefix === longest
  let at = backward ? value.length : 0, work = 0
  while (at >= 0 && at <= value.length) {
    const candidate = prefix ? value.slice(0, at) : value.slice(at)
    work += candidate.length + pattern.length
    if (work > MAX_MATCH_WORK) throw error('parameter pattern removal exceeds the matching work limit')
    if (re.test(candidate)) return prefix ? value.slice(at) : value.slice(0, at)
    at = advance(value, at, backward)
  }
  return value
}

function advance(value, at, backward) {
  const next = at + (backward ? -1 : 1)
  if (next > 0 && next < value.length && /[\uDC00-\uDFFF]/u.test(value[next]) && /[\uD800-\uDBFF]/u.test(value[next - 1])) {
    return next + (backward ? -1 : 1)
  }
  return next
}

function literalPattern(pattern) {
  let value = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\' && i + 1 < pattern.length) value += pattern[++i]
    else if (/[*?[]/u.test(c)) return null
    else value += c
  }
  return value
}
