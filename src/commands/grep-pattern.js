import { checkInterval, readPosixClass, validateBracket } from '../charclass.js'
import { UnsupportedError, unsupported, unsupportedFrom, unsupportedNote } from '../unsupported.js'
import { MARKER_RANGE, err } from '../util.js'
import { AwkRegex } from '../awk/regex.js'
import { breToEs, validateBackreferences } from '../bre.js'
import { EXTENDED_C, LOCALE, classTables } from '../locale.js'
import { foldFixed, foldPattern } from '../regex-fold.js'
import { glibcDiffers, glibcRuns, literalText, markedAssertions, markedClass, outsideWords, patternShape, wholeCharacters } from './grep-literal.js'
import { pcreRejection, pcreSource } from './grep-pcre.js'
import { ERE_INTERVAL, caselessEscape, classEnd, ereLiterals, fixedStrings, gnuDiagnostics, posixQuantifiers } from './grep-syntax.js'

export { cannotHoldMatch } from './grep-literal.js'
export { posixQuantifiers } from './grep-syntax.js'

// POSIX named classes come from the locale's table. Collating and
// equivalence expressions need collation semantics that we do not model.
// A backslash in a bracket is a member, which the JS class spells `\\`.
export function ereClasses(pattern, tables) {
  let out = ''
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') {
      if (inClass) { out += '\\\\'; continue }
      out += gnuEscape(pattern[++i] ?? '')
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
// carrying any of it is refused over non-ASCII input. The `?` opening a
// group's syntax — `(?:`, `(?<name>` — repeats nothing.
export function localeSensitive(source) {
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\') {
      if ('bBsSwW<>'.includes(source[++i] ?? '')) return true
    } else if (source[i] === '(' && source[i + 1] === '?') i++
    else if ('.[*+?{'.includes(source[i])) return true
  }
  return false
}

// The canonical pattern retains GNU assertions. Render them separately
// for the boolean JS matcher (`js`), the AWK extent matcher (`extent`) and
// the JS matcher over a line holding markers (`marked`). Walk escapes
// instead of replaceAll so a literal `\\b` remains a backslash and b.
// The JS matcher gets the locale's word and space sets spelt out, since
// its own `\\b` and `\\w` know ASCII only; the extent matcher reads the
// escapes itself, from the same tables.
export function grepSource(source, mode = 'js', tables = classTables(LOCALE)) {
  const extent = mode === 'extent', marked = mode === 'marked'
  const assertions = extent ? { b: '\\y' } : marked ? { ...jsAssertions(tables), ...markedAssertions(tables) } : jsAssertions(tables)
  let out = ''
  let bracket = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '\\') {
      const next = source[++i]
      out += !bracket && Object.hasOwn(assertions, next) ? assertions[next] : c + next
      if (!extent && !bracket && /[1-9]/u.test(next) && /\d/u.test(source[i + 1] ?? '')) out += '(?:)'
    } else if (marked && c === '[') {
      const end = classEnd(source, i)
      out += markedClass(source.slice(i, end + 1))
      i = end
    } else if (marked && c === '.') out += `[^${MARKER_RANGE}]`
    else {
      if (c === '[') bracket = true
      if (c === ']') bracket = false
      out += c
    }
  }
  return out
}

function jsAssertions(tables) {
  const js = tables.assertions()
  return {
    '<': js['<'], '>': js['>'], b: js.boundary, B: js.inside,
    w: js.word, W: js.nonWord, s: js.space, S: js.nonSpace, '`': '^', "'": '$',
  }
}

// What a search tests lines with: a copy of the compiled pattern bearing none
// of the properties set on it here, which would keep V8 off its fast path for
// every line.
export const plainRegex = (re) => re.plain ??= new RegExp(re.source, re.flags)

// The matcher for a file holding markers, built the first time one is met.
// `-F` and `-P` spell their own sources: a fixed string names no marker, and
// PCRE's reading of bytes that are not UTF-8 is refused before this is asked.
export function markedRegex(re) {
  if (re.markedSource === undefined) return plainRegex(re)
  re.marked ??= new RegExp(wholeCharacters(grepSource(re.markedSource, 'marked', re.tables)), re.flags)
  return re.marked
}

const BRE_INTERVAL = /^\\\{(?=\d|,)(\d*)(?:,(\d*))?\\\}/u

