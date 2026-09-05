// Commands that navigate or query the virtual filesystem. `cd`
// is the only one that mutates `ctx.cwd`. Each command runs its
// tokens through parseArgs with a strict schema so unknown flags
// fail fast instead of being silently dropped.

import { basename as baseName, dirname as dirName, joinPath, resolve } from './fs.js'
import { find } from './find.js'
import { parseArgs } from './parse.js'
import { err, ok, usage } from './util.js'

function pwd(_stdin, tokens, ctx) {
  parseArgs(tokens)
  return ok(ctx.cwd + '\n')
}

function cd(_stdin, tokens, ctx) {
  const { positional } = parseArgs(tokens)
  const target = positional[0] ?? '/'
  const abs = resolve(ctx.cwd, target)
  if (!ctx.fs.isDir(abs)) return err(`cd: not a directory: ${target}`)
  ctx.cwd = abs
  return ok()
}

function ls(_stdin, tokens, ctx) {
  // `-1` (force one-per-line) is accepted but a no-op today: ls
  // already emits one entry per line because the virtual terminal
  // has no TTY notion, so there's no multi-column mode to switch
  // out of. We still accept the flag so scripts that defensively
  // prefix `-1` (in case a future ls grows table output) keep
  // working unchanged.
  //
  // parseArgs's `^-\d/` guard (which keeps `head -5` shorthand
  // working) treats `-1` and `-1a` as positionals, so peel the
  // `1` out of the token list before parsing — `-1`, `-1a`, `-a1`,
  // and `-la1` all reach the schema cleanly that way.
  // `-F` joins `-1` as an accepted no-op: this ls already appends `/`
  // to every directory unconditionally, which is the whole of what -F
  // can mean here (there are no executables or symlinks in the virtual
  // FS to earn a `*` or `@`). `-t` and `-S` are deliberately NOT
  // accepted: the FS stores only path→content, so there are no
  // modification times to sort by at all, and a wrong order is worse
  // than an unknown-option error.
  const { flags, positional } = parseArgs(stripDashOne(tokens), { short: ['l', 'a', 'A', 'R', 'd', 'r', 'F'] })
  const opts = {
    long: flags.has('l'),
    // `-A` is `-a` minus the `.` and `..` entries.
    all: flags.has('a') || flags.has('A'),
    dots: flags.has('a'),
    recursive: flags.has('R'),
    dirOnly: flags.has('d'),
    reverse: flags.has('r'),
  }
  // `-d` lists the directory itself rather than its contents, so there
  // is nothing to recurse into.
  if (opts.dirOnly) return lsDirsThemselves(positional, opts, ctx)
  const initialTargets = positional.length > 0 ? positional : ['.']
  // -R expands each directory target into a DFS pre-order walk of
  // itself + every subdir (matching GNU's listing order: list a dir,
  // then descend in sorted order). File targets pass through unchanged
  // — GNU's -R doesn't dereference files, just directories.
  const targets = opts.recursive ? expandRecursive(initialTargets, opts.all, ctx, opts.reverse) : initialTargets
  const out = []
  const errs = []
  let exitCode = 0
  for (let i = 0; i < targets.length; i++) {
    const r = lsTarget(targets[i], targets.length > 1, opts, ctx)
    // Per-target "no such file" lines belong on stderr — every other
    // command in this module routes diagnostics through err()
    // /stderr, and mixing them into stdout pollutes the next stage
    // when ls is piped (e.g. `ls foo bar | grep ...`).
    if (r.error) { exitCode = 1; errs.push(r.error); continue }
    if (i > 0 && targets.length > 1) out.push('')
    out.push(...r.lines)
  }
  return {
    stdout: out.length === 0 ? '' : out.join('\n') + '\n',
    stderr: errs.length === 0 ? '' : errs.join('\n') + '\n',
    exitCode,
  }
}

