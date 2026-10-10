// What GNU grep says of a -G or -E pattern before it reads a line. It asks
// twice. glibc's regcomp is given each pattern line on its own, and every line
// it rejects is named in turn before grep gives up (../regcomp.js); only
// when all of them pass does the dfa matcher parse them together, which warns
// of a repetition with nothing before it and rejects `[:space:]` spelt
// without its outer bracket. Both are followed as they are written
// (regcomp.c and dfa.c), as far as they decide what is said and whether the
// search goes on: neither builds a matcher here, which is the translators'
// work once a pattern has passed — and what they read differently from one
// another, the translators answer for as well (ereLiterals, below). And how
// POSIX stacks repetitions, which ECMAScript does not (posixQuantifiers).
import { UnsupportedError } from '../unsupported.js'
import { MAX_INTERVAL, validateBracket } from '../charclass.js'
import { RE_ICASE, RE_SYNTAX_EGREP, RE_SYNTAX_GREP, regcomp } from '../regcomp.js'
import { dfaDiagnostics } from './grep-dfa.js'

// Everything GNU says of the patterns before it reads a line: `error` is the
// whole of what a run that stops there writes, and `warnings` what one that
// goes on writes first. `origins` names where each pattern came from, which
// glibc's complaint about it carries in front (grepPatterns). `multibyte` and
// `up` are the locale's, as regcomp reads a pattern by them: whether a
// character can take more than one byte, and towupper, for -i.
export function gnuDiagnostics(patterns, origins, { extended, icase = false, lines = false, words = false, multibyte = true, up }) {
  const syntax = (extended ? RE_SYNTAX_EGREP : RE_SYNTAX_GREP) | (icase ? RE_ICASE : 0)
  const errors = patterns.flatMap((pattern, k) => {
    const { error } = regcomp(pattern, syntax, { multibyte, up })
    return error ? [`grep: ${origins[k] ?? ''}${error}\n`] : []
  })
  if (errors.length) return { error: errors.join('') }
  const said = dfaDiagnostics(patterns, { extended, lines, words })
  return said.error ? { error: said.warnings.join('') + said.error } : { error: null, warnings: said.warnings.join('') }
}

// Two or more patterns that all read as fixed strings are searched as those
// (grep.c's try_fgrep_pattern): a backslash before anything that is not an
// operator is dropped, and one ending the last pattern is a character. Null
// where any of them is more than that. With -i, only where every character
// and its other cases are one byte each, or past ASCII has none — `tables`
// says which.
export function fixedStrings(patterns, extended, tables) {
  const keys = patterns.join('\n')
  let out = ''
  for (let i = 0; i < keys.length; i++) {
    let c = keys[i]
    if ('$*.[^'.includes(c) || (extended && '(+?{|'.includes(c))) return null
    if (c === '\\' && i + 1 < keys.length) {
      const next = keys[++i]
      if ('\nBSW\'<bsw`>123456789'.includes(next) || (!extended && '(+?{|)'.includes(next))) return null
      c = next
    }
    const code = c === '\n' ? 0 : keys.codePointAt(i)
    if (code > 0xffff) { c = keys.slice(i, i + 2); i++ }
    if (tables && code !== 0 && !foldsSimply(code, tables)) return null
    out += c
  }
  return out.split('\n')
}

const foldsSimply = (code, tables) => (code < 0x80 ? tables.fold(code).every((other) => other < 0x80) : tables.fold(code).length === 1)

