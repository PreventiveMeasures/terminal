import { UnsupportedError, unsupported, unsupportedNote } from '../unsupported.js'
import { isUnicodeScalar } from '../unicode.js'
import { err } from '../result.js'

function gap(detail) {
  throw new UnsupportedError('feature', 'PCRE ' + detail, `PCRE ${detail} is not supported`)
}

// A pattern PCRE2 rejects, in PCRE2's words, and where in the pattern it
// does: PCRE2 reads a pattern from the left and names the first fault it
// meets, so one found here is only its answer if nothing before `at` is one.
export class PcreError extends Error {
  constructor(message, at) {
    super(message)
    this.at = at
  }
}

// What GNU grep says of a -P pattern PCRE2 rejects, or null where it takes
// it or this cannot tell. -w wraps the pattern before PCRE2 reads it, so the
// pattern it judges is the wrapped one.
//
// The translation names the faults it finds itself in PCRE2's words, the JS
// matcher the structural ones, which read the same in both and are named in
// PCRE2's words here. A fault the translation finds is PCRE2's answer only
// if what comes before it has none — an unclosed group or class there is
// only where it was cut. Any other answer is refused rather than given in
// words that are not PCRE2's.
export function pcreRejection(pattern, word) {
  const text = word ? `(?<!\\w)(?:${pattern})(?!\\w)` : pattern
  try { compiles(text) } catch (e) {
    if (unsupportedNote(e)) return null
    const said = pcreFault(e, text)
    if (said) return err(`grep: ${said}`, 2)
    return unsupported('feature', 'grep', 'PCRE syntax error', `grep: this PCRE pattern error is not reproduced: ${e.message}`, 2)
  }
  return null
}

const compiles = (pattern) => new RegExp(pcreSource(pattern), 'su')

const JS_ERRORS = [
  [/: Unterminated group$/u, 'missing closing parenthesis'],
  [/: Nothing to repeat$/u, 'quantifier does not follow a repeatable item'],
  [/: Unterminated character class$/u, 'missing terminating ] for character class'],
  [/: Range out of order in character class$/u, 'range out of order in character class'],
  [/: Invalid character class$/u, 'invalid range in character class'],
]

function pcreFault(e, pattern) {
  if (!(e instanceof PcreError)) return JS_ERRORS.find(([test]) => test.test(e.message))?.[1] ?? null
  const before = pattern.slice(0, e.at)
  try { compiles(before) } catch (earlier) {
    if (unsupportedNote(earlier)) return null
    if (!(earlier instanceof PcreError) && /: Unterminated (?:group|character class)$/u.test(earlier.message)) return e.message
    return pcreFault(earlier, before)
  }
  return e.message
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
      if (state.stack.length === 0) throw new PcreError('unmatched closing parenthesis', i)
      const closed = state.stack.pop()
      if (closed.capture) state.closed.add(closed.capture)
      if (closed.behind) state.behind--
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
      if (state.names.has(prefix[1])) throw new PcreError('two named subpatterns have the same name (PCRE2_DUPNAMES not set)', at)
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
  if (Number(match[1]) > 65535 || Number(match[2]) > 65535) throw new PcreError('number too big in {} quantifier', at)
  if (match[2] && Number(match[2]) < Number(match[1])) throw new PcreError('numbers out of order in {} quantifier', at)
  if (state.behind && match[2] !== undefined && match[1] !== match[2]) gap('variable-length lookbehind')
  if (Number(match[1]) === 0) state.risky = true
  if (pattern[at + match[0].length] === '+') gap('possessive repetition')
  return { source: match[0], end: at + match[0].length }
}

function characterClass(pattern, at, state) {
  // `[:alpha:]` and the like belong inside a class, and PCRE2 rejects one
  // standing where a class would begin, as Perl does.
  if (':.='.includes(pattern[at + 1] ?? '') && posixSyntax(pattern, at + 1)) {
    throw new PcreError(pattern[at + 1] === ':' ? 'POSIX named classes are supported only within a class' : 'POSIX collating elements are not supported', at)
  }
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

// PCRE2's check_posix_syntax: whether `[:`, `[.` or `[=` at `at` - 1 closes
// as such a name before anything ends the class it would be in.
function posixSyntax(pattern, at) {
  const terminator = pattern[at]
  for (let p = at + 1; pattern.length - p >= 2; p++) {
    if (pattern[p] === '\\' && (pattern[p + 1] === ']' || pattern[p + 1] === '\\')) p++
    else if ((pattern[p] === '[' && pattern[p + 1] === terminator) || pattern[p] === ']') return false
    else if (pattern[p] === terminator && pattern[p + 1] === ']') return true
  }
  return false
}

function escape(pattern, at, state, bracket) {
  const c = pattern[at + 1]
  if (c === undefined) throw new PcreError('\\ at end of pattern', at)
  if (c === 'Q') {
    const end = pattern.indexOf('\\E', at + 2)
    return { source: RegExp.escape(pattern.slice(at + 2, end < 0 ? undefined : end)), end: end < 0 ? pattern.length : end + 2 }
  }
  if (c === 'E') return { source: '', end: at + 2 }
  if (c === 'x') return hexEscape(pattern, at)
  if (c === '0' || (bracket && /[1-7]/u.test(c))) return octalEscape(pattern, at)
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

// PCRE2's \x, in UTF mode: up to two hex digits, none at all being NUL, or
// any number of them braced, naming a Unicode scalar value.
function hexEscape(pattern, at) {
  const character = (code, end) => ({ source: `\\u{${code.toString(16)}}`, end })
  if (pattern[at + 2] !== '{') {
    const digits = /^[\da-fA-F]{0,2}/u.exec(pattern.slice(at + 2))[0]
    return character(digits ? parseInt(digits, 16) : 0, at + 2 + digits.length)
  }
  let p = at + 3
  if (p >= pattern.length || pattern[p] === '}') throw new PcreError('digits missing in \\x{} or \\o{} or \\N{U+}', at)
  let code = 0
  for (; p < pattern.length && /[\da-fA-F]/u.test(pattern[p]); p++) {
    code = code * 16 + parseInt(pattern[p], 16)
    if (code > 0x10ffff) throw new PcreError('character code point value in \\x{} or \\o{} is too large', at)
  }
  if (pattern[p] !== '}') throw new PcreError('non-hex character in \\x{} (closing brace missing?)', at)
  if (code >= 0xd800 && code <= 0xdfff) throw new PcreError('disallowed Unicode code point (>= 0xd800 && <= 0xdfff)', at)
  return character(code, p + 1)
}

function octalEscape(pattern, at) {
  const match = /^\\([0-7]{1,3})/u.exec(pattern.slice(at))
  const code = parseInt(match[1], 8)
  if (!isUnicodeScalar(code)) gap('character escape')
  return { source: `\\u{${code.toString(16)}}`, end: at + match[0].length }
}
