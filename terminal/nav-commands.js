// Commands that navigate or query the virtual filesystem. `cd`
// is the only one that mutates `ctx.cwd`. Each command runs its
// tokens through parseArgs with a strict schema so unknown flags
// fail fast instead of being silently dropped.

import { basename as baseName, dirname as dirName, resolve } from './fs.js'
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
  const { flags, positional } = parseArgs(tokens, { short: ['l', 'a'] })
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

function find(_stdin, tokens, ctx) {
  const { values, positional } = parseArgs(tokens, { valueLong: ['name', 'type'] })
  const start = positional[0] ?? '.'
  const startAbs = resolve(ctx.cwd, start)
  if (!ctx.fs.isDir(startAbs) && !ctx.fs.isFile(startAbs)) {
    return err(`find: ${start}: no such file or directory`)
  }
  const typeFilter = values.get('type')
  if (typeFilter !== undefined && typeFilter !== 'f' && typeFilter !== 'd') {
    return err(`find: --type expects 'f' or 'd', got: ${typeFilter}`)
  }
  const namePattern = values.get('name')
  const out = []
  for (const entry of walkAll(ctx.fs, startAbs)) {
    if (typeFilter === 'f' && entry.kind !== 'file') continue
    if (typeFilter === 'd' && entry.kind !== 'dir') continue
    if (namePattern && !globMatch(baseName(entry.path), namePattern)) continue
    out.push(entry.path)
  }
  return ok(out.length === 0 ? '' : out.join('\n') + '\n')
}

function* walkAll(fs, root) {
  if (fs.isFile(root)) { yield { path: root, kind: 'file' }; return }
  yield { path: root, kind: 'dir' }
  // Index pointer instead of Array.shift() — shift() is O(n) per
  // call because it reindexes the rest of the array, making BFS
  // O(n²) on large trees.
  const queue = [root]
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]
    const { dirs, files } = fs.listDir(cur)
    for (const d of dirs) {
      const path = cur === '/' ? '/' + d : cur + '/' + d
      yield { path, kind: 'dir' }
      queue.push(path)
    }
    for (const f of files) {
      yield { path: cur === '/' ? '/' + f : cur + '/' + f, kind: 'file' }
    }
  }
}

// Tiny basename glob matcher: `*` (any chars), `?` (any single char).
// No braces / character classes — kept small. Used by `find --name`.
function globMatch(name, pattern) {
  const re = new RegExp('^' + pattern
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*/gu, '.*')
    .replace(/\?/gu, '.') + '$', 'u')
  return re.test(name)
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
  if (positional.length === 0) return usage('basename', 'basename PATH')
  return ok(baseName(positional[0]) + '\n')
}

function dirnameCmd(_stdin, tokens) {
  const { positional } = parseArgs(tokens)
  if (positional.length === 0) return usage('dirname', 'dirname PATH')
  return ok(dirName(positional[0]) + '\n')
}

export const NAV_COMMANDS = {
  pwd, cd, ls, find, tree, basename: basenameCmd, dirname: dirnameCmd,
}