// GNU rejects an interval bound above RE_DUP_MAX outright. ECMAScript
// accepts any bound, so the limit is ours to enforce.
function intervalBounds(pattern, i, extended) {
  const m = (extended ? ERE_INTERVAL : BRE_INTERVAL).exec(pattern.slice(i))
  if (!m && !extended) throw new Error('invalid repetition count')
  if (m) checkInterval(Number(m[1]), m[2] === undefined || m[2] === '' ? undefined : Number(m[2]))
}

// These constructs have different meanings in ECMAScript and GNU grep.
// Refuse them rather than letting the JS engine silently pick a dialect.
// Bracket expressions and interval bounds are checked here, on the
// pattern as written, so BRE and ERE get the same diagnostics — the
// bounds and an ERE `(?` unless `checked`, as grep's patterns are, which
// glibc and the dfa have already read (gnuDiagnostics): there a BRE `\{`
// with nothing before it is the character, and so is the `?` after `(`.
// `checked` also takes a backslash in a bracket for the member it is.
export function validateRegex(pattern, extended, multibyte = false, checked = false) {
  // Membership is by position, not by the next `]`: a class ends where
  // validateBracket says it does, so the `]` closing `[:alpha:]` inside it
  // — or a literal `]` in first position — does not end it early. Members
  // shaped like intervals or groups are then read as the characters they
  // are, so `[[:alpha:]{40000}]` and `[(?]` stay the classes GNU sees.
  let bracketEnd = -1
  for (let i = 0; i < pattern.length; i++) {
    // A backslash in a bracket is one of its members (validateBracket) —
    // to grep. sed reads some of them as escapes first, which a bracket
    // here would not, so for it one is refused.
    if (i <= bracketEnd) {
      if (!checked && pattern[i] === '\\') throw new UnsupportedError('feature', 'regex escape', 'grep: this regex escape is not supported with GNU semantics')
      continue
    }
    const c = pattern[i]
    if (c === '\\') {
      const next = pattern[++i]
      if (next === undefined) throw new Error('trailing backslash')
      if (next && 'dDxXuUpPkKcC'.includes(next)) throw new UnsupportedError('feature', 'regex escape', 'grep: this regex escape is not supported with GNU semantics')
      if (!checked && !extended && next === '{') intervalBounds(pattern, i - 1, false)
    } else if (c === '[') bracketEnd = validateBracket(pattern, i, multibyte)
    else if (!checked && extended && c === '{') intervalBounds(pattern, i, true)
    else if (!checked && extended && c === '(' && pattern[i + 1] === '?') throw new UnsupportedError('feature', 'regex extension', 'grep: ECMAScript group extensions are not supported in ERE')
  }
}

// A backreference outside a bracket, where a backslash is an escape. The
// pattern has passed validateRegex, so every bracket ends where
// validateBracket says.
function hasBackreference(pattern) {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '[') i = validateBracket(pattern, i)
    else if (pattern[i] === '\\' && /[1-9]/u.test(pattern[++i] ?? '')) return true
  }
  return false
}

// A wildcard, or a set spelt by what it excludes, over the normalised source:
// either can match what is not ASCII, and what that is — one character or the
// bytes of one — is the locale's to say.
function readsAnyCharacter(source) {
  let inClass = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '\\') { i++; continue }
    if (inClass) { if (c === ']') inClass = false; continue }
    if (c === '.') return true
    if (c === '[') { inClass = true; if (source[i + 1] === '^') return true }
  }
  return false
}

