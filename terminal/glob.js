// Shell-style glob matching and argv expansion. Two layers:
//
// `compileGlob` / `globMatch` — basename / full-path predicate
//   (used by find for -name and -path, where matching is per-entry
//   against a single pattern). `*` and `?` are the only metachars;
//   `*` spans `/` in this form, matching the `-path '*/node_modules/*'`
//   idiom. Hot-path callers compile once and reuse the RegExp;
//   `globMatch` is the one-shot convenience.
//
// `expandGlobs` — argv-level wildcard expansion, called once per
//   pipeline stage in index.js between parse and dispatch. Splits
//   each unquoted token on `/`, walks the FS segment by segment,
//   and replaces the pattern token with the matching paths in
//   lexicographic order. Quoted tokens (marked by parse.js's
//   tokenizer) and the leading argv[0] (command name) are passed
//   through verbatim. A pattern that matches nothing also passes
//   through literally — bash's default, which leaves it to the
//   receiving command to report "no such file" with the user's
//   original text.

import { resolve } from './fs.js'

const META = /[*?]/u

// Compile a glob pattern to a RegExp. `*` → `.*` (no `/` exemption:
// `*/foo/*` is the standard exclusion idiom), `?` → `.`, other regex
// metacharacters escaped. Callers on hot paths (per-directory scans,
// find's per-entry evaluation) should compile once and reuse rather
// than calling `globMatch` repeatedly.
export function compileGlob(pattern) {
  return new RegExp('^' + pattern
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*/gu, '.*')
    .replace(/\?/gu, '.') + '$', 'u')
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

function joinSeg(parent, child) {
  if (parent === '.') return child
  if (parent === '/') return '/' + child
  return parent + '/' + child
}
