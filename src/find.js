// find — auditor's tree-walker, in its own file because the
// feature set (POSIX-style `-name` / `-type` / `-path` primaries,
// double-dash aliases, `-not` / `!` negation, `-a` / `-o` boolean
// combinators with precedence, `-mindepth` / `-maxdepth` depth
// bounds, `-print` and `-exec CMD ... ;` / `-exec CMD ... {} +`
// actions, the per-path glob matcher) doesn't fit
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
// Actions (`-print`, `-exec`) are predicates like any other — they
// just have output as a side effect. That's what makes GNU's
// evaluation order observable: an action fires when, and only
// when, short-circuit evaluation reaches its slot in the boolean
// tree, so `-print -exec echo {} ';'` interleaves path/echo per
// entry rather than emitting two batched blocks.
//
// `-print` is always-true and emits the path. `-exec` is variadic
// (token list up to `;` or `+`), so it's parsed inline in
// walkExprTokens rather than going through primaryFor. The `;`
// form dispatches per match and the exit code drives the
// predicate's boolean. The `+` form collects paths during the walk
// and dispatches once after, treating the predicate as always-true
// for filtering (matching GNU — a real filter would need to know
// the outcome before all paths are in).
//
// The default print is modeled as an implicit `-print` appended to
// each group when the expression names no action of its own —
// POSIX's rule, and the reason `-exec` alone produces no paths.
//
// One deliberate divergence, easy to misread as GNU compatibility:
// the double-dash spellings (`--name`, `--print`, `--exec`, `--and`,
// …) are a local convenience. Real find has no double-dash predicates
// at all — GNU 4.9 answers every one of them with "unknown predicate"
// — so only the single-dash forms are portable. Everything else in
// this file is checked against 4.9 and matches.

import { basename, relativeTo, resolve, walkTree } from './fs.js'
import { compileGlob } from './glob.js'
import { err, parseNonNegativeInt } from './util.js'

// `primaryFor` consumes the next token as the value for anything in
// here — hence the name, matching grep.js's SHORT_FLAGS/VALUE_SHORTS
// split. Valueless tokens must stay out: adding `empty` here would
// make `find / -empty -type f` swallow `-type` as its value.
const VALUE_PRIMARIES = new Set(['name', 'iname', 'type', 'path', 'mindepth', 'maxdepth'])

// The single spelling test for the double-dash aliases described
// above. One helper rather than a hand-written pair per token, so the
// aliases can't drift apart as tokens are added — `-a` / `-o` are the
// deliberate exceptions, spelled out at their call sites.
const isTok = (t, name) => t === '-' + name || t === '--' + name

