// find — auditor's tree-walker, in its own file because the
// feature set (POSIX-style `-name` / `-type` / `-path` primaries,
// GNU long forms, `-not` / `!` negation, `-a` / `-o` boolean
// combinators with precedence, `-mindepth` / `-maxdepth` depth
// bounds, `-exec CMD ... ;` and `-exec CMD ... {} +` action /
// predicate, the per-path glob matcher) doesn't fit
// nav-commands.js's 300-line cap. The tree traversal itself is
// fs.js's `walkTree`.
//
// Predicate model: a list of OR-groups; each group is a list of
// AND-ed predicates. `-a` is the implicit default; `-o` starts a
// new group; `-not` / `!` flips the next predicate. `-mindepth` /
// `-maxdepth` aren't predicates — they're global walker options
// extracted up front: `-maxdepth` caps walkTree's descent, while
// `-mindepth` filters which visited entries are reported.
//
// `-exec` is variadic (token list up to `;` or `+`), so it's
// parsed inline in walkExprTokens rather than going through
// primaryFor. The `;` form dispatches per match and the exit code
// drives the predicate's boolean. The `+` form collects paths
// during the walk and dispatches once after, treating the
// predicate as always-true for filtering (matching GNU — a real
// filter would need to know the outcome before all paths are in).
// Either form suppresses the default print (which is otherwise
// the implicit action), matching POSIX.

import { basename, relativeTo, resolve, walkTree } from './fs.js'
import { compileGlob } from './glob.js'
import { err, parseNonNegativeInt } from './util.js'

const PRIMARIES = new Set(['name', 'type', 'path', 'mindepth', 'maxdepth'])

export function find(_stdin, tokens, ctx) {
  const parsed = parseFindArgs(tokens)
  if (parsed.error) return parsed.error
  const { starts, minDepth, maxDepth, groups, hasExec, batches } = parsed
  const out = []
  let stdout = ''
  let stderr = ''
  let exitCode = 0
  for (const start of starts) {
    const startAbs = resolve(ctx.cwd, start)
    if (!ctx.fs.isDir(startAbs) && !ctx.fs.isFile(startAbs)) {
      return err(`find: ${start}: no such file or directory`)
    }
    for (const entry of walkTree(ctx.fs, startAbs, maxDepth)) {
      if (entry.depth < minDepth) continue
      const display = toDisplayPath(start, startAbs, entry.path)
      const r = runPredicates(groups, { kind: entry.kind, path: display }, ctx)
      stdout += r.stdout
      stderr += r.stderr
      if (r.exitCode !== 0) exitCode = r.exitCode
      if (r.matched && !hasExec) out.push(display)
    }
  }
  // Batched `-exec ... +` runs after the walk with all collected
  // paths. Empty collector = no dispatch — matches GNU's "don't run
  // on empty arglist" rule, which mirrors xargs -r.
  for (const pred of batches) {
    if (pred.collected.length === 0) continue
    const finalArgs = pred.args.slice(0, -1).concat(pred.collected)
    const r = ctx.dispatch(pred.cmd, finalArgs, '')
    stdout += r.stdout
    stderr += r.stderr
    if (r.exitCode !== 0) exitCode = r.exitCode
  }
  const printed = out.length === 0 ? '' : out.join('\n') + '\n'
  return { stdout: printed + stdout, stderr, exitCode }
}

function parseFindArgs(tokens) {
  const filtered = stripDepthOpts(tokens)
  if (filtered.error) return filtered
  const r = walkExprTokens(filtered.tokens, filtered.minDepth, filtered.maxDepth)
  if (r.error) return r
  // Pre-walk scan: any -exec in the tree suppresses the implicit
  // -print, and `+`-mode predicates need post-walk dispatching.
  // Collect both once rather than re-scanning per entry.
  const execs = []
  for (const g of r.groups) for (const p of g) if (p.kind === 'exec') execs.push(p)
  return { ...r, hasExec: execs.length > 0, batches: execs.filter((p) => p.mode === 'batch') }
}

