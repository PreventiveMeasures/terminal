// Predicates short-circuit in OR groups of AND terms; actions execute in place.
// -exec ';' uses child status only as its predicate result. Batched -exec '+'
// runs after traversal, is true as a predicate, and maps failures to find status 1.
// Double-dash predicate spellings are local extensions, not GNU find syntax.

import { relativeTo, walkTree } from '../fs.js'
import { BLOCK } from './du-options.js'
import { encodeUtf8 } from '../util.js'
import { parseFindArgs } from './find-parse.js'
import { unsupported } from '../unsupported.js'
import { appendOutput, emptyOutput } from '../shell/output.js'
import { lookupWithNote, omissionNote } from '../notes.js'

const TYPE_LETTERS = { file: 'f', dir: 'd', link: 'l' }

// What `ls -l` and `du` report of an entry: a directory is a block of its
// own, a link is as long as the path it holds, and a file is its bytes.
const sizeOf = (entry, ctx) => (entry.kind === 'dir' ? BLOCK
  : ctx.fs.fileSize?.(entry.abs) ?? encodeUtf8(ctx.fs.readFile(entry.abs)).length)

export async function find(stdin, tokens, ctx) {
  const parsed = parseFindArgs(tokens)
  if (parsed.error) return parsed.error
  if (stdin !== '' && tokens.some((t) => t === '-exec' || t === '--exec')) return unsupported('feature', 'find', '-exec stdin', 'find: passing shared standard input to -exec is not supported')
  const { starts, minDepth, maxDepth, deepestFirst, groups, batches } = parsed
  const result = emptyOutput()
  const omitted = new Set()
  try {
    for (const start of starts) {
      // find walks the names it is given, not what they point at: `-P` is its
      // default, so a link named as a root is the entry it reports.
      const { path: startAbs, error } = lookupWithNote(ctx, 'find', start, { follow: false })
      if (error) {
        // A bad root does not prevent traversal of the remaining roots.
        collectOutput(result, ctx.flushOutput(emptyOutput(`find: '${start}': ${error}\n`)))
        result.exitCode = 1
        continue
      }
      // walkTree consults pruning after evaluating the current entry.
      const pruned = new Set()
      const walk = walkTree(ctx.fs, startAbs, maxDepth, (path) => !pruned.has(path))
      for (const entry of deepestFirst ? deepestFirstOrder(walk) : walk) {
        const display = toDisplayPath(start, startAbs, entry.path)
        if (entry.depth >= minDepth) {
          // oxlint-disable-next-line no-await-in-loop -- an entry is tested after the one the walk reached before it.
          await runPredicates(groups, { kind: entry.kind, path: display, abs: entry.path, prune: pruned }, ctx, result)
        }
        if (entry.kind !== 'dir' || entry.depth !== maxDepth || pruned.has(entry.path)) continue
        const { dirs, files, links } = ctx.fs.listDir(entry.path)
        // Named the way the walk that stopped there would have printed it: a
        // caller reading the note is reading it beside `find`'s own output, and
        // an absolute path is not a name they wrote. Two starts reaching one
        // directory report it twice, under each spelling, as find prints it twice.
        if (dirs.length || files.length || links.length) omitted.add(display)
      }
    }
    // Do not dispatch empty batches. Any failed batch makes find exit 1.
    for (const pred of batches) {
      if (pred.collected.length === 0) continue
      const finalArgs = pred.args.slice(0, -1).concat(pred.collected)
      // oxlint-disable-next-line no-await-in-loop -- one batch after the last, as find runs them.
      if (!await runExec(pred.cmd, finalArgs, ctx, result)) result.exitCode = 1
    }
  } finally {
    omissionNote(ctx.notes, { command: 'find', action: 'depth limit omitted contents of', noun: ['directory', 'directories'], paths: omitted })
  }
  return result
}

// `-depth` turns the walk inside out: what a directory holds is reached
// before the directory is, and a starting point is the last thing reached.
// Nothing is read until the whole walk is, so `-prune` has nothing left to
// prune — which is what GNU says of the two of them together.
function* deepestFirstOrder(entries) {
  const open = []
  for (const entry of entries) {
    while (open.length > 0 && open.at(-1).depth >= entry.depth) yield open.pop()
    if (entry.kind === 'dir') open.push(entry)
    else yield entry
  }
  while (open.length > 0) yield open.pop()
}

// Preserve action output even when negation or a later predicate rejects
// the entry. Stop at the first matching OR group to avoid repeating actions.
async function runPredicates(groups, entry, ctx, result) {
  for (const group of groups) {
    let all = true
    for (const p of group) {
      // A predicate may run a command, which may wait; the one to its right
      // is read only where this one let it be, so it waits for it.
      // oxlint-disable-next-line no-await-in-loop -- a predicate is read only where the one to its left passed.
      if (await evalPredicate(p, entry, ctx, result) === Boolean(p.negate)) { all = false; break }
    }
    if (all) return true
  }
  return false
}

function evalPredicate(p, entry, ctx, result) {
  if (p.kind === 'group') return runPredicates(p.groups, entry, ctx, result)
  if (p.kind === 'true') return true
  if (p.kind === 'type') return p.types.includes(TYPE_LETTERS[entry.kind])
  if (p.kind === 'name' || p.kind === 'iname') return p.re.test(entry.path.replace(/\/+$/u, '').split('/').at(-1) || '/')
  if (p.kind === 'prune') {
    if (entry.kind === 'dir') entry.prune.add(entry.abs)
    return true
  }
  // The root of an empty source map is an existing empty directory. A link is
  // neither of the two things GNU calls empty, whatever it points at.
  if (p.kind === 'empty') {
    if (entry.kind === 'link') return false
    // An empty file is one holding nothing, which the filesystem answers
    // without reading it: a file of bytes has none to read as text, and a
    // file of text is not encoded to be weighed.
    if (entry.kind === 'file') return ctx.fs.isEmptyFile(entry.abs)
    const { dirs, files, links } = ctx.fs.listDir(entry.abs)
    return dirs.length + files.length + links.length === 0
  }
  if (p.kind === 'path' || p.kind === 'ipath') return p.re.test(entry.path)
  // A link's own name is one thing and what it holds is another: `-lname`
  // asks about the second, and nothing that is not a link holds anything.
  if (p.kind === 'lname' || p.kind === 'ilname') return entry.kind === 'link' && p.re.test(ctx.fs.readLink?.(entry.abs) ?? '')
  if (p.kind === 'size') {
    const units = Math.ceil(sizeOf(entry, ctx) / p.unit)
    return p.sign === '+' ? units > p.count : p.sign === '-' ? units < p.count : units === p.count
  }
  if (p.kind === 'print' || p.kind === 'print0') {
    collectOutput(result, ctx.flushOutput({ stdout: entry.path + (p.kind === 'print' ? '\n' : '\0'), stderr: '', exitCode: 0 }))
    return true
  }
  // Batched exec is true during traversal; its eventual status belongs to find.
  if (p.mode === 'batch') { p.collected.push(entry.path); return true }
  return runExec(p.cmd, p.args.map((arg) => arg.replaceAll('{}', entry.path)), ctx, result)
}

async function runExec(cmd, args, ctx, result) {
  const r = await ctx.dispatch(cmd, args, '')
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
