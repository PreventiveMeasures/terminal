import { UnsupportedError } from '../unsupported.js'
import { trimParameter } from './parameter-pattern.js'

const NAME = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?*@#$!-])(?![\s\S])/u
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/u
const HEAD = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?*@#$!-])/u

export function parameterError(content, message = 'unsupported or malformed parameter expansion') {
  return new UnsupportedError('feature', '${', `${message}: \${${content}}`)
}

const normalizeName = (name) => /^[0-9]+$/u.test(name) ? name.replace(/^0+(?=[0-9])/u, '') : name

export function parseParameter(content) {
  const logical = content.replaceAll('\\\n', '')
  if (logical.startsWith('#') && logical.length > 1 && NAME.test(logical.slice(1))) {
    return { name: normalizeName(logical.slice(1)), operator: 'length' }
  }
  // A length expression cannot carry another parameter operator.
  if (/^#[A-Za-z_0-9]/u.test(logical)) throw parameterError(content)
  const name = HEAD.exec(logical)?.[0]
  if (!name) throw parameterError(content)
  const suffix = logical.slice(name.length)
  if (!suffix) return { name: normalizeName(name), operator: '' }
  if (name === '#' && /^[%:=+/]$/u.test(suffix)) throw parameterError(content)
  const operator = /^(?::[-+=?]|[-+=?]|##?|%%?)/u.exec(suffix)?.[0]
  if (!operator) throw parameterError(content)
  return { name: normalizeName(name), operator, word: content.slice(prefixEnd(content, name.length + operator.length)) }
}

function prefixEnd(source, count) {
  let at = 0
  while (count > 0) {
    if (source[at] === '\\' && source[at + 1] === '\n') at += 2
    else { count--; at++ }
  }
  return at
}

export function evaluateParameter(ref, ctx, { lookup, expand }) {
  const { name, operator, word = '' } = ref
  const found = lookup(name, { quiet: operator !== '' })
  if (!operator) return found
  if (operator === 'length') return parameterLength(name, found.value)
  if (operator[0] === '#' || operator[0] === '%') {
    // Bash does not expand a removal pattern when there is no value to trim.
    if (!found.value || !word) return found
    return { value: trimParameter(found.value, expand(word, { pattern: true }), operator) }
  }
  const absent = !found.set || operator.startsWith(':') && found.value === ''
  const kind = operator[operator.length - 1]
  if (kind === '+') return absent ? { value: '', ...(found.omit ? { omit: true } : {}) } : expand(word, {})
  if (!absent) return found
  if (kind === '?') throw requiredParameter(name, word, operator.startsWith(':'), expand, ctx)
  if (kind !== '=') return expand(word, {})
  if (!VARIABLE.test(name)) {
    const error = new Error(`$${name}: cannot assign in this way`)
    error.exitCode = 1
    error.halt = true
    throw error
  }
  const result = expand(word, { assignment: true })
  ctx.vars.set(name, result.value)
  // Assignment substitutes the stored scalar, so only the enclosing quotes
  // protect its result from splitting and globbing, not quotes in the RHS.
  return { value: ctx.vars.get(name) }
}

function parameterLength(name, value) {
  if (name === '*' || name === '@') return { value: '0' }
  if (/\P{ASCII}/u.test(value)) {
    throw parameterError('#' + name, 'locale-dependent length of non-ASCII parameters is not supported')
  }
  return { value: String(value.length) }
}

function requiredParameter(name, word, nullness, expand, ctx) {
  const message = word ? errorMessage(expand(word, { error: true }), ctx) : nullness ? 'parameter null or not set' : 'parameter not set'
  const error = new Error(`${name}: ${message}`)
  error.exitCode = 1
  error.halt = true
  return error
}

function errorMessage(word, ctx) {
  const ifs = ctx.vars.get('IFS') ?? ' \t\n'
  if (ifs === '') return word.value
  if (ifs !== ' \t\n') throw parameterError('?', 'custom IFS separators in parameter errors are not supported')
  const empty = new Set(word.empty), fields = []
  let quoted = false, value = ''
  const push = () => {
    if (value || quoted) fields.push(value)
    value = ''; quoted = false
  }
  for (let i = 0; i <= word.value.length; i++) {
    if (empty.has(i)) quoted = true
    if (i === word.value.length) break
    const c = word.value[i]
    const bare = !word.mask || word.mask[i] === '0'
    if (bare && /[ \t\n]/u.test(c)) push()
    else {
      value += c
      quoted ||= !bare
    }
  }
  push()
  return fields.join(' ')
}