// Extract `-mindepth N` / `-maxdepth N` (and `--` long forms) first.
// They're walker-global options, not predicates — `-maxdepth` prunes
// the descent, `-mindepth` gates the output, and both want N up front
// rather than threaded through the predicate tree. The `--` terminator
// is checked AFTER the depth branch so `-maxdepth --` surfaces the
// friendlier "invalid count" rather than "requires a value" — matches
// POSIX getopt's "value-taking option consumes the next token
// regardless" rule.
function stripDepthOpts(tokens) {
  const out = []
  let minDepth = 0
  let maxDepth = Number.POSITIVE_INFINITY
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const opt = t === '-mindepth' || t === '--mindepth' ? 'mindepth'
      : t === '-maxdepth' || t === '--maxdepth' ? 'maxdepth'
      : null
    if (opt) {
      if (i + 1 >= tokens.length) return { error: err(`find: -${opt} requires a value`) }
      const r = parseNonNegativeInt(tokens[i + 1], `find: -${opt}`)
      if (r.error) return r
      if (opt === 'mindepth') minDepth = r.value
      else maxDepth = r.value
      i++
      continue
    }
    if (t === '--') {
      out.push(...tokens.slice(i))
      break
    }
    out.push(t)
  }
  return { tokens: out, minDepth, maxDepth }
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
function walkExprTokens(tokens, minDepth, maxDepth) {
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
    if (t === '-exec' || t === '--exec') {
      const parsed = consumeExec(tokens, i, pendingNot)
      if (parsed.error) return parsed
      groups.at(-1).push(parsed.pred)
      pendingNot = false; expectingRhs = null; seenExpr = true; i = parsed.nextI
      continue
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
  return { starts: starts.length > 0 ? starts : ['.'], minDepth, maxDepth, groups }
}

function primaryFor(token) {
  // -mindepth / -maxdepth are stripped before we get here; never treat
  // them as primaries even if one slips through.
  if (/^--?(?:min|max)depth$/u.test(token)) return null
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

// Consume the variadic `-exec CMD ARG... ;` or `-exec CMD ARG... {} +`
// starting at tokens[i] (the `-exec`/`--exec` itself). Returns the
// built predicate and the index of the terminator (caller advances
// past it). `+` form requires `{}` as the last argument — POSIX is
// strict here; GNU is too. The collector array lives on the predicate
// so multiple `+` invocations each keep their own batch.
function consumeExec(tokens, i, pendingNot) {
  let j = i + 1
  while (j < tokens.length && tokens[j] !== ';' && tokens[j] !== '+') j++
  if (j >= tokens.length) return { error: err('find: -exec: missing terminator (`;` or `+`)') }
  if (j === i + 1) return { error: err('find: -exec: requires a command') }
  const execTokens = tokens.slice(i + 1, j)
  const mode = tokens[j] === ';' ? 'each' : 'batch'
  if (mode === 'batch') {
    if (execTokens.at(-1) !== '{}') {
      return { error: err('find: -exec ... +: `{}` must be the last argument before `+`') }
    }
    // POSIX/GNU: only one `{}` is allowed in `+` form. Without this
    // check `find … -exec echo {} {} +` would pass the leading `{}`
    // through literally — confusing and inconsistent with GNU's
    // rejection of the same input.
    if (execTokens.slice(0, -1).includes('{}')) {
      return { error: err('find: -exec ... +: only one instance of `{}` is supported') }
    }
    // -not on the batch form is incoherent: the predicate is treated
    // as always-true during the walk (a real filter would need to know
    // the outcome before all paths are collected), so negating it
    // would either drop every match silently or run the batched
    // command anyway. Reject up front rather than pick a surprising
    // semantic.
    if (pendingNot) {
      return { error: err('find: `-not -exec ... +` is not supported (the `+` form has no meaningful negation)') }
    }
  }
  const pred = { kind: 'exec', mode, cmd: execTokens[0], args: execTokens.slice(1), negate: pendingNot }
  if (mode === 'batch') pred.collected = []
  return { pred, nextI: j }
}

// Top-level match: OR across groups, AND within. With no
// predicates at all (`find /`), the single empty group matches
// everything — `[].every(…)` is true. Returns {matched, stdout,
// stderr, exitCode} so per-entry -exec side effects (output, exit
// code) propagate; non-exec predicates contribute empty stdout/stderr
// and exit 0. OR/AND short-circuit, so an -exec only runs when its
// position in the boolean tree is reached.
function runPredicates(groups, entry, ctx) {
  let stdout = ''
  let stderr = ''
  let exitCode = 0
  let matched = false
  for (const group of groups) {
    let groupMatched = true
    for (const p of group) {
      const r = evalOne(p, entry, ctx)
      stdout += r.stdout
      stderr += r.stderr
      if (r.exitCode !== 0) exitCode = r.exitCode
      if (!r.matched) { groupMatched = false; break }
    }
    if (groupMatched) { matched = true; break }
  }
  return { matched, stdout, stderr, exitCode }
}

function evalOne(p, entry, ctx) {
  const r = evalPredicate(p, entry, ctx)
  return { ...r, matched: p.negate ? !r.matched : r.matched }
}

function evalPredicate(p, entry, ctx) {
  if (p.kind === 'type') return matchedOnly(p.value === 'f' ? entry.kind === 'file' : entry.kind === 'dir')
  if (p.kind === 'name') return matchedOnly(p.re.test(basename(entry.path)))
  if (p.kind === 'path') return matchedOnly(p.re.test(entry.path))
  if (p.kind === 'exec') return evalExec(p, entry, ctx)
  return matchedOnly(false)
}

function matchedOnly(b) { return { matched: b, stdout: '', stderr: '', exitCode: 0 } }

function evalExec(p, entry, ctx) {
  // `+` form treats the predicate as always-true and defers dispatch
  // to after the walk — see the post-walk loop in find().
  if (p.mode === 'batch') { p.collected.push(entry.path); return matchedOnly(true) }
  // `;` form: substitute every `{}` occurrence in each argument with
  // the entry path (GNU does in-arg replacement, not just standalone-
  // `{}` replacement), dispatch, and let the exit code drive the
  // predicate boolean.
  const args = p.args.map((a) => a.replaceAll('{}', entry.path))
  const r = ctx.dispatch(p.cmd, args, '')
  return { matched: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }
}

function toDisplayPath(userPath, absRoot, absPath) {
  if (absPath === absRoot) return userPath
  const rel = relativeTo(absRoot, absPath)
  // POSIX find prepends the user-typed prefix verbatim, including
  // `./` for a `.` start — important so a pattern like
  // `*/node_modules/*` matches the descendants. grep -r in this
  // codebase drops the `./` instead; the two commands intentionally
  // diverge here, each following its own GNU convention.
  return userPath.endsWith('/') ? userPath + rel : userPath + '/' + rel
}
