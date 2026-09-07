// Shell-style glob matching and argv expansion. Two layers:
//
// `compileGlob` / `globMatch` — basename / full-path predicate
//   (used by find for -name and -path, where matching is per-entry
//   against a single pattern). `*`, `?`, and bracket expressions are
//   metachars;
//   `*` spans `/` in this form, matching the `-path '*/node_modules/*'`
//   idiom. Hot-path callers compile once and reuse the RegExp;
//   `globMatch` is the one-shot convenience.
//
// `expandGlobs` — argv-level wildcard expansion, called once per
//   pipeline stage in index.js between parse and dispatch. Splits
//   each unquoted token on `/`, walks the FS segment by segment,
//   and replaces the pattern token with the matching paths in
//   lexicographic order. Quoted tokens (marked by tokenize.js) and
//   the leading argv[0] (command name) are passed
//   through verbatim. A pattern that matches nothing also passes
//   through literally — bash's default, which leaves it to the
//   receiving command to report "no such file" with the user's
//   original text.

import { joinPath, resolve } from './fs.js'
import { UnsupportedError } from './unsupported.js'

const META = /[*?[]/u

// Compile a glob pattern to a RegExp. `*` → `.*` (no `/` exemption:
// `*/foo/*` is the standard exclusion idiom), `?` → `.`, bracket
// expressions retain their usual character/range semantics, and `\<x>` → `x`
// taken literally (so `\-foo` matches `-foo`, `\*` matches `*`),
// other regex metacharacters escaped. Callers on hot paths (per-
// directory scans, find's per-entry evaluation) should compile once
// and reuse rather than calling `globMatch` repeatedly.
//
// `REGEX_META` includes `*` and `?` so the `\<x>` branch escapes them
// when emitting a literal. The unescaped `*` / `?` branches come
// first in the loop, so the `REGEX_META.test(c)` arm only sees other
// metachars — the redundancy doesn't fire there.
const REGEX_META = /[.+*?^${}()|[\]\\]/u
const POSIX_CLASS_NAMES = new Set([
  'alnum', 'alpha', 'blank', 'cntrl', 'digit', 'graph',
  'lower', 'print', 'punct', 'space', 'upper', 'xdigit',
])
// `opts.ignoreCase` gives a caller case-insensitive matching (`find
// -iname`); everything else about the translation is identical, so the
// two spellings can never drift apart. It is an OPTIONS OBJECT rather
// than a positional flag string on purpose: this function is passed
// straight to `Array#map` in places, which would hand a positional
// second parameter the element INDEX — silently corrupting the regex
// flags. A stray number reads as `{}.ignoreCase === undefined` and is
// harmlessly ignored.
export function compileGlob(pattern, opts = {}) {
  let re = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    // `\<x>` consumes the backslash and emits `x` as a literal char.
    // Matches bash's shell-glob convention: `\*` matches `*`, `\-foo`
    // matches `-foo` (handy for filenames that start with `-`). A
    // trailing backslash with no follower stays literal.
    if (c === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1]
      re += REGEX_META.test(next) ? '\\' + next : next
      i++
    } else if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '[') {
      const bracket = readBracket(pattern, i)
      if (bracket) { re += bracket.source; i = bracket.end }
      else re += '\\['
    }
    else if (REGEX_META.test(c)) re += '\\' + c
    else re += c
  }
  return new RegExp(re + '$', opts?.ignoreCase ? 'ui' : 'u')
}

// Translate one shell bracket expression. The closing `]` is allowed as
// the first member (`[]a]`), and `!` / `^` in the first position negate
// the class. An unmatched `[` remains literal, as fnmatch-style globs do.
// Backslashes are already the glob language's quote character, so an
// escaped class member is emitted literally rather than as regex syntax.
// POSIX named classes, collating symbols, and equivalence classes are
// locale-sensitive and cannot be represented faithfully with one static
// JavaScript character class. Reject and diagnose them rather than using
// ASCII approximations that silently miss input such as `É` under UTF-8.
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
      const end = pattern.indexOf(':]', i + 2)
      if (end < 0) return null
      const name = pattern.slice(i + 2, end)
      if (!POSIX_CLASS_NAMES.has(name)) throw new Error(`invalid character class: ${name}`)
      throw new UnsupportedError('feature', 'glob POSIX character class', 'locale-sensitive glob POSIX character classes are not supported')
    }
    if (c === '[' && (pattern[i + 1] === '.' || pattern[i + 1] === '=')) {
      throw new UnsupportedError('feature', 'glob collating symbol', 'glob collating symbols and equivalence classes are not supported')
    }
    if (c === '\\' && i + 1 < pattern.length) {
      const next = pattern[++i]
      body += next === '-' || next === ']' || next === '\\' || next === '^' ? `\\${next}` : next
    } else {
      body += c === '\\' || c === ']' ? `\\${c}` : c
    }
    members++
  }
  if (i >= pattern.length || members === 0) return null
  return { source: `[${negated ? '^' : ''}${body}]`, end: i }
}

export function globMatch(name, pattern) {
  return compileGlob(pattern).test(name)
}

export function expandGlobs(argv, quotedSet, ctx) {
  if (argv.length === 0) return []
  // Command name (argv[0]) is never glob-expanded — bash doesn't
  // either, and treating a pattern match as a command name would
  // be surprising (and likely run an arbitrary file path through
  // the dispatcher).
  const out = [argv[0]]
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i]
    if (quotedSet.has(i) || !META.test(tok)) { out.push(tok); continue }
    const matches = expandOne(tok, ctx)
    if (matches.length > 0) out.push(...matches)
    else out.push(tok)
  }
  return out
}

// Walk the FS segment by segment, branching on each glob segment
// into every matching child. Literal segments append unchanged.
// Returns paths in the same shape the user typed (relative stays
// relative, absolute stays absolute) so output reads naturally.
function expandOne(pattern, ctx) {
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
      candidates = candidates.map((c) => joinSeg(c, seg))
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
// `.` doesn't match basenames that do — real `find -name` doesn't
// have this rule, only argv expansion does) before testing.
function expandSegment(candidates, seg, isLast, ctx) {
  const re = compileGlob(seg)
  const segStartsWithDot = seg.startsWith('.')
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
