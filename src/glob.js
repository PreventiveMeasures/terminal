// Shell-style glob matching and pathname expansion. Two layers:
//
// `compileGlob` / `globMatch` — basename / full-path predicate
//   (used by find for -name and -path, where matching is per-entry
//   against a single pattern). `*`, `?` and `[...]` are the metachars;
//   `*` spans `/` in this form, matching the `-path '*/node_modules/*'`
//   idiom. Hot-path callers compile once and reuse the RegExp;
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

import { joinPath, resolve } from './fs.js'
import { readPosixClass } from './charclass.js'

const META = /[*?[]/u
const REGEX_META = /[.+*?^${}()|[\]\\/]/u

// Compile a glob pattern to a RegExp. `*` → `.*` (no `/` exemption:
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
      if (bracket) { re += bracket.source; i = bracket.end } else re += '\\['
    } else if (REGEX_META.test(c)) re += '\\' + c
    else re += c
  }
  const flags = opts?.ignoreCase ? 'ui' : 'u'
  try {
    return new RegExp(re + '$', flags)
  } catch {
    // A bracket expression the regex engine rejects (`[z-a]`) matches
    // nothing in bash either, so the pattern stands for its own text.
    return new RegExp('^' + literalSource(pattern) + '$', flags)
  }
}

// The pattern as a regex for exactly its literal text, `\x` escapes
// resolved.
function literalSource(pattern) {
  return pattern.replace(/\\(.)/gu, '$1').replace(/[.+*?^${}()|[\]\\/]/gu, '\\$&')
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
function readBracket(pattern, start) {
  let i = start + 1
  let negated = false
  if (pattern[i] === '!' || pattern[i] === '^') { negated = true; i++ }
  let body = ''
  let members = 0
  if (pattern[i] === ']') { body += '\\]'; i++; members++ }
  for (; i < pattern.length && pattern[i] !== ']'; i++) {
    const c = pattern[i]
    if (c === '[' && pattern[i + 1] === ':') {
      const cls = readPosixClass(pattern, i, { unknown: 'empty' })
      if (cls) { body += cls.body; i = cls.end - 1; members++; continue }
    }
    if (c === '\\' && i + 1 < pattern.length) {
      const next = pattern[++i]
      body += /[\]\\^[-]/u.test(next) ? `\\${next}` : next
    } else body += c === '\\' || c === '[' ? `\\${c}` : c
    members++
  }
  if (i >= pattern.length || members === 0) return null
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
  const absolute = pattern.startsWith('/')
  // Bash preserves a leading `./` in expansion output (`./*.js` →
  // `./foo.js`, not `foo.js`). Tracked separately from the internal
  // `.` candidate so it doesn't fight `joinSeg`'s `parent === '.'`
  // collapse, then re-attached after walking.
  const dotSlash = pattern.startsWith('./')
  const trailingSlash = pattern.endsWith('/') && pattern.length > 1
  const segments = pattern.split('/').filter(Boolean)
  if (segments.length === 0) return absolute ? ['/'] : []
  let candidates = [absolute ? '/' : '.']
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s]
    if (!META.test(seg)) {
      candidates = candidates.map((c) => joinSeg(c, unescape(seg)))
      continue
    }
    candidates = expandSegment(candidates, seg, s === segments.length - 1, ctx)
  }
  // A trailing slash in the pattern requests directories only,
  // and bash preserves the slash on the expanded matches (`*/` →
  // `dir1/ dir2/`). Filter then re-attach. The `c === '/'` guard
  // avoids `//` if a top-level glob ever resolves to root.
  if (trailingSlash) {
    candidates = candidates
      .filter((c) => ctx.fs.isDir(resolve(ctx.cwd, c)))
      .map((c) => c === '/' ? c : c + '/')
  } else {
    candidates = candidates.filter((c) => existsInFs(c, ctx))
  }
  if (dotSlash) candidates = candidates.map((c) => c.startsWith('./') ? c : './' + c)
  // Sort so callers see entries in a stable lexicographic order.
  candidates.sort()
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
  const abs = resolve(ctx.cwd, path)
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
    const abs = resolve(ctx.cwd, c)
    if (!ctx.fs.isDir(abs)) continue
    const { dirs, files } = ctx.fs.listDir(abs)
    for (const name of dirs) if (matches(name)) next.push(joinSeg(c, name))
    if (!isLast) continue
    for (const name of files) if (matches(name)) next.push(joinSeg(c, name))
  }
  return next
}

// Like joinPath, but a `.` parent (cwd-relative root) yields the bare
// child so expansion output stays relative (`foo.js`, not `./foo.js`).
function joinSeg(parent, child) {
  return parent === '.' ? child : joinPath(parent, child)
}