// DFS pre-order expansion of directory targets for `-R`. Iterative
// (explicit stack) rather than recursive, matching treeWalk below —
// a pathologically deep bundle would otherwise risk a stack overflow.
// `dirs` from listDir is already sorted, so push-in-reverse / pop
// yields sorted DFS order. The fs has no symlinks, so no cycle guard
// is needed. Hidden-dir skipping mirrors lsTarget so descent into
// `.git` (etc.) is gated by -a, just like the flat listing.
function expandRecursive(targets, all, ctx, reverse = false) {
  const out = []
  for (const t of targets) {
    const abs = resolve(ctx.cwd, t)
    if (!ctx.fs.isDir(abs)) { out.push(t); continue }
    const stack = [{ display: t, abs }]
    while (stack.length > 0) {
      const { display, abs: cur } = stack.pop()
      out.push(display)
      const { dirs } = ctx.fs.listDir(cur)
      // Push in reverse so pop yields sorted DFS order — and push in
      // FORWARD order under `-r`, so the walk descends in the same
      // reversed order the listing itself uses. Without this, `-r`
      // reversed every directory's contents but still visited the
      // subdirectories ascending, so the `dir:` sections came out in
      // the opposite order to the entries that named them.
      const walk = reverse ? dirs : dirs.toReversed()
      for (const d of walk) {
        if (!all && d.startsWith('.')) continue
        stack.push({ display: appendChild(display, d), abs: joinPath(cur, d) })
      }
    }
  }
  return out
}

// Mirror grep's displayName trailing-slash handling so `ls -R foo/`
// produces `foo/sub` (not `foo//sub`) without normalizing away the
// user-typed prefix in unrelated cases.
function appendChild(path, name) {
  return path.endsWith('/') ? path + name : path + '/' + name
}

// Drop the POSIX `-1` flag from a token list before parseArgs sees
// it. Handles three shapes:
//   `-1`         standalone → removed
//   `-1<rest>`   leading-1 bundle → `-<rest>` (parseArgs's `^-\d`
//                guard would otherwise classify it as positional)
//   `-<rest>1<rest>` non-leading-1 bundle → strip the `1` in place
// Only MIXED bundles (letters + digits) get their `1` stripped —
// pure-digit tokens like `-10` stay positional, matching how
// parseArgs treats `head -5` shorthand. `--` ends the strip so a
// literal `-1` filename after the terminator survives.
function stripDashOne(tokens) {
  const out = []
  let afterTerminator = false
  for (const t of tokens) {
    if (afterTerminator) { out.push(t); continue }
    if (t === '--') { out.push(t); afterTerminator = true; continue }
    if (t === '-1') continue
    if (/^-[a-zA-Z0-9]+$/u.test(t) && t.includes('1') && /[a-zA-Z]/u.test(t)) {
      out.push('-' + t.slice(1).replaceAll('1', ''))
      continue
    }
    out.push(t)
  }
  return out
}

function lsTarget(target, multiple, opts, ctx) {
  const abs = resolve(ctx.cwd, target)
  if (ctx.fs.isFile(abs)) {
    return { lines: [formatLsRow(target, ctx.fs.readFile(abs).length, false, opts.long)] }
  }
  if (!ctx.fs.isDir(abs)) return { error: `ls: ${target}: no such file or directory` }
  // -R always labels each directory in the walk — even a single root
  // with no subdirs (GNU does the same). Files keep their header-free
  // treatment above; only the dir branch forces the prefix.
  const lines = (multiple || opts.recursive) ? [`${target}:`] : []
  // `-a` prepends `.` and `..` (matching GNU). Emitted first rather
  // than slot-and-resort because every realistic filename in this
  // virtual FS — repo source paths — sorts after `.` (0x2E) anyway.
  // (A truly GNU-faithful sort would put `+foo`/`!foo`-style names
  // before the dots; we don't see those in code repos.) The trailing
  // `/` that formatLsRow appends to real dirs is suppressed for
  // these — GNU prints them bare, and they're navigation handles
  // rather than browsable subtrees.
  if (opts.dots) {
    lines.push(formatDotEntry('.', opts.long))
    lines.push(formatDotEntry('..', opts.long))
  }
  const { dirs, files } = ctx.fs.listDir(abs)
  for (const name of dirs) {
    if (!opts.all && name.startsWith('.')) continue
    lines.push(formatLsRow(name, 0, true, opts.long))
  }
  for (const name of files) {
    if (!opts.all && name.startsWith('.')) continue
    const childAbs = joinPath(abs, name)
    lines.push(formatLsRow(name, ctx.fs.readFile(childAbs).length, false, opts.long))
  }
  // `-r` reverses the listing this ls produced — including its
  // dirs-before-files grouping, since that grouping IS the sort order
  // here. The `dir:` header, when present, stays on top.
  if (opts.reverse) {
    const header = lines.length > 0 && (multiple || opts.recursive) ? lines.slice(0, 1) : []
    return { lines: [...header, ...lines.slice(header.length).toReversed()] }
  }
  return { lines }
}

