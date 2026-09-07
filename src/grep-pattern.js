import { readPosixClass } from './charclass.js'
import { UnsupportedError, unsupported } from './unsupported.js'
import { err } from './util.js'
import { AwkRegex } from './awk-regex.js'
import { breToEs } from './bre.js'

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

// These constructs have different meanings in ECMAScript and GNU grep.
// Refuse them rather than letting the JS engine silently pick a dialect.
export function validateRegex(pattern, extended) {
  let bracket = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') {
      const next = pattern[++i]
      if (next === undefined) throw new Error('trailing backslash')
      if (bracket || (next && 'dDxXuUpPkKcC'.includes(next))) throw new UnsupportedError('feature', 'regex escape', 'grep: this regex escape is not supported with GNU semantics')
    } else if (c === '[') bracket = true
    else if (c === ']') bracket = false
    else if (extended && c === '(' && pattern[i + 1] === '?') throw new UnsupportedError('feature', 'regex extension', 'grep: ECMAScript group extensions are not supported in ERE')
  }
}

export function compilePatterns(patterns, flags) {
  // Pattern dialect (mutually exclusive; default is BRE):
  //   -F: literal match, via the standardized `RegExp.escape`.
  //   -E: pass through — the JS RegExp engine accepts ERE for the
  //       common shapes (`(`, `|`, `+`, `?`, `{n,m}`). POSIX classes
  //       and GNU escapes are translated by grep-pattern.js.
  //   default / -G: translate BRE → ES so `function(arg)`, `a|b`,
  //       `x?` are literal (matching POSIX and GNU grep). Use
  //       `\(`, `\|`, `\?` etc. for the metachar forms.
  // Each `-e` pattern is compiled SEPARATELY (not OR-combined into
  // a single regex). Combining would shift backreference numbering
  // across patterns — `grep -e '\(foo\)\(bar\)' -e '\(baz\)\1'`
  // would let pattern2's `\1` accidentally refer to pattern1's
  // group 1. A line matches when ANY of the regexes match.
  const res = []
  const reFlags = flags.has('i') ? 'isu' : 'su'
  for (const pattern of patterns) {
    if (!flags.has('F')) validateRegex(pattern, flags.has('E'))
    let source
    if (flags.has('F')) source = RegExp.escape(pattern)
    else if (flags.has('E')) source = ereClasses(pattern)
    else {
      const r = breToEs(pattern)
      if (r.error) return { error: err(`grep: ${r.error}`, 2) }
      source = r.source
    }
    // -w wraps in word-boundary anchors. Per pattern so each gets
    // its own boundary check rather than wrapping the union.
    if (flags.has('w')) source = `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])`
    try {
      const re = new RegExp(flags.has('F') ? source : grepSource(source), reFlags)
      re.localeSensitive = flags.has('i') || (!flags.has('F') && localeSensitive(source))
      re.unicodePattern = /[\u0080-\u{10FFFF}]/u.test(pattern)
      re.binaryLiteral = flags.has('F') || !/[\\.^$*+?()[\]{}|]/u.test(source)
      if (flags.has('o') && !flags.has('F')) {
        if (flags.has('w') || /\\[1-9]|\(\?/u.test(source)) return { error: unsupported('feature', 'grep', '-o regex extent', 'grep: only-matching with backreferences, lookarounds or word constraints is not supported', 2) }
        try { re.extent = new AwkRegex(grepSource(source, true), flags.has('i')) } catch {
          return { error: unsupported('feature', 'grep', '-o regex extent', 'grep: POSIX match extent for this pattern is not supported', 2) }
        }
      }
      res.push(re)
    } catch (e) {
      // POSIX: regex syntax errors exit 2 (separate from "no match"
      // which exits 1). Dialect label tells a confused user which
      // mode was active (e.g. `grep -E "Function("` says ERE).
      const dialect = flags.has('F') ? `fixed-string /${reFlags}`
        : flags.has('E') ? `ERE / ECMAScript /${reFlags}`
        : `BRE /${reFlags}`
      return { error: err(`grep: invalid pattern (${dialect}): ${e.message}`, 2) }
    }
  }
  return { res }
}

export function inputGap(inputs, res, invert) {
  if (inputs.length === 0) return null
  // A literal absent from a binary file is still safely a non-match.
  // Regex anchors and classes can see NUL boundaries differently in GNU.
  if (inputs.some((inp) => inp.content.includes('\0') && (invert || res.some((re) => !re.binaryLiteral || re.test(inp.content))))) return unsupported('feature', 'grep', 'binary input', 'grep: binary input detection and output are not supported', 2)
  const unicode = inputs.some((inp) => /[\u0080-\u{10FFFF}]/u.test(inp.content))
  if (res.some((re) => re.localeSensitive && (unicode || re.unicodePattern))) return unsupported('feature', 'grep', 'non-ASCII regex semantics', 'grep: locale-sensitive regular expression matching on non-ASCII input is not supported', 2)
  return null
}