// What a GNU ERE reads as a character where ECMAScript would read syntax or
// reject it: a `)` closing no group, a `{` beginning no interval, and a `}`
// or `]` standing alone — each spelt here with the backslash GNU reads the
// same way. And a `*`, `+` or `?` where an expression begins, which repeats
// nothing — glibc passes over it and the dfa repeats the empty string — and
// is dropped. Where an expression begins is the dfa's `laststart`: after
// `(`, `|` and the start, with anchors there leaving it so. An interval
// there, or a repetition right after such an anchor, is left as it is: glibc
// reads `{1}a` as `1}a` and `^*a` as `^a`, the dfa as `a` and `a`, and the JS
// matcher rejects both, which is refused. A word anchor sends the pattern to
// glibc, as the dfa cannot match one in a multibyte locale — but only for the
// lines the dfa's own reading, the anchor taken for nothing, also selects.
// Both drop a `*`, `+` or `?` after one, wherever it stands; an interval
// there glibc reads as text from its `{` on, which the dfa does not, and that
// is refused. So is a `)` closing no group under -x or -w (`wrapped`), which
// the dfa reads inside the parentheses GNU wraps the pattern in, where it
// closes one.
export function ereLiterals(pattern, wrapped) {
  let out = ''
  let depth = 0
  const at = { anchored: false, laststart: true, word: false }
  const atom = () => Object.assign(at, { anchored: false, laststart: false, word: false })
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '[') {
      const end = validateBracket(pattern, i)
      out += pattern.slice(i, end + 1)
      i = end
      atom()
      continue
    }
    if (c === '\\') {
      const next = pattern[++i] ?? ''
      out += c + next
      if ('<>bB'.includes(next)) at.word = true
      else if ('`\''.includes(next)) at.anchored = true
      else atom()
      continue
    }
    if ('*+?'.includes(c) && (at.word || (at.laststart && !at.anchored))) continue
    if (c === '{' && at.word) throw new UnsupportedError('feature', 'regex repetition after an anchor', 'grep: an interval directly after a word anchor is read differently by GNU\'s two matchers, and is not supported')
    const bounds = c === '{' ? ERE_INTERVAL.exec(pattern.slice(i)) : null
    if (bounds) {
      out += bounds[0]
      i += bounds[0].length - 1
      atom()
      continue
    }
    if (c === ')' && depth === 0 && wrapped) throw new UnsupportedError('feature', 'regex unmatched parenthesis', 'grep: a `)` closing no group, with -x or -w, is not supported')
    if ((c === ')' && depth === 0) || (c === '{' && !at.laststart) || c === '}' || c === ']') {
      out += '\\' + c
      atom()
      continue
    }
    depth += c === '(' ? 1 : c === ')' ? -1 : 0
    if (c === '^' || c === '$') at.anchored = true
    else if (c === '(' || c === '|') Object.assign(at, { anchored: false, laststart: true, word: false })
    else if (!'*+?'.includes(c)) atom()
    out += c
  }
  return out
}

export const ERE_INTERVAL = /^\{(?=\d|,)(\d*)(?:,(\d*))?\}/u

// With -i glibc compares a backslashed letter as it was written against text
// it has upper-cased, so `\a` there matches no `a` at all, where the dfa
// reads it as `a` — and which of the two answers depends on the rest of the
// pattern. A backslash before a letter that upper-casing changes, other than
// GNU's own `\w`, `\s` and `\b`, is so read, and is refused with -i.
export function caselessEscape(pattern) {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '[') i = validateBracket(pattern, i)
    else if (pattern[i] === '\\') {
      const next = String.fromCodePoint(pattern.codePointAt(++i) ?? 0x5c)
      if (!'wsb'.includes(next) && next !== next.toUpperCase()) return true
    }
  }
  return false
}

// POSIX stacks quantifiers: `a+?` is `(a+)?`, which matches the empty
// string, and `a+*` is `(a+)*`. ECMAScript reads `+?` as a lazy `+` and
// rejects `+*` outright, so the pair has to be rewritten for the JS
// matcher. Wrapping it as `(?:a+)*` would be correct and catastrophic —
// nested unbounded repetition backtracks exponentially on input that
// fails to match — so the pair is folded into one quantifier instead.
const QUANTS = { __proto__: null, '*': { min: 0, max: Infinity }, '+': { min: 1, max: Infinity }, '?': { min: 0, max: 1 } }

function quantBounds(text) {
  if (QUANTS[text]) return QUANTS[text]
  const m = ERE_INTERVAL.exec(text)
  const min = Number(m[1])
  return { min, max: m[2] === undefined ? min : m[2] === '' ? Infinity : Number(m[2]) }
}

const times = (a, b) => (a === 0 || b === 0 ? 0 : a === Infinity || b === Infinity ? Infinity : a * b)