export function compilePatterns(patterns, flags, locale = LOCALE, origins = []) {
  // Compile -e patterns separately: combining them would shift backreference
  // numbers across patterns. A line matches if any pattern selects it.
  const tables = classTables(locale)
  const res = []
  const whole = flags.has('x'), word = flags.has('w') && !whole
  if (flags.has('P') && new Set(patterns).size > 1) return { error: err('grep: the -P option only supports a single pattern', 2) }
  // GNU has said what it will of a -G or -E pattern before this compiles
  // one, so anything the translation below cannot take is its own gap, not
  // a mistake in the pattern. Two or more that all read as fixed strings
  // are searched as those, as GNU does, and never asked about at all.
  let warnings = ''
  if (!flags.has('F') && !flags.has('P')) {
    const fixed = patterns.length > 1 ? fixedStrings(patterns, flags.has('E'), flags.has('i') ? tables : null) : null
    if (fixed) {
      patterns = fixed
      flags = new Set([...flags].filter((flag) => flag !== 'E' && flag !== 'G')).add('F')
    } else {
      const said = gnuDiagnostics(patterns, origins, { extended: flags.has('E'), icase: flags.has('i'), lines: whole, words: flags.has('w'), multibyte: tables.multibyte, up: tables.up })
      if (said.error) return { error: err(said.error, 2) }
      warnings = said.warnings
    }
  }
  const gnu = !flags.has('F') && !flags.has('P')
  for (const pattern of patterns) {
    // What PCRE2 rejects is said here (pcreRejection); one it takes is
    // matched as the pattern alone, with the JS matcher's -w wrapping, which
    // reads the same unless the pattern reaches into GNU's — an unbalanced
    // `)` or an unended \Q — which this then refuses.
    const rejected = flags.has('P') ? pcreRejection(pattern, word) : null
    if (rejected) return { error: rejected }
    let re
    try { re = compileOne(pattern, flags, tables, gnu, whole, word) } catch (e) {
      if (unsupportedNote(e)) return { error: unsupportedFrom(e, 'grep', e.message.startsWith('grep: ') ? e.message : `grep: ${e.message}`, 2) }
      const dialect = gnu ? 'GNU regular expression' : 'PCRE pattern'
      return { error: unsupported('feature', 'grep', gnu ? 'GNU regex syntax' : 'PCRE syntax', `grep: this ${dialect} cannot be represented by the JavaScript matcher`, 2) }
    }
    if (re.error) return re
    res.push(re)
  }
  return { res, warnings }
}

