// Commands that navigate or query the virtual filesystem. `cd`
// is the only one that mutates `ctx.cwd`. Each command runs its
// tokens through parseArgs with a strict schema so unknown flags
// fail fast instead of being silently dropped.

import { joinPath, resolve } from './fs.js'
import { unsupported } from './unsupported.js'
import { find } from './find.js'
import { homeOf } from './expand.js'
import { parseArgs } from './parse.js'
import { err, ok, usage } from './util.js'

function pwd(_stdin, tokens, ctx) {
  parseArgs(tokens)
  return ok(ctx.cwd + '\n')
}

// `cd` alone goes home (the tree root here); `cd -` goes to `$OLDPWD`
// and prints that value, as bash does — the variable is the shell's,
// so an assignment or `unset` of it steers the next `cd -`, and a
// successful change sets it (and refreshes an assigned `PWD`). `cd ''`
// is a no-op. The failure messages are bash's, capitalized as bash
// prints them.
function cd(_stdin, tokens, ctx) {
  const { positional } = parseArgs(tokens)
  if (positional.length > 1) return err('cd: too many arguments')
  let target = positional[0] ?? homeOf(ctx)
  if (target === '-') {
    if (!ctx.vars.has('OLDPWD')) return err('cd: OLDPWD not set')
    target = ctx.vars.get('OLDPWD')
  }
  const printed = positional[0] === '-' ? target + '\n' : ''
  if (target === '') return ok(printed)
  const abs = resolve(ctx.cwd, target)
  if (!ctx.fs.isDir(abs)) return err(`cd: ${target}: ${ctx.fs.isFile(abs) ? 'Not a directory' : 'No such file or directory'}`)
  ctx.vars.set('OLDPWD', ctx.cwd)
  if (ctx.vars.has('PWD')) ctx.vars.set('PWD', abs)
  ctx.cwd = abs
  return ok(printed)
}

// Non-TTY ls: one name per line, lexical order, classification only
// with -F. Metadata cannot be fabricated by a path-to-content filesystem.
function ls(_stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['1', 'l', 'a', 'A', 'R', 'd', 'r', 'F'] })
  if (flags.has('l')) return unsupported('feature', 'ls', '-l metadata', 'ls: long listings require permissions, ownership and timestamps absent from this virtual filesystem')
  const targets = (positional.length ? positional : ['.']).toSorted()
  if (flags.has('r')) targets.reverse()
  const dirs = [], errors = [], files = []
  const display = (name, abs) => flags.has('F') && ctx.fs.isDir(abs) && !name.endsWith('/') ? name + '/' : name
  for (const target of targets) {
    const abs = resolve(ctx.cwd, target)
    if (!ctx.fs.isFile(abs) && !ctx.fs.isDir(abs)) errors.push(`ls: ${target}: no such file or directory`)
    else if (flags.has('d') || ctx.fs.isFile(abs)) files.push(display(target, abs))
    else dirs.push(target)
  }
  const blocks = files.length ? [files.join('\n')] : []
  for (const target of dirs) {
    const stack = [target]
    while (stack.length) {
      const path = stack.pop()
      const abs = resolve(ctx.cwd, path)
      const entries = ctx.fs.listDir(abs)
      const names = [...entries.dirs, ...entries.files].filter((n) => flags.has('a') || flags.has('A') || !n.startsWith('.'))
      if (flags.has('a')) names.push('.', '..')
      names.sort()
      if (flags.has('r')) names.reverse()
      const rows = names.map((n) => display(n, resolve(abs, n)))
      if (targets.length > 1 || flags.has('R')) rows.unshift(path + ':')
      blocks.push(rows.join('\n'))
      if (!flags.has('R')) continue
      for (const name of names.toReversed()) {
        if (name === '.' || name === '..' || !ctx.fs.isDir(resolve(abs, name))) continue
        stack.push(path.endsWith('/') ? path + name : path + '/' + name)
      }
    }
  }
  return { stdout: blocks.length ? blocks.join('\n\n') + '\n' : '', stderr: errors.length ? errors.join('\n') + '\n' : '', exitCode: errors.length ? 2 : 0 }
}

function tree(_stdin, tokens, ctx) {
  const { positional } = parseArgs(tokens)
  if (positional.length > 1) return unsupported('feature', 'tree', 'multiple roots', 'tree: multiple roots are not supported')
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
  if (positional.length > 2) return err(`basename: extra operand: ${positional[2]}`)
  const path = positional[0].replace(/\/+$/u, '')
  const name = path === '' ? (positional[0] === '' ? '' : '/') : path.slice(path.lastIndexOf('/') + 1)
  return ok(stripSuffix(name, positional[1]) + '\n')
}

function stripSuffix(name, suffix) {
  if (!suffix || suffix === name || !name.endsWith(suffix)) return name
  return name.slice(0, -suffix.length)
}

function dirnameCmd(_stdin, tokens) {
  const { positional } = parseArgs(tokens)
  if (positional.length === 0) return usage('dirname PATH')
  return ok(positional.map((p) => {
    const path = p.replace(/\/+$/u, '')
    const i = path.lastIndexOf('/')
    return i < 0 ? (p.startsWith('/') ? '/' : '.') : path.slice(0, i).replace(/\/+$/u, '') || '/'
  }).join('\n') + '\n')
}

export const NAV_COMMANDS = {
  pwd, cd, ls, find, tree, basename: basenameCmd, dirname: dirnameCmd,
}