// `(X{m1,n1}){m2,n2}` matches k copies of X for every k that is a sum of
// between m2 and n2 numbers drawn from [m1,n1]. When those k form one
// unbroken range the pair is a single quantifier — `a+*` is just `a*` —
// and the nesting disappears with them. Returns null when the reachable
// counts have a hole, as `(a{2,}){0,1}` does between 0 and 2.
function collapse(inner, outer) {
  const first = Math.max(outer.min, 1)
  if (first > outer.max) return { min: 0, max: 0 }
  if (inner.min > 0) {
    if (outer.min === 0 && inner.min > 1) return null
    if (inner.max !== Infinity && outer.max > first && (first + 1) * inner.min > first * inner.max + 1) return null
  }
  const max = times(outer.max, inner.max)
  return max !== Infinity && max > MAX_INTERVAL ? null : { min: times(outer.min, inner.min), max }
}

function quantText(b) {
  if (b.max === Infinity) return b.min === 0 ? '*' : b.min === 1 ? '+' : `{${b.min},}`
  if (b.min === 0 && b.max === 1) return '?'
  return b.min === b.max ? `{${b.min}}` : `{${b.min},${b.max}}`
}

// A repetition consumes a fixed width only when the atom does: a single
// character, escape or bracket expression matches exactly one. A group
// can match several lengths — `(a|aa){3}` covers 3 to 6 characters — and
// repeating that under an unbounded count is the ambiguity the fold
// exists to avoid, so groups and backreferences do not qualify.
const fixedWidth = (atom) => !atom.startsWith('(') && !/^\\[1-9]/u.test(atom)

// Fold a chain of quantifiers applied to one atom. A pair that will not
// collapse may still nest safely when every repetition consumes a fixed
// width, or when the outer one repeats at most once; anything else would
// reintroduce the ambiguity, so it is refused and reported as a GNU form
// the JavaScript matcher cannot represent.
function stackQuantifiers(atom, chain) {
  if (chain.length === 1) return atom + quantText(chain[0].bounds)
  let bounds = chain[0].bounds
  let nested = null
  for (let i = 1; i < chain.length; i++) {
    const { bounds: outer, text } = chain[i]
    const merged = nested === null ? collapse(bounds, outer) : null
    if (merged) { bounds = merged; continue }
    const fixed = nested === null && bounds.min === bounds.max && fixedWidth(atom)
    if (!fixed && outer.max > 1) throw new Error('stacked quantifier needs ambiguous nesting')
    nested = `(?:${nested ?? atom + quantText(bounds)})${text}`
  }
  return nested ?? atom + quantText(bounds)
}

// End of the bracket expression opening at `start`, honouring the escapes
// the translators emit inside a class.
export function classEnd(source, start) {
  let i = start + 1
  if (source[i] === '^') i++
  for (; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue }
    if (source[i] === ']') return i
  }
  return source.length - 1
}

// Rewrite each atom together with every quantifier stacked on it. Groups
// carry their whole text as the atom, so `(ab)+?` becomes `(ab)*`.
export function posixQuantifiers(source) {
  let out = ''
  let unitStart = -1   // where the bare atom starts in `out`, -1 if none
  let unitEnd = -1     // where its first quantifier began
  let chain = []
  const flush = () => {
    if (chain.length > 0) out = out.slice(0, unitStart) + stackQuantifiers(out.slice(unitStart, unitEnd), chain)
    chain = []
  }
  const atom = (text) => { flush(); unitStart = out.length; unitEnd = -1; out += text }
  const groups = []
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '\\') { atom(c + (source[++i] ?? '')); continue }
    if (c === '[') {
      const end = classEnd(source, i)
      atom(source.slice(i, end + 1))
      i = end
      continue
    }
    if (c === '(') { flush(); groups.push(out.length); unitStart = -1; out += c; continue }
    if (c === ')') { flush(); out += c; unitStart = groups.pop() ?? -1; unitEnd = -1; continue }
    // Nothing quantifiable precedes an alternation branch or an anchor.
    if (c === '|' || c === '^' || c === '$') { flush(); out += c; unitStart = -1; continue }
    const interval = c === '{' ? ERE_INTERVAL.exec(source.slice(i)) : null
    if (c === '*' || c === '+' || c === '?' || interval) {
      const text = interval ? interval[0] : c
      i += text.length - 1
      if (unitStart < 0) { out += text; continue }   // nothing to quantify; JS reports it
      if (chain.length === 0) unitEnd = out.length
      chain.push({ bounds: quantBounds(text), text })
      continue
    }
    atom(c)
  }
  flush()
  return out
}