export function find(_stdin, tokens, ctx) {
  const parsed = parseFindArgs(tokens)
  if (parsed.error) return parsed.error
  const { starts, minDepth, maxDepth, groups, batches } = parsed
  let stdout = ''
  let stderr = ''
  // GNU semantic (verified against /usr/bin/find 4.9): for the `;`
  // form, find's exit code is unaffected by exec failures — the per-
  // match exit code only drives the predicate boolean, not find's
  // overall exit. `find . -exec false ;` exits 0; so does
  // `find . -exec nosuchcommand ;` (the dispatch error still prints
  // to stderr, but find itself reports success).
  //
  // The `+` form is different (also verified): a failing batched
  // command DOES bubble. `find . -exec false {} +` exits 1, because
  // the batch is the actual command run on the collected list, not
  // a per-entry predicate input. Stdout/stderr propagate from both
  // forms regardless.
  let exitCode = 0
  for (const start of starts) {
    const startAbs = resolve(ctx.cwd, start)
    if (!ctx.fs.isDir(startAbs) && !ctx.fs.isFile(startAbs)) {
      // GNU continues past a missing/unreadable start: surface the
      // error, leave exit non-zero, but keep walking the remaining
      // starts. Aborting early would drop earlier-walks' output —
      // which `find src nope` did until this fix.
      stderr += `find: ${start}: no such file or directory\n`
      exitCode = 1
      continue
    }
    // A directory whose predicates hit `-prune` lands here; walkTree
    // asks about it after we have evaluated it, so the set is always
    // populated in time.
    const pruned = new Set()
    for (const entry of walkTree(ctx.fs, startAbs, maxDepth, (path) => !pruned.has(path))) {
      if (entry.depth < minDepth) continue
      const display = toDisplayPath(start, startAbs, entry.path)
      // `abs` rides along for predicates that must touch the file
      // itself (`-empty`); `path` stays the user-facing display form
      // every action prints.
      const r = runPredicates(groups, { kind: entry.kind, path: display, abs: entry.path, prune: pruned }, ctx)
      stdout += r.stdout
      stderr += r.stderr
    }
  }
  // Batched `-exec ... +` runs after the walk with all collected
  // paths. Empty collector = no dispatch — matches GNU's "don't run
  // on empty arglist" rule, which mirrors xargs -r. A non-zero batch
  // exit DOES bubble (see the header comment), but GNU verified
  // (4.9): the bubbled code is always `1`, regardless of the inner
  // command's actual exit. `find . -exec sh -c 'exit 5' {} +` exits
  // `1`, not `5`. And a "command not found" (dispatch 127) becomes
  // `1` too — find owns its own non-zero convention.
  for (const pred of batches) {
    if (pred.collected.length === 0) continue
    const finalArgs = pred.args.slice(0, -1).concat(pred.collected)
    const r = ctx.dispatch(pred.cmd, finalArgs, '')
    stdout += r.stdout
    stderr += r.stderr
    if (r.exitCode !== 0) exitCode = 1
  }
  return { stdout, stderr, exitCode }
}

