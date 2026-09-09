import { MAX_INTERVAL, checkInterval, readPosixClass, validateBracket } from '../charclass.js'
import { UnsupportedError, unsupported } from '../unsupported.js'
import { err } from '../util.js'
import { AwkRegex } from '../awk/regex.js'
import { parseEre } from '../awk/re-parse.js'
import { breToEs } from '../bre.js'
import { asciiCompatible, hasUnicodeSpace } from '../regex-locale.js'
import { pcreSource } from './grep-pcre.js'

// POSIX named classes are shared with the glob translator. Collating
// and equivalence expressions need locale semantics that we do not model.
export function ereClasses(pattern) {
  let out = ''
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') {
      const next = pattern[++i] ?? ''
      out += inClass ? c + next : gnuEscape(next)
      continue
    }
    if (inClass && c === '[') {
      if (pattern[i + 1] === '.' || pattern[i + 1] === '=') throw new UnsupportedError('feature', 'regex collating or equivalence class', 'grep: collating and equivalence classes are not supported')
      const cls = readPosixClass(pattern, i)
      if (cls) { out += cls.body; i = cls.end - 1; continue }
    }
    if (c === '[' && !inClass) {
      out += '['; inClass = true
      if (pattern[i + 1] === '^') { out += '^'; i++ }
      if (pattern[i + 1] === ']') { out += '\\]'; i++ }
      continue
    }
    if (c === ']') inClass = false
    out += c
  }
  return out
}

// GNU grep does not give \t, \n, etc. the control-character meaning
// they have in JavaScript and AWK. They match the literal letter.
function gnuEscape(next) {
  return '^$\\.*+?()[]{}|/bBsSwW<>`\'123456789'.includes(next) ? '\\' + next : RegExp.escape(next)
}

// Literal Unicode text and anchors have the same meaning in byte and
// character locales. Character classes, repetition and dot do not.
export function localeSensitive(source) {
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\') {
      if ('bBsSwW<>'.includes(source[++i] ?? '')) return true
    } else if ('.[*+?{'.includes(source[i])) return true
  }
  return false
}

// The canonical pattern retains GNU assertions. Render them separately
// for the boolean JS matcher and the AWK extent matcher. Walk escapes
// instead of replaceAll so a literal `\\b` remains a backslash and b.
export function grepSource(source, extent = false) {
  const assertions = extent ? { b: '\\y' } : {
    '<': '(?<!\\w)(?=\\w)', '>': '(?<=\\w)(?!\\w)',
    '`': '^', "'": '$', s: '[ \\t\\n\\r\\f\\v]', S: '[^ \\t\\n\\r\\f\\v]',
  }
  let out = ''
  let bracket = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '\\') {
      const next = source[++i]
      out += !bracket && Object.hasOwn(assertions, next) ? assertions[next] : c + next
    } else {
      if (c === '[') bracket = true
      if (c === ']') bracket = false
      out += c
    }
  }
  return out
}

const ERE_INTERVAL = /^\{(\d+)(?:,(\d*))?\}/u
const BRE_INTERVAL = /^\\\{(\d+)(?:,(\d*))?\\\}/u

