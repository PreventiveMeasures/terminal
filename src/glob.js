// Shell-style glob matching and pathname expansion. Two layers:
//
// `compileGlob` / `globMatch` — basename / full-path predicate
//   (used by find for -name and -path, where matching is per-entry
//   against a single pattern). `*`, `?` and `[...]` are the metachars;
//   `*` spans `/` in this form, matching the `-path '*/node_modules/*'`
//   idiom. Hot-path callers compile once and reuse the matcher;
//   `globMatch` is the one-shot convenience.
//
// `globPaths` — pathname expansion of one argv word, called from
//   expand.js after parameter expansion. Splits the pattern on `/`,
//   walks the FS segment by segment, and returns the matching paths in
//   lexicographic order — or an empty list, which the caller turns back
//   into the literal word (bash's default, which leaves it to the
//   receiving command to report "no such file" with the user's text).
//   The word's quoting mask decides which metacharacters are live:
//   `"*"` and `\*` are literal asterisks, `"$d"/*.js` still globs.

import { compareNames, lookup } from './fs.js'
import { UnsupportedError } from './unsupported.js'
import { readPosixClass } from './charclass.js'

const META = /[*?[]/u
const REGEX_META = /[.+*?^${}()|[\]\\/]/u

// Compile a glob pattern to a matcher. `*` → `.*` (no `/` exemption:
// `*/foo/*` is the standard exclusion idiom), `?` → `.`, `[...]` → a
// character class (see readBracket), `\<x>` → `x` taken literally (so
// `\-foo` matches `-foo`, `\*` matches `*`), other regex metacharacters
// escaped. `opts.ignoreCase` gives a caller case-insensitive matching
// (`find -iname`). It is an OPTIONS OBJECT rather than a positional
// flag on purpose: this function is passed straight to `Array#map` in
// places, which would hand a positional second parameter the element
// INDEX — silently corrupting the regex flags.
export function compileGlob(pattern, opts = {}) {
  let re = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1]
      re += REGEX_META.test(next) ? '\\' + next : next
      i++
    } else if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '[') {
      const bracket = readBracket(pattern, i)
      if (bracket?.voided) return /^(?!)$/u
      if (bracket) { re += bracket.source; i = bracket.end } else re += '\\['
    } else if (REGEX_META.test(c)) re += '\\' + c
    else re += c
  }
  try {
    return checkedGlob(new RegExp(re + '$', opts?.ignoreCase ? 'usi' : 'us'), pattern, opts)
  } catch {
    return /^(?!)$/u
  }
}

