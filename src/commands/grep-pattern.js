import { MAX_INTERVAL, checkInterval, readPosixClass, validateBracket } from '../charclass.js'
import { UnsupportedError, unsupported } from '../unsupported.js'
import { encodeUtf8, err } from '../util.js'
import { AwkRegex } from '../awk/regex.js'
import { parseEre } from '../awk/re-parse.js'
import { breToEs, validateBackreferences } from '../bre.js'
import { EXTENDED_C, LOCALE, classTables } from '../locale.js'
import { foldFixed, foldPattern } from '../regex-fold.js'
import { pcreSource } from './grep-pcre.js'

// POSIX named classes come from the locale's table. Collating and
// equivalence expressions need collation semantics that we do not model.
export function ereClasses(pattern, tables) {
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
      const cls = readPosixClass(pattern, i, { classes: tables })
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

// What PCRE reads by its own Unicode tables rather than the locale's: its
// word and space escapes, boundaries, and everything a dot, a bracket or a
// repetition spans. None of that is modelled past ASCII, so a `-P` pattern
// carrying any of it is refused over non-ASCII input.
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
// The JS matcher gets the locale's word and space sets spelt out, since
// its own `\\b` and `\\w` know ASCII only; the extent matcher reads the
// escapes itself, from the same tables.
export function grepSource(source, extent = false, tables = classTables(LOCALE)) {
  const js = tables.assertions()
  const assertions = extent ? { b: '\\y' } : {
    '<': js['<'], '>': js['>'], b: js.boundary, B: js.inside,
    w: js.word, W: js.nonWord, s: js.space, S: js.nonSpace, '`': '^', "'": '$',
  }
  let out = ''
  let bracket = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '\\') {
      const next = source[++i]
      out += !bracket && Object.hasOwn(assertions, next) ? assertions[next] : c + next
      if (!extent && !bracket && /[1-9]/u.test(next) && /\d/u.test(source[i + 1] ?? '')) out += '(?:)'
    } else {
      if (c === '[') bracket = true
      if (c === ']') bracket = false
      out += c
    }
  }
  return out
}

const ERE_INTERVAL = /^\{(?=\d|,)(\d*)(?:,(\d*))?\}/u
const BRE_INTERVAL = /^\\\{(?=\d|,)(\d*)(?:,(\d*))?\\\}/u

// GNU rejects an interval bound above RE_DUP_MAX outright. ECMAScript
// accepts any bound, so the limit is ours to enforce.
function intervalBounds(pattern, i, extended) {
  const m = (extended ? ERE_INTERVAL : BRE_INTERVAL).exec(pattern.slice(i))
  if (!m && !extended) throw new Error('invalid repetition count')
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
export function validateRegex(pattern, extended, multibyte = false) {
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
    } else if (c === '[' && !bracket) bracketEnd = validateBracket(pattern, i, multibyte)
    else if (bracket) continue
    else if (extended && c === '{') intervalBounds(pattern, i, true)
    else if (extended && c === '(' && pattern[i + 1] === '?') throw new UnsupportedError('feature', 'regex extension', 'grep: ECMAScript group extensions are not supported in ERE')
  }
}

// A backreference outside a bracket, where a backslash is an escape.
function hasBackreference(pattern) {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== '\\') continue
    if (/[1-9]/u.test(pattern[++i] ?? '')) return true
  }
  return false
}

