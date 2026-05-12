// find — auditor's tree-walker, in its own file because the
// feature set (POSIX-style `-name` / `-type` / `-path` primaries,
// GNU long forms, `-not` / `!` negation, `-a` / `-o` boolean
// combinators with precedence, `-maxdepth` capping, the per-path
// glob matcher, the depth-aware walker) doesn't fit nav-commands.js's
// 300-line cap.
//
// Predicate model: a list of OR-groups; each group is a list of
// AND-ed predicates. `-a` is the implicit default; `-o` starts a
// new group; `-not` / `!` flips the next predicate. `-maxdepth`
// isn't part of the predicate tree — it's a global walker option
// extracted up front so the walker can prune instead of filtering
// after the fact.

import { basename, resolve } from './fs.js'
import { compileGlob } from './glob.js'
import { err, ok, parseNonNegativeInt } from './util.js'

const PRIMARIES = new Set(['name', 'type', 'path', 'maxdepth'])

export function find(_stdin, tokens, ctx) {
  const parsed = parseFindArgs(tokens)
  if (parsed.error) return parsed.error
  const { starts, maxDepth, groups } = parsed
  const out = []
  for (const start of starts) {
    const startAbs = resolve(ctx.cwd, start)
    if (!ctx.fs.isDir(startAbs) && !ctx.fs.isFile(startAbs)) {
      return err(`find: ${start}: no such file or directory`)
    }
    for (const entry of walk(ctx.fs, startAbs, maxDepth)) {
      const display = toDisplayPath(start, startAbs, entry.path)
      if (matchGroups(groups, { kind: entry.kind, path: display })) out.push(display)
    }
  }
  return ok(out.length === 0 ? '' : out.join('\n') + '\n')
}

function parseFindArgs(tokens) {
  const filtered = stripMaxDepth(tokens)
  if (filtered.error) return filtered
  return walkExprTokens(filtered.tokens, filtered.maxDepth)
}

// Extract `-maxdepth N` / `--maxdepth N` first. They're walker-global
// options, not predicates — putting them in the predicate tree would
// still need the walker to know N up front for pruning. The `--`
// terminator is checked AFTER the maxdepth branch so `-maxdepth --`
// surfaces the friendlier "invalid count" rather than "requires a
// value" — matches POSIX getopt's "value-taking option consumes the
// next token regardless" rule.
function stripMaxDepth(tokens) {
  const out = []
  let maxDepth = Number.POSITIVE_INFINITY
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '-maxdepth' || t === '--maxdepth') {
      if (i + 1 >= tokens.length) return { error: err('find: -maxdepth requires a value') }
      const r = parseNonNegativeInt(tokens[i + 1], 'find: -maxdepth')
      if (r.error) return r
      maxDepth = r.value
      i++
      continue
    }
    if (t === '--') {
      out.push(...tokens.slice(i))
      break
    }
    out.push(t)
  }
  return { tokens: out, maxDepth }
}

