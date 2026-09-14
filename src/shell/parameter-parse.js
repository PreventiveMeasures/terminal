// Reading a `${…}` reference: its name, operator and operand, decided while
// the line is still being tokenized. Evaluating one is parameter.js, whose
// pattern and transform machinery this side deliberately does not reach.

import { UnsupportedError } from '../unsupported.js'

const NAME = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?*@#$!-])(?![\s\S])/u
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
  const operator = /^(?::[-+=?]|[-+=?]|##?|%%?|:|\/\/?)/u.exec(suffix)?.[0]
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