function compileOne(pattern, flags, tables, gnu, whole, word) {
  if (gnu) validateRegex(pattern, flags.has('E'), tables.multibyte, true)
  if (gnu && flags.has('i') && caselessEscape(pattern)) throw new UnsupportedError('feature', 'regex escape', 'grep: a backslash before a lower-case letter is not supported with -i')
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
  else if (flags.has('E')) {
    const literals = ereLiterals(pattern, whole || word)
    source = ereClasses(folded ? foldPattern(literals, tables) : literals, tables)
  }
  else {
    const r = breToEs(folded ? foldPattern(pattern, tables) : pattern, tables, true)
    if (r.error) throw new Error(r.error)
    source = r.source
  }
  const canonical = source
  if (gnu && validateBackreferences(canonical)) return { error: unsupported('feature', 'grep', 'conditional backreference', 'grep: backreferences with conditional or repeated-empty captures are not supported', 2) }
  if (word) source = `(?<!${tables.assertions().word})(?:${source})(?!${tables.assertions().word})`
  if (whole) source = `^(?:${source})$`
  // The boolean matcher needs POSIX quantifier stacking spelled out for
  // ECMAScript; the extent matcher below parses ERE itself and already
  // reads those the way GNU does, so it takes `source` as is. `-P` selects
  // the ECMAScript reading, where `a+?` really is lazy, so the rewrite is
  // ERE's alone.
  const quantified = gnu ? posixQuantifiers(source) : source
  const re = new RegExp(wholeCharacters(gnu ? grepSource(quantified, 'js', tables) : source), reFlags)
  // What a line holding bytes that spell no character is matched with,
  // and what the pattern asks of a character, which says whether glibc
  // reads some such bytes as GNU's own matcher does not (inputGap).
  if (gnu) Object.assign(re, { markedSource: quantified, tables, shape: patternShape(pattern, backrefs) })
  re.pcre = flags.has('P')
  // What still reads text by rules other than the locale's tables:
  // PCRE's own, and the JS case flag a backreference pattern keeps.
  re.localeSensitive = re.pcre ? flags.has('i') || word || localeSensitive(canonical) || /\\[dD]/u.test(canonical) : flags.has('i') && backrefs
  re.folded = folded
  re.extendedC = folded && EXTENDED_C.test(pattern)
  re.unicodePattern = /[\u0080-\u{10FFFF}]/u.test(pattern)
  re.wellFormed = pattern.isWellFormed()
  // Whether -w meets a pattern that can match nothing at all (inputGap).
  re.emptyWord = word && !re.pcre && new RegExp(gnu ? grepSource(posixQuantifiers(canonical), 'js', tables) : canonical, reFlags).test('')
  // Whether the pattern reads a character at a time rather than a byte: a
  // wildcard and a set spelt by what it excludes both reach past ASCII,
  // and a locale's own classes name ASCII alone outside C.UTF-8 — so a set
  // spelt by what it holds reads the same either way, and a literal does.
  re.anyCharacter = readsAnyCharacter(canonical)
  const literal = literalText(pattern, flags)
  // Whether the bytes alone can say that a file this terminal cannot read
  // as text holds no match — which only a plain literal answers, and only
  // one read as written or folded by the locale's own tables, never by
  // PCRE's. `-w` and `-x` narrow what the bytes being there would select,
  // so they answer here too, and a pattern holding a lone surrogate spells
  // no bytes at all. What that literal can be is spelled out on the first
  // such file, since most runs never meet one.
  if (literal?.isWellFormed() && (folded || !flags.has('i'))) re.literal = { pattern: literal, tables }
  if (flags.has('o') && gnu && !whole) {
    if (word || /\\[1-9]|\(\?/u.test(source)) return { error: unsupported('feature', 'grep', '-o regex extent', 'grep: only-matching with backreferences, lookarounds or word constraints is not supported', 2) }
    try { re.extent = new AwkRegex(grepSource(source, 'extent', tables), false, null, tables) } catch {
      return { error: unsupported('feature', 'grep', '-o regex extent', 'grep: POSIX match extent for this pattern is not supported', 2) }
    }
  }
  return re
}

// What a search cannot answer of one file as GNU would, refused before any of
// it is read; `only` is -o, which asks where each match ends.
export function inputGap(inp, res, locale = LOCALE, only = false) {
  const refuse = (detail, message) => unsupported('feature', 'grep', detail, `grep: ${message}`, 2)
  if (inp.marked) {
    // PCRE reads bytes that are not UTF-8 by rules of its own, which are not
    // the ones GNU's matchers go by (markedRegex), and are not modelled.
    if (res.some((re) => re.pcre)) return refuse('binary input', 'PCRE matching over bytes that spell no text is not supported')
    // A pattern holding an unpaired surrogate has no UTF-8 spelling, so no
    // bytes could be what it names; over bytes it would meet the markers
    // instead, which are such surrogates standing for bytes (decodeUtf8Marked).
    if (res.some((re) => !re.wellFormed)) return refuse('unpaired surrogate', 'a pattern holding an unpaired UTF-16 surrogate cannot be matched against bytes')
  }
  // GNU's -w takes an empty match from inside a character it reads byte by
  // byte, where that character is no word character; this matcher reads every
  // character whole and cannot stand inside one, so a pattern that can match
  // nothing is refused over text holding such a character past ASCII.
  if (res.some((re) => re.emptyWord) && outsideWords(classTables(locale)).test(inp.content)) {
    return refuse('empty word match', '-w with a pattern that can match nothing, over non-ASCII text that is not word characters, is not supported')
  }
  // A surrogate spelt in UTF-8, or a character past U+10FFFF, is one glibc
  // reads as a character where GNU's own matcher reads its bytes as none, and
  // which of the two answers is GNU's choice per pattern (glibcDiffers). Only
  // a wildcard, a negated set or a word edge could tell, so only those look.
  const asks = inp.marked ? res.filter((re) => re.shape && (re.shape.wordEdge || re.shape.dot || re.shape.negated)) : []
  const reading = asks.length ? glibcRuns(inp.content) : null
  if (asks.some((re) => glibcDiffers(re.shape, reading, only))) {
    return refuse('binary input', 'matching this pattern beside bytes glibc reads as a character is not supported')
  }
  // The matcher reads a character at a time, which is C.UTF-8's reading and
  // no other locale's: anywhere else, a pattern the locale could change is
  // refused over non-ASCII text before any of it is read. A wildcard is one
  // such pattern — where a byte is a character it matches one byte of what is
  // spelt in more than one — so it is refused with the rest rather than
  // answered a character at a time.
  const nonAscii = () => res.some((re) => re.unicodePattern) || /[\u0080-\u{10FFFF}]/u.test(inp.content)
  if (locale !== LOCALE && res.some((re) => re.localeSensitive || re.folded || re.anyCharacter) && nonAscii()) {
    return refuse('locale', `matching non-ASCII text in the ${locale} locale is not supported`)
  }
  // GNU's two matchers fold the Cyrillic Extended-C letters differently
  // (see EXTENDED_C in ../locale.js), so a case-insensitive match over them
  // is refused rather than guessed.
  if (res.some((re) => re.extendedC) || (res.some((re) => re.folded) && EXTENDED_C.test(inp.content))) {
    return refuse('locale-sensitive regex', 'case-insensitive matching over Cyrillic Extended-C letters is not supported')
  }
  const sensitive = res.filter((re) => re.localeSensitive)
  if (sensitive.length === 0 || !nonAscii()) return null
  const why = sensitive.some((re) => re.pcre) ? 'PCRE matching' : 'case-insensitive matching with backreferences'
  return refuse('non-ASCII regex semantics', `${why} on non-ASCII input is not supported`)
}
