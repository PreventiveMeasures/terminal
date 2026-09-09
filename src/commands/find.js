// Predicates short-circuit in OR groups of AND terms; actions execute in place.
// -exec ';' uses child status only as its predicate result. Batched -exec '+'
// runs after traversal, is true as a predicate, and maps failures to find status 1.
// Double-dash predicate spellings are local extensions, not GNU find syntax.

import { lookup, relativeTo, walkTree } from '../fs.js'
import { parseFindArgs } from './find-parse.js'
import { unsupported } from '../unsupported.js'
import { appendOutput, emptyOutput } from '../shell/output.js'

export function find(stdin, tokens, ctx) {
  const parsed = parseFindArgs(tokens)
  if (parsed.error) return parsed.error
  if (stdin !== '' && tokens.some((t) => t === '-exec' || t === '--exec')) return unsupported('feature', 'find', '-exec stdin', 'find: passing shared standard input to -exec is not supported')
  const { starts, minDepth, maxDepth, groups, batches } = parsed
  const result = emptyOutput()
  for (const start of starts) {
    const { path: startAbs, error } = lookup(ctx.cwd, start, ctx.fs)
    if (error) {
      // A bad root does not prevent traversal of the remaining roots.
      collectOutput(result, ctx.flushOutput(emptyOutput(`find: ${start}: ${error.toLowerCase()}\n`)))
      result.exitCode = 1
      continue
    }
    // walkTree consults pruning after evaluating the current entry.
    const pruned = new Set()
    for (const entry of walkTree(ctx.fs, startAbs, maxDepth, (path) => !pruned.has(path))) {
      if (entry.depth < minDepth) continue
      const display = toDisplayPath(start, startAbs, entry.path)
      runPredicates(groups, { kind: entry.kind, path: display, abs: entry.path, prune: pruned }, ctx, result)
    }
  }
  // Do not dispatch empty batches. Any failed batch makes find exit 1.
  for (const pred of batches) {
    if (pred.collected.length === 0) continue
    const finalArgs = pred.args.slice(0, -1).concat(pred.collected)
    if (!runExec(pred.cmd, finalArgs, ctx, result)) result.exitCode = 1
  }
  return result
}

// Preserve action output even when negation or a later predicate rejects
// the entry. Stop at the first matching OR group to avoid repeating actions.
function runPredicates(groups, entry, ctx, result) {
  return groups.some((group) => group.every((p) => evalPredicate(p, entry, ctx, result) !== Boolean(p.negate)))
}

function evalPredicate(p, entry, ctx, result) {
  if (p.kind === 'group') return runPredicates(p.groups, entry, ctx, result)
  if (p.kind === 'true') return true
  if (p.kind === 'type') return p.types.includes(entry.kind === 'file' ? 'f' : 'd')
  if (p.kind === 'name' || p.kind === 'iname') return p.re.test(entry.path.replace(/\/+$/u, '').split('/').at(-1) || '/')
  if (p.kind === 'prune') {
    if (entry.kind === 'dir') entry.prune.add(entry.abs)
    return true
  }
  // The root of an empty source map is an existing empty directory.
  if (p.kind === 'empty') {
    if (entry.kind === 'file') return ctx.fs.readFile(entry.abs) === ''
    const { dirs, files } = ctx.fs.listDir(entry.abs)
    return dirs.length + files.length === 0
  }
  if (p.kind === 'path' || p.kind === 'ipath') return p.re.test(entry.path)
  if (p.kind === 'print' || p.kind === 'print0') {
    collectOutput(result, ctx.flushOutput({ stdout: entry.path + (p.kind === 'print' ? '\n' : '\0'), stderr: '', exitCode: 0 }))
    return true
  }
  // Batched exec is true during traversal; its eventual status belongs to find.
  if (p.mode === 'batch') { p.collected.push(entry.path); return true }
  return runExec(p.cmd, p.args.map((arg) => arg.replaceAll('{}', entry.path)), ctx, result)
}

function runExec(cmd, args, ctx, result) {
  const r = ctx.dispatch(cmd, args, '')
  collectOutput(result, r)
  return r.exitCode === 0
}

function collectOutput(result, next) {
  const status = result.exitCode
  appendOutput(result, next)
  result.exitCode = status
}

function toDisplayPath(userPath, absRoot, absPath) {
  if (absPath === absRoot) return userPath
  const rel = relativeTo(absRoot, absPath)
  // Preserve the starting path's spelling, including ./ and repeated slashes.
  return userPath.endsWith('/') ? userPath + rel : userPath + '/' + rel
}
