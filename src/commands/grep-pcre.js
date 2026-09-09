import { UnsupportedError } from '../unsupported.js'
import { isUnicodeScalar } from '../unicode.js'

function gap(detail) {
  throw new UnsupportedError('feature', 'PCRE ' + detail, `PCRE ${detail} is not supported`)
}

// PCRE and JS agree on this subset. Reject differing capture, assertion,
// escape and repetition semantics before the JS matcher can select lines.
export function pcreSource(pattern) {
  const state = { captures: 0, closed: new Set(), names: new Map(), stack: [], behind: 0, references: false, risky: false }
  let out = ''
  for (let i = 0; i < pattern.length;) {
    const c = pattern[i]
    if (c === '\\') {
      const part = escape(pattern, i, state, false)
      out += part.source; i = part.end; continue
    }
    if (c === '[') {
      const part = characterClass(pattern, i, state)
      out += part.source; i = part.end; continue
    }
    if (c === '(') {
      const part = group(pattern, i, state)
      out += part.source; i = part.end; continue
    }
    if (c === ')') {
      const closed = state.stack.pop()
      if (closed?.capture) state.closed.add(closed.capture)
      if (closed?.behind) state.behind--
    }
    if ('*+?'.includes(c)) {
      if (state.behind) gap('variable-length lookbehind')
      if (pattern[i + 1] === '+') gap('possessive repetition')
      if (c !== '+') state.risky = true
    }
    if (c === '|') state.risky = true
    if (c === '{') {
      const part = repetition(pattern, i, state)
      out += part.source; i = part.end; continue
    }
    out += c === ']' || c === '}' ? '\\' + c : c
    i++
  }
  if (state.references && state.risky) gap('conditional backreference')
  return out
}

function group(pattern, at, state) {
  let behind = false, capture = null, source = '('
  if (pattern[at + 1] === '*') gap('control verb')
  if (pattern[at + 1] === '?') {
    const prefix = /^\(\?(?:[:=!]|<[=!]|<([A-Za-z_]\w*)>)/u.exec(pattern.slice(at))
    if (!prefix) gap('group')
    source = prefix[0]
    behind = source === '(?<=' || source === '(?<!'
    if (!prefix[1] && source !== '(?:') state.risky = true
    if (prefix[1]) {
      capture = ++state.captures
      if (state.names.has(prefix[1])) throw new Error('duplicate PCRE capture name')
      state.names.set(prefix[1], capture)
    }
  } else capture = ++state.captures
  if (behind) state.behind++
  state.stack.push({ capture, behind })
  return { source, end: at + source.length }
}

function repetition(pattern, at, state) {
  const match = /^\{(\d+)(?:,(\d*))?\}/u.exec(pattern.slice(at))
  if (!match) {
    if (/^\{[\d, \t]*\}/u.test(pattern.slice(at))) gap('repetition')
    return { source: '\\{', end: at + 1 }
  }
  if (state.behind && match[2] !== undefined && match[1] !== match[2]) gap('variable-length lookbehind')
  if (Number(match[1]) > 65535 || Number(match[2]) > 65535) throw new Error('PCRE repetition count exceeds 65535')
  if (Number(match[1]) === 0) state.risky = true
  if (pattern[at + match[0].length] === '+') gap('possessive repetition')
  return { source: match[0], end: at + match[0].length }
}

function characterClass(pattern, at, state) {
  let i = at + 1, source = '['
  if (pattern[i] === '^') { source += '^'; i++ }
  if (pattern[i] === ']') { source += '\\]'; i++ }
  while (i < pattern.length && pattern[i] !== ']') {
    if (pattern[i] === '[' && ':.='.includes(pattern[i + 1] ?? '')) gap('character class')
    if (pattern[i] === '\\') {
      const part = escape(pattern, i, state, true)
      source += part.source; i = part.end
    } else {
      source += pattern[i] === '[' ? '\\[' : pattern[i]
      i++
    }
  }
  return { source: source + (pattern[i] === ']' ? ']' : ''), end: i + 1 }
}

function escape(pattern, at, state, bracket) {
  const c = pattern[at + 1]
  if (c === undefined) throw new Error('trailing backslash')
  if (c === 'Q') {
    const end = pattern.indexOf('\\E', at + 2)
    return { source: RegExp.escape(pattern.slice(at + 2, end < 0 ? undefined : end)), end: end < 0 ? pattern.length : end + 2 }
  }
  if (c === 'E') return { source: '', end: at + 2 }
  if (c === 'x' || c === '0' || (bracket && /[1-7]/u.test(c))) return characterEscape(pattern, at)
  if (c === 'a' || c === 'e') return { source: c === 'a' ? '\\u0007' : '\\u001B', end: at + 2 }
  if ('AzZ'.includes(c) && !bracket) return { source: c === 'A' ? '^' : '$', end: at + 2 }
  if (/[1-9]/u.test(c) && !bracket) {
    if (/\d/u.test(pattern[at + 2] ?? '') || !state.closed.has(Number(c))) gap('forward or ambiguous backreference')
    state.references = true
    return { source: '\\' + c, end: at + 2 }
  }
  if (c === 'k' && !bracket) {
    const match = /^\\k<([A-Za-z_]\w*)>/u.exec(pattern.slice(at))
    if (!match || !state.closed.has(state.names.get(match[1]))) gap('named backreference')
    state.references = true
    return { source: match[0], end: at + match[0].length }
  }
  if ('dDsSwWfnrtbB'.includes(c)) return { source: '\\' + c, end: at + 2 }
  if (/[A-Za-z0-9]/u.test(c)) gap('escape \\' + c)
  const literal = String.fromCodePoint(pattern.codePointAt(at + 1))
  return { source: RegExp.escape(literal), end: at + 1 + literal.length }
}

function characterEscape(pattern, at) {
  const hex = pattern[at + 1] === 'x'
  const match = (hex ? /^\\x(?:\{([\da-fA-F]+)\}|([\da-fA-F]{1,2}))/u : /^\\([0-7]{1,3})/u).exec(pattern.slice(at))
  if (!match) throw new Error('invalid PCRE character escape')
  const radix = hex ? 16 : 8
  const code = parseInt(match[1] ?? match[2], radix)
  if (!isUnicodeScalar(code)) gap('character escape')
  return { source: `\\u{${code.toString(16)}}`, end: at + match[0].length }
}
