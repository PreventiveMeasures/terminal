import { readPosixClass } from './charclass.js'
import { UnsupportedError } from './unsupported.js'

// Translate POSIX BRE escapes to ECMAScript syntax for grep.

// Length of a GNU character escape, including its backslash; zero means the
// caller should interpret the next character literally or as regex syntax.
function escapeLength(pattern, i) {
  const next = pattern[i + 1]
  if (next === undefined) return -1
  // Preserve supported regex escapes and GNU BRE operators; discard the
  // backslash on ordinary characters instead of producing an invalid /u escape.
  if ('^$\\.*+?()[]{}|/bBdDsSwW'.includes(next)) return 2
  if (next >= '1' && next <= '9') return 2  // backreference
  const isHex = (c) => c !== undefined && /[0-9A-Fa-f]/u.test(c)
  const balanced = (open, close) => {
    if (pattern[i + 2] !== open) return 0
    const end = pattern.indexOf(close, i + 3)
    return end > i + 3 ? end - i + 1 : 0
  }
  if (next === 'x') return isHex(pattern[i + 2]) && isHex(pattern[i + 3]) ? 4 : 0
  if (next === 'u') {
    // `\u{H..H}` requires 1-6 hex digits AND code point ≤ 0x10FFFF;
    // `\uHHHH` requires exactly 4 hex digits. Invalid forms fall
    // back to the BRE identity-escape branch (drop the backslash).
    if (pattern[i + 2] === '{') {
      const len = balanced('{', '}')
      const body = len ? pattern.slice(i + 3, i + len - 1) : ''
      const valid = body.length >= 1 && body.length <= 6 && [...body].every(isHex) && parseInt(body, 16) <= 0x10FFFF
      return valid ? len : 0
    }
    return [2, 3, 4, 5].every((k) => isHex(pattern[i + k])) ? 6 : 0
  }
  if (next === 'p' || next === 'P') return balanced('{', '}')
  if (next === 'c') return /[A-Za-z]/u.test(pattern[i + 2] ?? '') ? 3 : 0
  if (next === 'k') return balanced('<', '>')
  return 0
}

// BRE uses escaped grouping, alternation, and interval operators. Unescaped
// (){}+?| are literals. Preserve whether an atom is repeatable so a leading
// '*' stays literal, including immediately after a group opening or anchor.
export function breToEs(pattern) {
  const SWAP = '(){}+?|'
  let out = ''
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (inClass) {
      if (c === '[' && (pattern[i + 1] === '.' || pattern[i + 1] === '=')) throw new UnsupportedError('feature', 'regex collating or equivalence class', 'grep: collating and equivalence classes are not supported')
      if (c === '[') {
        const cls = readPosixClass(pattern, i)
        if (cls) { out += cls.body; i = cls.end - 1; continue }
      }
      // Inside brackets, ordinary identity escapes lose their backslash too.
      if (c === '\\') {
        const len = escapeLength(pattern, i)
        if (len === -1) return { error: 'trailing backslash (\\)' }
        if (len > 0) { out += pattern.slice(i, i + len); i += len - 1; continue }
        out += pattern[i + 1]; i++; continue
      }
      out += c
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') {
      // POSIX: `]` immediately after `[` (or `[^`) is literal, not
      // class-close. ES /u rejects `[]…]` / `[^]…]`; escape the
      // leading `]` so the same chars land in the class.
      out += c; inClass = true
      // Skip past a leading `^` (negation) so the next iteration
      // doesn't reprocess it as a class member — `[^a]` was
      // being mis-emitted as `[^^a]`.
      if (pattern[i + 1] === '^') { out += '^'; i++ }
      // POSIX: `]` immediately after `[` (or `[^`) is literal. ES
      // /u rejects `[]…]` / `[^]…]`; escape it so the same chars
      // land in the class and the tracker doesn't exit early.
      if (pattern[i + 1] === ']') { out += '\\]'; i++ }
      continue
    }
    if (c === '\\') {
      if (i + 1 >= pattern.length) return { error: 'trailing backslash (\\)' }
      const next = pattern[i + 1]
      // BRE-specific transforms first — these aren't ES syntax,
      // so escapeLength would return 0 for them.
      if (SWAP.includes(next)) { out += next; i++; continue }
      if (next === '<' || next === '>' || next === '`' || next === "'") { out += '\\' + next; i++; continue }
      // Validated ES escape (including multi-char `\xHH`, `\p{...}`).
      const len = escapeLength(pattern, i)
      if (len > 0) { out += pattern.slice(i, i + len); i += len - 1; continue }
      // POSIX BRE: backslash before non-special char is literal.
      out += next; i++; continue
    }
    // A leading '*' (also after ^ or a group opening) is a literal atom.
    if (c === '*' && (i === 0 || (pattern[i - 1] === '^' && caretIsAnchor(pattern, i - 1)))) { out += '\\*'; continue }
    if (c === '^' && !caretIsAnchor(pattern, i)) { out += '\\^'; continue }
    if (c === '$' && !(i === pattern.length - 1 || (pattern[i + 1] === '\\' && (pattern[i + 2] === ')' || pattern[i + 2] === '|')))) { out += '\\$'; continue }
    if (SWAP.includes(c)) { out += '\\' + c; continue }
    out += c
  }
  return { source: out }
}

// POSIX BRE: `^` is an anchor at pos 0 or immediately after `\(` /
// `\|` (GNU group / alternation extension). Elsewhere it's literal.
function caretIsAnchor(pattern, i) {
  if (i === 0) return true
  return i >= 2 && pattern[i - 2] === '\\' && (pattern[i - 1] === '(' || pattern[i - 1] === '|')
}
