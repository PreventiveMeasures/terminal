// grep's -i, spelt into the pattern: a case-sensitive match of the result is
// GNU's case-insensitive match of the original, by the locale's tables (see
// fold and foldRange in ./locale.js). Every letter outside a bracket becomes
// a bracket of the characters it stands for; a bracket's members widen the
// same way, a range becomes the ranges it takes once upper-cased, and
// [:upper:] and [:lower:] read as [:alpha:]. The pattern is a BRE or ERE as
// written and already validated (validateRegex): outside a bracket a
// backslash starts an escape, and an escaped letter that is no operator is
// the letter itself; inside one there is none, only members, ranges,
// classes and collating symbols, and a range with a character past ASCII
// in it has been refused.

import { foldedClass } from './locale.js'
import { codePointSize } from './unicode.js'

const OPERATORS = 'bBsSwW'

export function foldPattern(pattern, tables) {
  let out = ''
  for (let i = 0; i < pattern.length;) {
    const c = pattern[i]
    if (c === '[') {
      const bracket = foldBracket(pattern, i, tables)
      out += bracket.text
      i = bracket.end
      continue
    }
    const escaped = c === '\\'
    const code = pattern.codePointAt(i + (escaped ? 1 : 0))
    const width = (escaped ? 1 : 0) + codePointSize(code)
    const set = escaped && OPERATORS.includes(pattern[i + 1]) ? null : tables.fold(code)
    out += set === null || set.length === 1 ? pattern.slice(i, i + width) : `[${String.fromCodePoint(...set)}]`
    i += width
  }
  return out
}

// A fixed string (-F), as the source of a JS regex.
export function foldFixed(text, tables) {
  let out = ''
  for (const ch of text) {
    const set = tables.fold(ch.codePointAt(0))
    out += set.length === 1 ? RegExp.escape(ch) : `[${String.fromCodePoint(...set)}]`
  }
  return out
}

// The bracket expression opening at `start`, widened, and where it ends.
// Members keep their places, so a leading `]` or `^` and a trailing `-`
// stay what they were; a letter's counterparts are letters, which are
// syntax nowhere in a bracket.
function foldBracket(pattern, start, tables) {
  let i = start + 1
  let text = '['
  if (pattern[i] === '^') { text += '^'; i++ }
  let first = true
  for (;;) {
    const c = pattern[i]
    if (c === ']' && !first) return { text: text + ']', end: i + 1 }
    first = false
    if (c === '[' && ':.='.includes(pattern[i + 1])) {
      const kind = pattern[i + 1]
      const close = pattern.indexOf(kind + ']', i + 2)
      text += kind === ':' ? `[:${foldedClass(pattern.slice(i + 2, close))}:]` : pattern.slice(i, close + 2)
      i = close + 2
      continue
    }
    const lo = pattern.codePointAt(i)
    const next = i + codePointSize(lo)
    if (pattern[next] === '-' && pattern[next + 1] !== undefined && pattern[next + 1] !== ']') {
      const hi = pattern.codePointAt(next + 1)
      const end = next + 1 + codePointSize(hi)
      text += foldRangeText(lo, hi, pattern.slice(i, end), tables)
      i = end
      continue
    }
    text += String.fromCodePoint(...tables.fold(lo))
    i = next
  }
}

// A range as written, unless folding changes what it takes.
function foldRangeText(lo, hi, written, tables) {
  const items = tables.foldRange(lo, hi)
  if (items === null) throw new Error('Invalid range end')
  if (items.length === 1 && items[0][0] === lo && items[0][1] === hi) return written
  return items.map(([from, to]) => (from === to ? String.fromCodePoint(from) : `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`)).join('')
}