// `-d`: name each operand itself instead of listing what is inside it.
// A directory still gets its trailing `/`, and a missing path is still
// an error, but nothing is walked.
function lsDirsThemselves(positional, opts, ctx) {
  const targets = positional.length > 0 ? positional : ['.']
  const out = []
  const errs = []
  for (const target of targets) {
    const abs = resolve(ctx.cwd, target)
    // `.` and `..` print bare, the same rule `-a` already follows for
    // them: they are navigation handles, not browsable subtrees, so
    // they skip the trailing `/` this ls gives real directories.
    if (ctx.fs.isDir(abs)) {
      out.push(target === '.' || target === '..'
        ? formatDotEntry(target, opts.long)
        : formatLsRow(target, 0, true, opts.long))
    }
    else if (ctx.fs.isFile(abs)) out.push(formatLsRow(target, ctx.fs.readFile(abs).length, false, opts.long))
    else errs.push(`ls: ${target}: no such file or directory`)
  }
  const rows = opts.reverse ? out.toReversed() : out
  return {
    stdout: rows.length === 0 ? '' : rows.join('\n') + '\n',
    stderr: errs.length === 0 ? '' : errs.join('\n') + '\n',
    exitCode: errs.length === 0 ? 0 : 1,
  }
}

// `.` / `..` rows under -a: marked as directories in long form (so
// the leading `d` is right), but printed bare in the name column —
// no trailing `/`, matching GNU's `-a` output.
function formatDotEntry(name, long) {
  if (!long) return name
  return `d ${String(0).padStart(8)}  ${name}`
}

function formatLsRow(name, size, isDir, long) {
  // Directory rows get a trailing `/`, but only one: under `-d` the
  // name is the operand as the user typed it, and `ls -d src/` already
  // ends in a slash. Appending unconditionally printed `src//`.
  const display = isDir && !name.endsWith('/') ? name + '/' : name
  if (!long) return display
  return `${isDir ? 'd' : '-'} ${String(size).padStart(8)}  ${display}`
}

function tree(_stdin, tokens, ctx) {
  const { positional } = parseArgs(tokens)
  const start = positional[0] ?? '.'
  const startAbs = resolve(ctx.cwd, start)
  if (!ctx.fs.isDir(startAbs)) return err(`tree: ${start}: not a directory`)
  const out = [start]
  treeWalk(ctx.fs, startAbs, out)
  return ok(out.join('\n') + '\n')
}

// Iterative pre-order walk via an explicit frame stack. Matches the
// shape a naive recursive walk would produce, but stays safe on
// bundles with thousands of nested segments — the recursive form
// could overflow the JS call stack the same way `ensureDir` did
// before its iterative rewrite.
function treeWalk(fs, root, out) {
  const stack = [{ dir: root, prefix: '', items: dirItemsFor(fs, root), i: 0 }]
  while (stack.length > 0) {
    const frame = stack.at(-1)
    if (frame.i >= frame.items.length) { stack.pop(); continue }
    const { n, isDir } = frame.items[frame.i]
    const last = frame.i === frame.items.length - 1
    out.push(frame.prefix + (last ? '└── ' : '├── ') + n + (isDir ? '/' : ''))
    frame.i++
    if (!isDir) continue
    const childDir = joinPath(frame.dir, n)
    stack.push({
      dir: childDir,
      prefix: frame.prefix + (last ? '    ' : '│   '),
      items: dirItemsFor(fs, childDir),
      i: 0,
    })
  }
}

function dirItemsFor(fs, dir) {
  const { dirs, files } = fs.listDir(dir)
  return [
    ...dirs.map((n) => ({ n, isDir: true })),
    ...files.map((n) => ({ n, isDir: false })),
  ]
}

// `basename PATH [SUFFIX]` strips SUFFIX from the end of the result, the
// form behind idioms like `basename "$f" .js`. Two rules keep it from
// eating more than it should: the suffix must actually match the tail of
// the name, and it must not BE the whole name — GNU leaves `basename
// c.js c.js` as `c.js` rather than yielding an empty string.
function basenameCmd(_stdin, tokens) {
  const { positional } = parseArgs(tokens)
  if (positional.length === 0) return usage('basename PATH [SUFFIX]')
  return ok(stripSuffix(baseName(positional[0]), positional[1]) + '\n')
}

function stripSuffix(name, suffix) {
  if (!suffix || suffix === name || !name.endsWith(suffix)) return name
  return name.slice(0, -suffix.length)
}

function dirnameCmd(_stdin, tokens) {
  const { positional } = parseArgs(tokens)
  if (positional.length === 0) return usage('dirname PATH')
  return ok(dirName(positional[0]) + '\n')
}

export const NAV_COMMANDS = {
  pwd, cd, ls, find, tree, basename: basenameCmd, dirname: dirnameCmd,
}
