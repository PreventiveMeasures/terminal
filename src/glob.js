// compileGlob matches a name/path; '*' may cross '/' for find predicates.
// globPaths expands pathname segments, respecting the word's quoting mask
// and the shell's dotfile rule. Its empty result leaves the word literal.

import { compareNames, lookup } from './fs.js'
import { UnsupportedError } from './unsupported.js'
import { POSIX_CLASSES, readPosixClass } from './charclass.js'

const META = /[*?[]/u
const NON_ASCII = /\P{ASCII}/u
const REGEX_META = /[.+*?^${}()|[\]\\/]/u

// Escape regex syntax while translating shell wildcards. Keep options in an
// object: callers also pass this function to map(), whose index is not a flag.
export function compileGlob(pattern, opts = {}) {
  try { return compilePattern(pattern, opts) } catch (error) {
    if (error instanceof UnsupportedError) throw error
    throw new UnsupportedError('feature', 'glob pattern', `unsupported glob pattern: ${error.message}`)
  }
}

function compilePattern(pattern, opts) {
  let re = '^'
  let nonAsciiRange = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1]
      re += literal(next, opts.ignoreCase)
      i++
    } else if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '[') {
      const bracket = readBracket(pattern, i, opts)
      if (bracket?.voided) return /^(?!)$/u
      if (bracket) {
        re += bracket.source; i = bracket.end
        nonAsciiRange ||= bracket.nonAsciiRange
      } else re += '\\['
    } else re += literal(c, opts.ignoreCase)
  }
  return checkedGlob(new RegExp(re + '(?![\\s\\S])', 'us'), pattern, opts, nonAsciiRange)
}

function literal(c, ignoreCase) {
  if (ignoreCase && /[a-zA-Z]/u.test(c)) return `[${c.toLowerCase()}${c.toUpperCase()}]`
  return REGEX_META.test(c) ? '\\' + c : c
}

// fnmatch folds literals and ranges, but tests POSIX classes against the
// original character: -iname '[[:upper:]]*' still requires an uppercase
// initial. Build the ASCII union explicitly so negation and mixed classes
// keep that distinction without a regex-wide `i` flag. checkedGlob rejects
// non-ASCII case matching before this matcher can silently drop a name.
function foldedBracket(body, classes, negated) {
  const ordinary = new RegExp(`[${body}]`, 'ui')
  const named = new RegExp(`[${classes}]`, 'u')
  let members = ''
  for (let code = 0; code < 128; code++) {
    const c = String.fromCodePoint(code)
    if (ordinary.test(c) || named.test(c)) members += '\\x' + code.toString(16).padStart(2, '0')
  }
  return `[${negated ? '^' : ''}${members}]`
}