// Walk the remaining tokens building OR-groups of AND-ed predicates.
// POSIX find: zero or more start paths come first, then the
// expression. Once an expression token appears (primary or operator),
// any later positional is rejected — paths can't be interleaved
// with primaries. `--` ends primary recognition; trailing tokens
// after it are paths.
//
// The `--` check sits AFTER the primary-with-value branch so
// `-name --` consumes the literal `--` as the glob value, matching
// POSIX getopt's "value-taking option consumes the next token
// regardless" rule. Pre-splitting on `--` would break that.
function walkExprTokens(tokens, maxDepth) {
  const groups = [[]]
  const starts = []
  let pendingNot = false
  let afterTerminator = false
  let seenExpr = false
  // Tracks an explicit boolean operator (`-a` / `-o`) that hasn't
  // yet been balanced by a primary. Holds the operator string so
  // the error can name it; cleared when a primary is consumed.
  let expectingRhs = null
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (afterTerminator) { starts.push(t); continue }
    if (t === '-not' || t === '!') {
      if (pendingNot) return { error: err('find: `-not` cannot precede another `-not`') }
      pendingNot = true; seenExpr = true; continue
    }
    if (t === '-a' || t === '-and' || t === '--and') {
      if (pendingNot) return { error: err('find: `-not` must be followed by a primary') }
      if (expectingRhs) return { error: err(`find: \`${expectingRhs}\` with no right-hand expression`) }
      if (groups.at(-1).length === 0) return { error: err('find: `-a` with no left-hand expression') }
      expectingRhs = '-a'; seenExpr = true; continue
    }
    if (t === '-o' || t === '-or' || t === '--or') {
      if (pendingNot) return { error: err('find: `-not` must be followed by a primary') }
      if (expectingRhs) return { error: err(`find: \`${expectingRhs}\` with no right-hand expression`) }
      if (groups.at(-1).length === 0) return { error: err('find: `-o` with no left-hand expression') }
      groups.push([]); expectingRhs = '-o'; seenExpr = true; continue
    }
    const primary = primaryFor(t)
    if (primary !== null) {
      if (i + 1 >= tokens.length) return { error: err(`find: ${t} requires a value`) }
      const value = tokens[i + 1]
      const checked = checkPrimary(primary, value)
      if (checked.error) return checked
      // Compile the glob regex once at parse time so the walker
      // doesn't recompile it for every directory entry — large
      // trees with `-name '*.js'` are the common case.
      const pred = { kind: primary, value, negate: pendingNot }
      if (primary === 'name' || primary === 'path') pred.re = compileGlob(value)
      groups.at(-1).push(pred)
      pendingNot = false; expectingRhs = null; seenExpr = true; i++
      continue
    }
    if (t === '--') { afterTerminator = true; continue }
    if (pendingNot) return { error: err(`find: \`-not\` must be followed by a primary, got: ${t}`) }
    // Anything else that starts with `-` is an unknown option,
    // not a path. Reject so a typo (`find -X /src`) surfaces here
    // rather than as a "no such file or directory: -X" lower down.
    if (t.startsWith('-') && t !== '-' && !/^-\d/u.test(t)) {
      return { error: err(`find: unknown option: ${t}`) }
    }
    if (seenExpr) return { error: err(`find: paths must precede expression: ${t}`) }
    starts.push(t)
  }
  if (pendingNot) return { error: err('find: trailing `-not` with no primary') }
  if (expectingRhs) return { error: err(`find: \`${expectingRhs}\` with no right-hand expression`) }
  return { starts: starts.length > 0 ? starts : ['.'], maxDepth, groups }
}

function primaryFor(token) {
  if (token === '-maxdepth' || token === '--maxdepth') return null  // already stripped
  if (token.startsWith('--') && PRIMARIES.has(token.slice(2))) return token.slice(2)
  if (token.startsWith('-') && PRIMARIES.has(token.slice(1))) return token.slice(1)
  return null
}

function checkPrimary(kind, value) {
  if (kind === 'type' && value !== 'f' && value !== 'd') {
    return { error: err(`find: -type/--type expects 'f' or 'd', got: ${value}`) }
  }
  return {}
}

// Top-level match: OR across groups, AND within. With no
// predicates at all (`find /`), the single empty group matches
// everything — `[].every(…)` is true.
function matchGroups(groups, entry) {
  return groups.some((g) => g.every((p) => matchPredicate(p, entry)))
}

function matchPredicate(p, entry) {
  const hit = evalPredicate(p, entry)
  return p.negate ? !hit : hit
}

function evalPredicate(p, entry) {
  if (p.kind === 'type') return p.value === 'f' ? entry.kind === 'file' : entry.kind === 'dir'
  if (p.kind === 'name') return p.re.test(basename(entry.path))
  if (p.kind === 'path') return p.re.test(entry.path)
  return false
}

function toDisplayPath(userPath, absRoot, absPath) {
  if (absPath === absRoot) return userPath
  const rel = absRoot === '/' ? absPath.slice(1) : absPath.slice(absRoot.length + 1)
  // POSIX find prepends the user-typed prefix verbatim, including
  // `./` for a `.` start — important so a pattern like
  // `*/node_modules/*` matches the descendants. grep -r in this
  // codebase drops the `./` instead; the two commands intentionally
  // diverge here, each following its own GNU convention.
  return userPath.endsWith('/') ? userPath + rel : userPath + '/' + rel
}

// Yields `{ path, kind }`. Tracks depth internally so `maxDepth`
// can cap recursion: depth 0 is the start path, depth 1 is its
// direct children, and so on. Matches POSIX `find -maxdepth N`.
function* walk(fs, root, maxDepth = Number.POSITIVE_INFINITY) {
  if (fs.isFile(root)) { yield { path: root, kind: 'file' }; return }
  yield { path: root, kind: 'dir' }
  // Index pointer instead of Array.shift() — shift() is O(n) per
  // call because it reindexes the rest of the array, making BFS
  // O(n²) on large trees.
  const queue = [{ path: root, depth: 0 }]
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]
    if (cur.depth >= maxDepth) continue
    const { dirs, files } = fs.listDir(cur.path)
    const join = (n) => cur.path === '/' ? '/' + n : cur.path + '/' + n
    for (const d of dirs) {
      const path = join(d)
      yield { path, kind: 'dir' }
      queue.push({ path, depth: cur.depth + 1 })
    }
    for (const f of files) yield { path: join(f), kind: 'file' }
  }
}
