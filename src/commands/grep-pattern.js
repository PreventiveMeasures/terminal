import { checkInterval, readPosixClass, validateBracket } from '../charclass.js'
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

// POSIX stacks quantifiers: `a+?` is `(a+)?`, which matches the empty
// string, and `a+*` is `(a+)*`. ECMAScript reads `+?` as a lazy `+` and
// rejects `+*` outright, so wrap each quantified unit to restore GNU's
// reading. Groups wrap whole, and a third quantifier wraps the second.
export function posixQuantifiers(source) {
  let out = ''
  let unit = -1        // where the last quantifiable unit starts in `out`
  let quantified = false
  const groups = []
  const atom = () => { unit = out.length; quantified = false }
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '\\') { atom(); out += c + (source[++i] ?? ''); continue }
    if (c === '[') {
      const end = classEnd(source, i)
      atom()
      out += source.slice(i, end + 1)
      i = end
      continue
    }
    if (c === '(') { groups.push(out.length); unit = -1; quantified = false; out += c; continue }
    if (c === ')') { out += c; unit = groups.pop() ?? -1; quantified = false; continue }
    // Nothing quantifiable precedes an alternation branch or an anchor.
    if (c === '|' || c === '^' || c === '$') { out += c; unit = -1; quantified = false; continue }
    const interval = c === '{' ? ERE_INTERVAL.exec(source.slice(i)) : null
    if (c === '*' || c === '+' || c === '?' || interval) {
      const text = interval ? interval[0] : c
      if (quantified && unit >= 0) out = out.slice(0, unit) + '(?:' + out.slice(unit) + ')'
      out += text
      quantified = true
      i += text.length - 1
      continue
    }
    atom()
    out += c
  }
  return out
}

// These constructs have different meanings in ECMAScript and GNU grep.
// Refuse them rather than letting the JS engine silently pick a dialect.
// Bracket expressions and interval bounds are checked here, on the
// pattern as written, so BRE and ERE get the same diagnostics.
export function validateRegex(pattern, extended) {
  let bracket = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') {
      const next = pattern[++i]
      if (next === undefined) throw new Error('trailing backslash')
      if (bracket || (next && 'dDxXuUpPkKcC'.includes(next))) throw new UnsupportedError('feature', 'regex escape', 'grep: this regex escape is not supported with GNU semantics')
      if (!extended && !bracket && next === '{') intervalBounds(pattern, i - 1, false)
    } else if (c === '[') {
      if (!bracket) validateBracket(pattern, i)
      bracket = true
    } else if (c === ']') bracket = false
    else if (extended && c === '{' && !bracket) intervalBounds(pattern, i, true)
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