// Bracket ranges, question marks and case folding depend on the locale for
// multibyte names. Literal UTF-8 names and ordinary star patterns are exact.
function checkedGlob(re, pattern, opts, nonAsciiRange) {
  const localeSensitive = /[?[]/u.test(pattern)
  const nonAsciiPattern = NON_ASCII.test(pattern)
  return { test(name) {
    if (nonAsciiRange || (opts.ignoreCase && nonAsciiPattern) || ((localeSensitive || opts.ignoreCase) && NON_ASCII.test(name))) {
      throw new UnsupportedError('feature', 'non-ASCII glob matching', 'locale-dependent glob matching of non-ASCII names is not supported')
    }
    return re.test(name)
  } }
}

// An unmatched '[' is literal. Bash unknown classes contribute no members;
// reversed ranges are empty, but a POSIX class ending a range voids the pattern.
// Track range endpoints separately so adjacent classes cannot create a range.
function readBracket(pattern, start, opts) {
  const { ignoreCase } = opts
  let i = start + 1
  let negated = false
  if (pattern[i] === '!' || pattern[i] === '^') { negated = true; i++ }
  let body = ''
  let classes = ''
  let rangeAt = false
  let openRange = false
  let nonAsciiRange = false
  let voided = false
  let atom = '', atomStart = 0, rangeChar = '', rangeStart = 0
  if (pattern[i] === ']') { body += '\\]'; i++; rangeAt = true; atom = ']' }
  for (; i < pattern.length && pattern[i] !== ']'; i++) {
    const c = pattern[i]
    if (c === '[' && (pattern[i + 1] === '.' || pattern[i + 1] === '=')) throw new UnsupportedError('feature', 'glob collating or equivalence class', 'glob collating symbols and equivalence classes are not supported')
    if (c === '[' && pattern[i + 1] === ':') {
      const cls = opts.bash ? readGlobClass(pattern, i) : readPosixClass(pattern, i, { unknown: 'empty' })
      if (cls) {
        if (!opts.bash && cls.body === '') {
          throw new UnsupportedError('feature', 'glob character class', 'unknown POSIX classes in command filename patterns are not supported')
        }
        if (openRange) voided = true
        if (ignoreCase) classes += cls.body
        else body += cls.body
        i = cls.end - 1
        rangeAt = false
        openRange = false
        continue
      }
      // Bash resumes at ':' when a class name has no closing ':]'.
      if (opts.bash) continue
    }
    if (c === '-' && rangeAt) {
      rangeStart = atomStart; rangeChar = atom
      body += '-'
      openRange = true
      rangeAt = false
    } else {
      const next = c === '\\' && i + 1 < pattern.length ? pattern[++i] : c
      atomStart = body.length; atom = next
      if (openRange && NON_ASCII.test(rangeChar + next)) nonAsciiRange = true
      if (openRange && next.codePointAt(0) < rangeChar.codePointAt(0)) body = body.slice(0, rangeStart)
      else body += /[\]\\^[-]/u.test(next) ? `\\${next}` : next
      // A character that closed a range cannot begin the next one, so
      // the second `-` in `[a-z-x]` is a member, not another operator.
      rangeAt = !openRange
      openRange = false
    }
  }
  if (i >= pattern.length) return null
  if (voided) return { voided: true, end: i }
  return { source: ignoreCase ? foldedBracket(body, classes, negated) : `[${negated ? '^' : ''}${body}]`, end: i, nonAsciiRange }
}

function readGlobClass(pattern, start) {
  const end = pattern.indexOf(':]', start + 2)
  if (end === -1) return null
  // Bash finds the raw terminator before dequoting the name, including a
  // backslash immediately before that terminator.
  const name = pattern.slice(start + 2, end).replace(/\\([\s\S]|$)/gu, '$1')
  return { body: name === 'ascii' ? '\\x00-\\x7F' : POSIX_CLASSES[name] ?? '', end: end + 2 }
}

export function globMatch(name, pattern) {
  return compileGlob(pattern).test(name)
}

// Whether a word has an unquoted `*`, `?` or `[` — the only case that
// reaches the filesystem at all.
export function hasGlobMeta(word) {
  const { value, mask } = word
  if (mask === null) return META.test(value)
  for (let i = 0; i < value.length; i++) if (mask[i] === '0' && META.test(value[i])) return true
  return false
}

export function hasExtglob(word) {
  const bare = (i) => !word.mask || word.mask[i] === '0'
  for (let i = 0; i < word.value.length; i++) {
    const c = word.value[i]
    if (!bare(i)) continue
    if (c === '\\') i++
    else if (c === '[') i = bracketEnd(word, i, bare)
    else if (/[?*+@!]/u.test(c) && word.value[i + 1] === '(' && bare(i + 1)) return true
  }
  return false
}

function bracketEnd(word, start, bare) {
  const { value } = word
  let i = start + 1
  if (/[!^]/u.test(value[i]) && bare(i)) i++
  if (value[i] === ']' && bare(i)) i++
  for (; i < value.length; i++) {
    if (!bare(i)) continue
    if (value[i] === '\\') i++
    else if (value[i] === ']') return i
    else if (value[i] === '[' && /[.:=]/u.test(value[i + 1]) && bare(i + 1)) {
      const end = value.indexOf(value[i + 1] + ']', i + 2)
      if (end !== -1) i = end + 1
    }
  }
  return start
}

// The word as a pattern for compileGlob: bare characters as typed,
// quoted ones backslash-escaped where they would otherwise be read as
// glob syntax — including the characters that are only special inside
// a bracket expression, so `[a"-"c]` is a set of three, not a range.
const QUOTABLE = /[*?[\]^!\\:.=-]/u

export function globPattern(word) {
  const { value, mask } = word
  if (mask === null) return value
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    out += mask[i] !== '0' && QUOTABLE.test(c) ? '\\' + c : c
  }
  return out
}

// Expand one path segment at a time while preserving the operand's spelling.
export function globPaths(word, ctx) {
  const pattern = globPattern(word)
  const segments = pattern.match(/[^/]+|\/+/gu) ?? []
  let candidates = ['']
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s]
    if (seg.startsWith('/') || !META.test(seg)) {
      candidates = candidates.map((c) => c + unescape(seg))
      continue
    }
    candidates = expandSegment(candidates, seg, s === segments.length - 1, ctx)
  }
  // lookup validates literal suffixes and requires a directory for trailing '/'.
  return candidates.filter((c) => lookup(ctx.cwd, c, ctx.fs).path !== null).sort(compareNames)
}

// A literal segment may still carry escapes from globPattern (a quoted
// `*` in a path component that has no live metacharacter).
const unescape = (seg) => seg.replace(/\\(.)/gu, '$1')

// Only the last segment may match files. Shell globbing excludes dotfiles
// unless the segment starts with '.', and never yields '.' or '..'.
function expandSegment(candidates, seg, isLast, ctx) {
  const re = compileGlob(seg, { bash: true })
  const segStartsWithDot = seg.startsWith('.') || seg.startsWith('\\.')
  const matches = (name) => {
    if (!segStartsWithDot && name.startsWith('.')) return false
    return re.test(name)
  }
  const next = []
  for (const c of candidates) {
    const abs = lookup(ctx.cwd, c || '.', ctx.fs).path
    if (!ctx.fs.isDir(abs)) continue
    const { dirs, files } = ctx.fs.listDir(abs)
    for (const name of isLast ? [...dirs, ...files] : dirs) if (matches(name)) next.push(c + name)
  }
  return next
}
