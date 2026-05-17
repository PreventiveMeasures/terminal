// Commands that navigate or query the virtual filesystem. `cd`
// is the only one that mutates `ctx.cwd`. Each command runs its
// tokens through parseArgs with a strict schema so unknown flags
// fail fast instead of being silently dropped.

import { basename as baseName, dirname as dirName, resolve } from './fs.js'
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
  const { flags, positional } = parseArgs(stripDashOne(tokens), { short: ['l', 'a'] })
  const opts = { long: flags.has('l'), all: flags.has('a') }
  const targets = positional.length > 0 ? positional : ['.']
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
  const lines = multiple ? [`${target}:`] : []
  const { dirs, files } = ctx.fs.listDir(abs)
  for (const name of dirs) {
    if (!opts.all && name.startsWith('.')) continue
    lines.push(formatLsRow(name, 0, true, opts.long))
  }
  for (const name of files) {
    if (!opts.all && name.startsWith('.')) continue
    const childAbs = abs === '/' ? '/' + name : abs + '/' + name
    lines.push(formatLsRow(name, ctx.fs.readFile(childAbs).length, false, opts.long))
  }
  return { lines }
}

function formatLsRow(name, size, isDir, long) {
  const display = name + (isDir ? '/' : '')
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
    const childDir = frame.dir === '/' ? '/' + n : frame.dir + '/' + n
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

function basenameCmd(_stdin, tokens) {
  const { positional } = parseArgs(tokens)
  if (positional.length === 0) return usage('basename PATH')
  return ok(baseName(positional[0]) + '\n')
}

function dirnameCmd(_stdin, tokens) {
  const { positional } = parseArgs(tokens)
  if (positional.length === 0) return usage('dirname PATH')
  return ok(dirName(positional[0]) + '\n')
}

export const NAV_COMMANDS = {
  pwd, cd, ls, find, tree, basename: basenameCmd, dirname: dirnameCmd,
}