export function compilePatterns(patterns, flags, locale = LOCALE) {
  // Compile -e patterns separately: combining them would shift backreference
  // numbers across patterns. A line matches if any pattern selects it.
  const tables = classTables(locale)
  const res = []
  const whole = flags.has('x'), word = flags.has('w') && !whole
  if (flags.has('P') && new Set(patterns).size > 1) return { error: err('grep: -P only supports a single pattern', 2) }
  for (const pattern of patterns) {
    const gnu = !flags.has('F') && !flags.has('P')
    if (gnu) validateRegex(pattern, flags.has('E'), tables.multibyte)
    // -i is spelt into the pattern from the locale's tables (../regex-fold.js)
    // and the matchers run case-sensitively, as GNU's do. A backreference
    // has to see the text as written, so a pattern with one keeps the JS
    // flag instead, which agrees with GNU over ASCII and is refused past it
    // (inputGap); -P reads case by PCRE's own tables and is refused the same.
    const backrefs = gnu && hasBackreference(pattern)
    const folded = flags.has('i') && !flags.has('P') && !backrefs
    const reFlags = flags.has('i') && !folded ? 'isu' : 'su'
    let source
    if (flags.has('F')) source = folded ? foldFixed(pattern, tables) : RegExp.escape(pattern)
    else if (flags.has('P')) source = pcreSource(pattern)
    else if (flags.has('E')) source = ereClasses(folded ? foldPattern(pattern, tables) : pattern, tables)
    else {
      const r = breToEs(folded ? foldPattern(pattern, tables) : pattern, tables)
      if (r.error) return { error: err(`grep: ${r.error}`, 2) }
      source = r.source
    }
    const canonical = source
    if (gnu && validateBackreferences(canonical)) return { error: unsupported('feature', 'grep', 'conditional backreference', 'grep: backreferences with conditional or repeated-empty captures are not supported', 2) }
    if (word) source = `(?<!${tables.assertions().word})(?:${source})(?!${tables.assertions().word})`
    if (whole) source = `^(?:${source})$`
    try {
      // The boolean matcher needs POSIX quantifier stacking spelled out
      // for ECMAScript; the extent matcher below parses ERE itself and
      // already reads those the way GNU does, so it takes `source` as is.
      // `-P` selects the ECMAScript reading, where `a+?` really is lazy,
      // so the rewrite is ERE's alone.
      const re = new RegExp(gnu ? grepSource(posixQuantifiers(source), false, tables) : source, reFlags)
      re.pcre = flags.has('P')
      // What still reads text by rules other than the locale's tables:
      // PCRE's own, and the JS case flag a backreference pattern keeps.
      re.localeSensitive = re.pcre ? flags.has('i') || word || localeSensitive(canonical) || /\\[dD]/u.test(canonical) : flags.has('i') && backrefs
      re.folded = folded
      re.extendedC = folded && EXTENDED_C.test(pattern)
      re.unicodePattern = /[\u0080-\u{10FFFF}]/u.test(pattern)
      const literal = flags.has('F') || !METACHARACTER.test(pattern)
      re.binaryLiteral = !whole && !word && literal
      // Whether the bytes alone can say that a file this terminal cannot read
      // as text holds no match — which only a plain literal answers, and only
      // one read as written or folded by the locale's own tables, never by
      // PCRE's. `-w` and `-x` narrow what the bytes being there would select,
      // so they answer here too, and a pattern holding a lone surrogate spells
      // no bytes at all. What that literal can be is spelled out on the first
      // such file, since most runs never meet one.
      if (literal && pattern.isWellFormed() && (folded || !flags.has('i'))) re.literal = { pattern, tables }
      if (flags.has('o') && gnu && !whole) {
        if (word || /\\[1-9]|\(\?/u.test(source)) return { error: unsupported('feature', 'grep', '-o regex extent', 'grep: only-matching with backreferences, lookarounds or word constraints is not supported', 2) }
        try { re.extent = new AwkRegex(grepSource(source, true, tables), false, null, tables) } catch {
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
  if (!flags.has('E') && /(?<!\\)\{(?!\d*(?:,\d*)?\})/u.test(source)) return false
  // References were validated before compilation. Their ERE-parser escape
  // reading is only a syntax proof here; it is never used to match input.
  try { parseEre(grepSource(source, true)); return true } catch (e) { return Boolean(e.gap) }
}

// The bytes a plain literal can be, character by character: what each one is
// as written, or the bytes of each character it stands for where `-i` folds
// it — `s` for `s`, `S` and `ſ`, which are one, one and two bytes.
function literalMask({ pattern, tables }, folded) {
  return [...pattern].map((character) => {
    const codes = folded ? tables.fold(character.codePointAt(0)) : [character.codePointAt(0)]
    return codes.map((code) => encodeUtf8(String.fromCodePoint(code)))
  })
}

// Whether these bytes can hold no match at all: every pattern is a plain
// literal that is nowhere in the file, whichever of its spellings is looked
// for. A search would find nothing there, which is what GNU prints for such
// a file and all this terminal has to do. Anything else has to be read to
// know. A character is one byte at least, so nothing can begin past the end.
export function cannotHoldMatch(bytes, res) {
  return res.every((re) => {
    if (!re.literal) return false
    re.literalMask ??= literalMask(re.literal, re.folded)
    return !holdsMask(bytes, re.literalMask)
  })
}

// The same question, asked of patterns that were never compiled here: `rg`
// reads its own dialect and only needs to know whether a plain literal, as
// written, is anywhere in the bytes at all. Nothing else answers, and a
// folded one does not either — ripgrep folds case by its own tables.
export function literalsMissing(bytes, patterns, literal, locale = LOCALE) {
  const tables = classTables(locale)
  return patterns.every((pattern) => (literal || !METACHARACTER.test(pattern)) && pattern.isWellFormed() &&
    !holdsMask(bytes, literalMask({ pattern, tables }, false)))
}

function holdsMask(haystack, mask) {
  for (let at = 0; at + mask.length <= haystack.length; at++) if (maskAt(haystack, at, mask, 0)) return true
  return false
}

function maskAt(haystack, at, mask, i) {
  if (i === mask.length) return true
  return mask[i].some((option) => option.every((byte, k) => haystack[at + k] === byte) && maskAt(haystack, at + option.length, mask, i + 1))
}

// What makes a pattern more than the characters it spells.
const METACHARACTER = /[\\.^$*+?()[\]{}|]/u

export function inputGap(inputs, res, invert, forceText = false, locale = LOCALE) {
  if (inputs.length === 0) return null
  // Bytes that spell no text are binary to GNU whatever else they hold, and
  // searching them is what a terminal working in text cannot do: `-a` asks
  // for those bytes as the output itself, which it cannot print either.
  if (inputs.some((inp) => inp.content === undefined)) {
    return unsupported('feature', 'grep', 'binary input', 'grep: binary input detection and output are not supported', 2)
  }
  // A literal absent from a binary file is still safely a non-match.
  // Regex anchors and classes can see NUL boundaries differently in GNU.
  if (!forceText && inputs.some((inp) => inp.content.includes('\0') && (invert || res.some((re) => !re.binaryLiteral || re.test(inp.content))))) return unsupported('feature', 'grep', 'binary input', 'grep: binary input detection and output are not supported', 2)
  // The matcher reads a character at a time, which is C.UTF-8's reading and
  // no other locale's: anywhere else, a pattern the locale could change is
  // refused over non-ASCII text before any of it is read.
  const nonAscii = /[\u0080-\u{10FFFF}]/u
  if (locale !== LOCALE && res.some((re) => re.localeSensitive || re.folded) && (res.some((re) => re.unicodePattern) || inputs.some((inp) => nonAscii.test(inp.content)))) {
    return unsupported('feature', 'grep', 'locale', `grep: matching non-ASCII text in the ${locale} locale is not supported`, 2)
  }
  // GNU's two matchers fold the Cyrillic Extended-C letters differently
  // (see EXTENDED_C in ../locale.js), so a case-insensitive match over them
  // is refused rather than guessed.
  if (res.some((re) => re.extendedC) || (res.some((re) => re.folded) && inputs.some((inp) => EXTENDED_C.test(inp.content)))) {
    return unsupported('feature', 'grep', 'locale-sensitive regex', 'grep: case-insensitive matching over Cyrillic Extended-C letters is not supported', 2)
  }
  const sensitive = res.filter((re) => re.localeSensitive)
  if (sensitive.length === 0 || !(sensitive.some((re) => re.unicodePattern) || inputs.some((inp) => nonAscii.test(inp.content)))) return null
  const why = sensitive.some((re) => re.pcre) ? 'PCRE matching' : 'case-insensitive matching with backreferences'
  return unsupported('feature', 'grep', 'non-ASCII regex semantics', `grep: ${why} on non-ASCII input is not supported`, 2)
}