// GNU rejects an interval bound above RE_DUP_MAX outright. ECMAScript
// accepts any bound, so the limit is ours to enforce.
function intervalBounds(pattern, i, extended) {
  const m = (extended ? ERE_INTERVAL : BRE_INTERVAL).exec(pattern.slice(i))
  if (m) checkInterval(Number(m[1]), m[2] === undefined || m[2] === '' ? undefined : Number(m[2]))
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

// Fold a chain of quantifiers applied to one atom. A pair that will not
// collapse may still nest safely when every repetition consumes a fixed
// length, or when the outer one repeats at most once; anything else would
// reintroduce the ambiguity, so it is refused and reported as a GNU form
// the JavaScript matcher cannot represent.
function stackQuantifiers(atom, chain) {
  if (chain.length === 1) return atom + chain[0].text
  let bounds = chain[0].bounds
  let nested = null
  for (let i = 1; i < chain.length; i++) {
    const { bounds: outer, text } = chain[i]
    const merged = nested === null ? collapse(bounds, outer) : null
    if (merged) { bounds = merged; continue }
    const fixed = nested === null && bounds.min === bounds.max
    if (!fixed && outer.max > 1) throw new Error('stacked quantifier needs ambiguous nesting')
    nested = `(?:${nested ?? atom + quantText(bounds)})${text}`
  }
  return nested ?? atom + quantText(bounds)
}

// End of the bracket expression opening at `start`, honouring the escapes
// the translators emit inside a class.
function classEnd(source, start) {
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

// These constructs have different meanings in ECMAScript and GNU grep.
// Refuse them rather than letting the JS engine silently pick a dialect.
// Bracket expressions and interval bounds are checked here, on the
// pattern as written, so BRE and ERE get the same diagnostics.
export function validateRegex(pattern, extended) {
  // Membership is by position, not by the next `]`: a class ends where
  // validateBracket says it does, so the `]` closing `[:alpha:]` inside it
  // — or a literal `]` in first position — does not end it early. Members
  // shaped like intervals or groups are then read as the characters they
  // are, so `[[:alpha:]{40000}]` and `[(?]` stay the classes GNU sees.
  let bracketEnd = -1
  for (let i = 0; i < pattern.length; i++) {
    const bracket = i <= bracketEnd
    const c = pattern[i]
    if (c === '\\') {
      const next = pattern[++i]
      if (next === undefined) throw new Error('trailing backslash')
      if (bracket || (next && 'dDxXuUpPkKcC'.includes(next))) throw new UnsupportedError('feature', 'regex escape', 'grep: this regex escape is not supported with GNU semantics')
      if (!extended && next === '{') intervalBounds(pattern, i - 1, false)
    } else if (c === '[' && !bracket) bracketEnd = validateBracket(pattern, i)
    else if (bracket) continue
    else if (extended && c === '{') intervalBounds(pattern, i, true)
    else if (extended && c === '(' && pattern[i + 1] === '?') throw new UnsupportedError('feature', 'regex extension', 'grep: ECMAScript group extensions are not supported in ERE')
  }
}

export function compilePatterns(patterns, flags) {
  // Compile -e patterns separately: combining them would shift backreference
  // numbers across patterns. A line matches if any pattern selects it.
  const res = []
  const reFlags = flags.has('i') ? 'isu' : 'su'
  const whole = flags.has('x'), word = flags.has('w') && !whole
  if (flags.has('P') && patterns.length !== 1) return { error: err('grep: -P only supports a single pattern', 2) }
  for (const pattern of patterns) {
    if (!flags.has('F') && !flags.has('P')) validateRegex(pattern, flags.has('E'))
    let source
    if (flags.has('F')) source = RegExp.escape(pattern)
    else if (flags.has('P')) source = pcreSource(pattern)
    else if (flags.has('E')) source = ereClasses(pattern)
    else {
      const r = breToEs(pattern)
      if (r.error) return { error: err(`grep: ${r.error}`, 2) }
      source = r.source
    }
    const canonical = source
    if (word) source = `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])`
    if (whole) source = `^(?:${source})$`
    try {
      // The boolean matcher needs POSIX quantifier stacking spelled out
      // for ECMAScript; the extent matcher below parses ERE itself and
      // already reads those the way GNU does, so it takes `source` as is.
      // `-P` selects the ECMAScript reading, where `a+?` really is lazy,
      // so the rewrite is ERE's alone.
      const re = new RegExp(flags.has('F') || flags.has('P') ? source : grepSource(flags.has('E') ? posixQuantifiers(source) : source), reFlags)
      re.pcre = flags.has('P')
      re.localeSensitive = flags.has('i') || word || (!flags.has('F') && localeSensitive(canonical)) || (re.pcre && /\\[dD]/u.test(canonical))
      // The ASCII proof understands POSIX patterns, not PCRE escapes/classes.
      re.asciiCompatible = !re.pcre && re.localeSensitive && !flags.has('i') && !word && asciiCompatible(grepSource(canonical, true), pattern)
      re.spaceClass = /\[:(?:space|blank):\]|\\[sS]/u.test(pattern)
      re.unicodePattern = /[\u0080-\u{10FFFF}]/u.test(pattern)
      re.binaryLiteral = !whole && (flags.has('F') || !/[\\.^$*+?()[\]{}|]/u.test(source))
      if (flags.has('o') && !flags.has('F') && !flags.has('P') && !whole) {
        if (word || /\\[1-9]|\(\?/u.test(source)) return { error: unsupported('feature', 'grep', '-o regex extent', 'grep: only-matching with backreferences, lookarounds or word constraints is not supported', 2) }
        try { re.extent = new AwkRegex(grepSource(source, true), flags.has('i')) } catch {
          return { error: unsupported('feature', 'grep', '-o regex extent', 'grep: POSIX match extent for this pattern is not supported', 2) }
        }
      }
      res.push(re)
    } catch (e) {
      if (!flags.has('P') && gnuSyntaxGap(canonical, flags)) return { error: unsupported('feature', 'grep', 'GNU regex syntax', 'grep: this GNU regular expression cannot be represented by the JavaScript matcher', 2) }
      // Pattern errors use exit 2; retain the selected dialect in the error message.
      const dialect = flags.has('F') ? `fixed-string /${reFlags}`
        : flags.has('P') ? `PCRE subset /${reFlags}`
        : flags.has('E') ? `ERE / ECMAScript /${reFlags}`
        : `BRE /${reFlags}`
      return { error: err(`grep: invalid pattern (${dialect}): ${e.message}`, 2) }
    }
  }
  return { res }
}

// JS rejects several valid GNU forms: omitted interval minima, stacked
// quantifiers and literal unmatched braces/closing brackets. Do not label
// those failures as mistakes in the user's regex. Invalid references and
// malformed BRE intervals remain ordinary errors.
function gnuSyntaxGap(source, flags) {
  if (/\\[1-9]/u.test(source)) return false
  if (!flags.has('E') && /(?<!\\)\{(?!\d*(?:,\d*)?\})/u.test(source)) return false
  try { parseEre(grepSource(source, true)); return true } catch (e) { return Boolean(e.gap) }
}

export function inputGap(inputs, res, invert) {
  if (inputs.length === 0) return null
  // A literal absent from a binary file is still safely a non-match.
  // Regex anchors and classes can see NUL boundaries differently in GNU.
  if (inputs.some((inp) => inp.content.includes('\0') && (invert || res.some((re) => !re.binaryLiteral || re.test(inp.content))))) return unsupported('feature', 'grep', 'binary input', 'grep: binary input detection and output are not supported', 2)
  const localePatterns = res.filter((re) => re.localeSensitive && (!re.asciiCompatible || re.spaceClass))
  if (localePatterns.length === 0) return null
  const unicode = localePatterns.some((re) => !re.unicodePattern) && inputs.some((inp) => /[\u0080-\u{10FFFF}]/u.test(inp.content))
  const unicodeSpace = localePatterns.some((re) => re.asciiCompatible && re.spaceClass) && inputs.some((inp) => hasUnicodeSpace(inp.content))
  if (localePatterns.some((re) => (unicode || re.unicodePattern) && (!re.asciiCompatible || (re.spaceClass && unicodeSpace)))) return unsupported('feature', 'grep', 'non-ASCII regex semantics', 'grep: locale-sensitive regular expression matching on non-ASCII input is not supported', 2)
  return null
}