function parseFindArgs(tokens) {
  const filtered = stripDepthOpts(tokens)
  if (filtered.error) return filtered
  const r = walkExprTokens(filtered.tokens, filtered.minDepth, filtered.maxDepth)
  if (r.error) return r
  // No action named → POSIX appends `-print` to the whole expression.
  // GNU wraps it (`( expr ) -print`); appending per-group is
  // equivalent under short-circuit AND — a group only reaches its
  // trailing print when the group matched, and the first matching
  // group short-circuits the rest, so each entry still prints once.
  //
  // Suppression is tree-wide, which is an important footgun:
  // `find . -name '*.js' -o -name '*.md' -exec echo md {} ';'` prints
  // ONLY the md echoes, never the bare .js paths. The .js group
  // doesn't include an action, but the tree's implicit -print is
  // gone, so its matches go unreported. Matches POSIX / GNU (verified
  // against /usr/bin/find 4.9); the fix is to spell the action out on
  // the other group: `... -name '*.js' -print -o -name '*.md' -exec …`.
  if (!r.hasAction) for (const g of r.groups) g.push({ kind: 'print', negate: false })
  return r
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
    const opt = isTok(t, 'mindepth') ? 'mindepth' : isTok(t, 'maxdepth') ? 'maxdepth' : null
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
  // Both are maintained at the push sites below rather than by a
  // second pass over `groups`, so the invariant stays next to the
  // code that can break it: a new action kind has to declare itself
  // here, or the implicit -print silently comes back. `batches`
  // holds the `+`-mode predicates find() dispatches after the walk.
  let hasAction = false
  const batches = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (afterTerminator) { starts.push(t); continue }
    if (t === '-not' || t === '!') {
      if (pendingNot) return { error: err('find: `-not` cannot precede another `-not`') }
      pendingNot = true; seenExpr = true; continue
    }
    if (t === '-a' || isTok(t, 'and')) {
      if (pendingNot) return { error: err('find: `-not` must be followed by a primary') }
      if (expectingRhs) return { error: err(`find: \`${expectingRhs}\` with no right-hand expression`) }
      if (groups.at(-1).length === 0) return { error: err('find: `-a` with no left-hand expression') }
      expectingRhs = '-a'; seenExpr = true; continue
    }
    if (t === '-o' || isTok(t, 'or')) {
      if (pendingNot) return { error: err('find: `-not` must be followed by a primary') }
      if (expectingRhs) return { error: err(`find: \`${expectingRhs}\` with no right-hand expression`) }
      if (groups.at(-1).length === 0) return { error: err('find: `-o` with no left-hand expression') }
      groups.push([]); expectingRhs = '-o'; seenExpr = true; continue
    }
    // Valueless action: always true, emits the path (see evalPredicate).
    if (isTok(t, 'print') || isTok(t, 'print0')) {
      groups.at(-1).push({ kind: isTok(t, 'print0') ? 'print0' : 'print', negate: pendingNot })
      hasAction = true
      pendingNot = false; expectingRhs = null; seenExpr = true
      continue
    }
    // `-prune` is TRUE and, on a directory, stops the descent. It is
    // deliberately NOT counted as an action: GNU still applies the
    // implicit `-print` when the expression contains nothing else, so
    // `find . -name node_modules -prune` prints what it pruned.
    if (isTok(t, 'prune')) {
      groups.at(-1).push({ kind: 'prune', negate: pendingNot })
      pendingNot = false; expectingRhs = null; seenExpr = true
      continue
    }
    if (isTok(t, 'empty')) {
      groups.at(-1).push({ kind: 'empty', negate: pendingNot })
      pendingNot = false; expectingRhs = null; seenExpr = true
      continue
    }
    if (isTok(t, 'exec')) {
      const parsed = consumeExec(tokens, i, pendingNot)
      if (parsed.error) return parsed
      groups.at(-1).push(parsed.pred)
      hasAction = true
      if (parsed.pred.mode === 'batch') batches.push(parsed.pred)
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
      // `-iname` is `-name` with a case-insensitive glob; compiling it
      // here keeps the matcher a single `re.test` either way.
      if (primary === 'name' || primary === 'path') pred.re = compileGlob(value)
      if (primary === 'iname') pred.re = compileGlob(value, { ignoreCase: true })
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
  return { starts: starts.length > 0 ? starts : ['.'], minDepth, maxDepth, groups, hasAction, batches }
}

function primaryFor(token) {
  // -mindepth / -maxdepth are stripped before we get here; never treat
  // them as primaries even if one slips through.
  if (/^--?(?:min|max)depth$/u.test(token)) return null
  if (token.startsWith('--') && VALUE_PRIMARIES.has(token.slice(2))) return token.slice(2)
  if (token.startsWith('-') && VALUE_PRIMARIES.has(token.slice(1))) return token.slice(1)
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
  // The canonical GNU form `find ... -exec CMD \;` doesn't work in
  // our shell: backslash-escaping outside quotes isn't honored, so
  // `\;` parses as the sequential-step separator before find ever
  // sees it. Quote the `;` literally — `';'` or `";"` — instead.
  // The hint is folded into the missing-terminator error because
  // that's the symptom users hit.
  if (j >= tokens.length) return { error: err("find: -exec: missing terminator (`;` or `+`); use `';'` (quoted) — bare `\\;` is consumed by the shell as a step separator") }
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

// Top-level evaluation: OR across groups, AND within. With no
// predicates at all (`find /`), the group holds just the implicit
// -print, so everything is reported. Returns only {stdout, stderr}:
// the expression's boolean is purely internal, since printing is an
// action and find's exit code never reflects whether anything
// matched. OR/AND short-circuit, so an action only runs
// when its position in the boolean tree is reached — that is what
// makes `-print -exec false ';' -print` emit one line, not two.
//
// Exec exit codes deliberately don't propagate to find's exit code
// — see the comment in find() — but they DO drive the predicate's
// boolean (0 = match, non-zero = no match), and `-not` inverts that
// boolean. Failing to short-circuit (e.g. for OR-group dispatching
// of -exec side effects on non-matching entries) would over-fire.
function runPredicates(groups, entry, ctx) {
  let stdout = ''
  let stderr = ''
  for (const group of groups) {
    let groupMatched = true
    for (const p of group) {
      const r = evalOne(p, entry, ctx)
      stdout += r.stdout
      stderr += r.stderr
      if (!r.matched) { groupMatched = false; break }
    }
    // First matching group wins — the remaining groups' actions must
    // not fire, which is why `-print -o -print` emits one line, not two.
    if (groupMatched) break
  }
  return { stdout, stderr }
}

function evalOne(p, entry, ctx) {
  const r = evalPredicate(p, entry, ctx)
  // Pass un-negated results through rather than re-wrapping them to
  // copy `matched` onto itself: this runs per predicate per entry, and
  // the spread costs ~15-20% of a whole `find /` (20k entries, min of
  // 100 reps: 2.6ms vs 3.3ms for `-type f`). Negation is rare enough
  // to keep paying for it.
  return p.negate ? { ...r, matched: !r.matched } : r
}

function evalPredicate(p, entry, ctx) {
  // `kind` is one of `type` / `name` / `iname` / `path` / `empty` /
  // `prune` /
  // `print` / `print0` / `exec` —
  // parser emits no other shapes. Every arm is named, so a new kind
  // appended at the bottom is reachable rather than dead; falling off
  // the end returns undefined and crashes the caller's destructure,
  // which IS the right failure mode for a contract violation that can
  // only come from a code bug.
  if (p.kind === 'type') return matchedOnly(p.value === 'f' ? entry.kind === 'file' : entry.kind === 'dir')
  if (p.kind === 'name' || p.kind === 'iname') return matchedOnly(p.re.test(basename(entry.path)))
  // A file is empty when it has no content. A DIRECTORY can never be
  // empty in this FS: it exists only because some file lives under it,
  // so `-empty` simply never matches one.
  // Always true. On a directory it also records the path so walkTree
  // skips the subtree; on a file it is a no-op that still reports true,
  // which is what makes `-name X -prune -o -print` exclude X itself.
  if (p.kind === 'prune') {
    if (entry.kind === 'dir') entry.prune.add(entry.abs)
    return matchedOnly(true)
  }
  if (p.kind === 'empty') return matchedOnly(entry.kind === 'file' && ctx.fs.readFile(entry.abs) === '')
  if (p.kind === 'path') return matchedOnly(p.re.test(entry.path))
  // Always true, output as the side effect. `-not -print` inverts
  // only the boolean (in evalOne) — the line is emitted either way.
  if (p.kind === 'print') return { matched: true, stdout: entry.path + '\n', stderr: '' }
  // `-print0` terminates with NUL instead of a newline, so paths
  // containing spaces survive a pipe into `xargs -0`.
  if (p.kind === 'print0') return { matched: true, stdout: entry.path + '\0', stderr: '' }
  if (p.kind === 'exec') return evalExec(p, entry, ctx)
}

function matchedOnly(b) { return { matched: b, stdout: '', stderr: '' } }

function evalExec(p, entry, ctx) {
  // `+` form treats the predicate as always-true and defers dispatch
  // to after the walk — see the post-walk loop in find().
  if (p.mode === 'batch') { p.collected.push(entry.path); return matchedOnly(true) }
  // `;` form: substitute every `{}` occurrence in each argument with
  // the entry path (GNU does in-arg replacement, not just standalone-
  // `{}` replacement), dispatch, and let the exit code drive the
  // predicate boolean. The exitCode does NOT propagate to find's
  // overall exit — find treats exec failures as predicate input only,
  // matching GNU.
  const args = p.args.map((a) => a.replaceAll('{}', entry.path))
  const r = ctx.dispatch(p.cmd, args, '')
  return { matched: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr }
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