// Bracket ranges, question marks and case folding depend on the locale for
// multibyte names. Literal UTF-8 names and ordinary star patterns are exact.
function checkedGlob(re, pattern, opts) {
  return { test(name) {
    if ((/[?[]/u.test(pattern) || opts.ignoreCase) && [...name + (opts.ignoreCase ? pattern : '')].some((c) => c.codePointAt(0) > 127)) {
      throw new UnsupportedError('feature', 'non-ASCII glob matching', 'locale-dependent glob matching of non-ASCII names is not supported')
    }
    return re.test(name)
  } }
}

// One bracket expression starting at the `[` at `pattern[start]`. `!`
// or `^` first negates; a `]` first is a member; `[:alpha:]` and the
// other POSIX classes expand to their ranges; `\x` is a literal member.
// An unmatched `[` (no closing `]`, or nothing inside) is not a bracket
// expression at all and stays a literal `[`, as fnmatch treats it.
//
// A class name fnmatch does not know is read and contributes NO member,
// rather than failing the pattern the way grep does: `[[:bogus:]]` is an
// empty set that matches no name (so the word stands for its own text),
// `[[:bogus:]x]` still matches `x`, and `[![:bogus:]]` — the negation of
// nothing — matches any single character. Bash does the same.
//
// No class, known or unknown, may END a range: fnmatch rejects such a
// pattern outright, and a rejected pattern matches nothing at all — even
// negated, so `[a-[:alpha:]x]` and `[^a-[:bogus:]x]` both match no name.
// That is `voided`, which the caller turns into a matcher for nothing.
// Reversed character ranges contribute no members, even when negated. A class may still sit
// on either side of a LITERAL `-`, which is what a `-` after one is:
// `[[:alpha:]-[:digit:]]` is those two sets plus a hyphen. So the flags
// below track only what a single character can begin — `rangeAt` says a
// range may start here, `openRange` that one is waiting for its end —
// which is also what stops an empty class body from fusing its
// neighbours into `[a-x]`.
function readBracket(pattern, start) {
  let i = start + 1
  let negated = false
  if (pattern[i] === '!' || pattern[i] === '^') { negated = true; i++ }
  let body = ''
  let members = 0
  let rangeAt = false
  let openRange = false
  let voided = false
  let atom = '', atomStart = 0, rangeChar = '', rangeStart = 0
  if (pattern[i] === ']') { body += '\\]'; i++; members++; rangeAt = true; atom = ']' }
  for (; i < pattern.length && pattern[i] !== ']'; i++) {
    const c = pattern[i]
    if (c === '[' && (pattern[i + 1] === '.' || pattern[i + 1] === '=')) throw new UnsupportedError('feature', 'glob collating or equivalence class', 'glob collating symbols and equivalence classes are not supported')
    if (c === '[' && pattern[i + 1] === ':') {
      const cls = readPosixClass(pattern, i, { unknown: 'empty' })
      if (cls) {
        if (openRange) voided = true
        body += cls.body
        i = cls.end - 1
        members++
        rangeAt = false
        openRange = false
        continue
      }
    }
    if (c === '-' && rangeAt) {
      rangeStart = atomStart; rangeChar = atom
      body += '-'
      openRange = true
      rangeAt = false
    } else {
      const next = c === '\\' && i + 1 < pattern.length ? pattern[++i] : c
      atomStart = body.length; atom = next
      if (openRange && next.codePointAt(0) < rangeChar.codePointAt(0)) body = body.slice(0, rangeStart)
      else body += /[\]\\^[-]/u.test(next) ? `\\${next}` : next
      // A character that closed a range cannot begin the next one, so
      // the second `-` in `[a-z-x]` is a member, not another operator.
      rangeAt = !openRange
      openRange = false
    }
    members++
  }
  if (i >= pattern.length || members === 0) return null
  if (voided) return { voided: true, end: i }
  return { source: `[${negated ? '^' : ''}${body}]`, end: i }
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

// The word as a pattern for compileGlob: bare characters as typed,
// quoted ones backslash-escaped where they would otherwise be read as
// glob syntax — including the characters that are only special inside
// a bracket expression, so `[a"-"c]` is a set of three, not a range.
const QUOTABLE = /[*?[\]^!\\-]/u

function toPattern(word) {
  const { value, mask } = word
  if (mask === null) return value
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    out += mask[i] !== '0' && QUOTABLE.test(c) ? '\\' + c : c
  }
  return out
}

// Walk the FS segment by segment, branching on each glob segment
// into every matching child. Literal segments append unchanged.
// Returns paths in the same shape the user typed (relative stays
// relative, absolute stays absolute) so output reads naturally.
export function globPaths(word, ctx) {
  const pattern = toPattern(word)
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
  candidates = candidates.filter((c) => pattern.endsWith('/')
    ? ctx.fs.isDir(lookup(ctx.cwd, c, ctx.fs).path) : existsInFs(c, ctx))
  // Sort so callers see entries in a stable lexicographic order.
  candidates.sort(compareNames)
  return candidates
}

// A literal segment may still carry escapes from toPattern (a quoted
// `*` in a path component that has no live metacharacter).
const unescape = (seg) => seg.replace(/\\(.)/gu, '$1')

// Literal segments append onto every candidate without checking
// the FS — `*/qux.js` would otherwise yield `dir/qux.js` even
// when only `other/qux.js` actually exists. Final existence
// check drops the dead branches.
function existsInFs(path, ctx) {
  const abs = lookup(ctx.cwd, path, ctx.fs).path
  return ctx.fs.isFile(abs) || ctx.fs.isDir(abs)
}

// Branch each candidate dir into its matching children. Only the
// last segment may match files; intermediate segments need a dir
// to descend through. Compiles the segment regex once and applies
// the bash dotfile rule (a segment whose pattern doesn't start with
// a literal `.` doesn't match basenames that do — real `find -name`
// doesn't have this rule, only argv expansion does) before testing.
// Bash 5.2 also never yields `.` and `..` themselves (`globskipdots`).
function expandSegment(candidates, seg, isLast, ctx) {
  const re = compileGlob(seg)
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
    for (const name of dirs) if (matches(name)) next.push(c + name)
    if (!isLast) continue
    for (const name of files) if (matches(name)) next.push(c + name)
  }
  return next
}
