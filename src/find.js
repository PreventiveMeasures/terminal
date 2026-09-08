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
// new group; parentheses nest groups as a primary, and `-not` / `!`
// flips the next primary. `-mindepth` /
// `-maxdepth` are globally effective walker options that evaluate to
// true in the expression. They are parsed in place to preserve the
// interpretation of option-looking patterns and child arguments.
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
// the expression parser rather than going through primaryFor. The `;`
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

import { lookup, relativeTo, walkTree } from './fs.js'
import { parseFindArgs } from './find-parse.js'
import { unsupported } from './unsupported.js'

export function find(stdin, tokens, ctx) {
  const parsed = parseFindArgs(tokens)
  if (parsed.error) return parsed.error
  if (stdin !== '' && tokens.some((t) => t === '-exec' || t === '--exec')) return unsupported('feature', 'find', '-exec stdin', 'find: passing shared standard input to -exec is not supported')
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
    const { path: startAbs, error } = lookup(ctx.cwd, start, ctx.fs)
    if (error) {
      // GNU continues past a missing/unreadable start: surface the
      // error, leave exit non-zero, but keep walking the remaining
      // starts. Aborting early would drop earlier-walks' output —
      // which `find src nope` did until this fix.
      stderr += `find: ${start}: ${error.toLowerCase()}\n`
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

// Top-level evaluation: OR across groups, AND within. With no
// predicates at all (`find /`), the group holds just the implicit
// -print, so everything is reported. Returns {matched, stdout, stderr}:
// the expression's boolean also feeds enclosing groups. Printing is an
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
    if (groupMatched) return { matched: true, stdout, stderr }
  }
  return { matched: false, stdout, stderr }
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
  if (p.kind === 'group') return runPredicates(p.groups, entry, ctx)
  if (p.kind === 'true') return matchedOnly(true)
  if (p.kind === 'type') return matchedOnly(p.value.split(',').includes(entry.kind === 'file' ? 'f' : 'd'))
  if (p.kind === 'name' || p.kind === 'iname') return matchedOnly(p.re.test(entry.path.replace(/\/+$/u, '').split('/').at(-1) || '/'))
  // Always true. On a directory it also records the path so walkTree
  // skips the subtree; on a file it is a no-op that still reports true,
  // which is what makes `-name X -prune -o -print` exclude X itself.
  if (p.kind === 'prune') {
    if (entry.kind === 'dir') entry.prune.add(entry.abs)
    return matchedOnly(true)
  }
  // Derived directories contain files, but the root of an empty source
  // map is an existing empty directory and must match too.
  if (p.kind === 'empty') {
    if (entry.kind === 'file') return matchedOnly(ctx.fs.readFile(entry.abs) === '')
    const { dirs, files } = ctx.fs.listDir(entry.abs)
    return matchedOnly(dirs.length + files.length === 0)
  }
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
