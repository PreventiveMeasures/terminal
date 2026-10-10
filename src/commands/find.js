// Predicates short-circuit as the tree the parser built them into has them;
// actions execute in place. -exec ';' uses child status only as its predicate
// result. Batched -exec '+' runs after traversal, is true as a predicate, and
// maps failures to find status 1.

import { relativeTo, walkTree } from '../fs.js'
import { BLOCK } from './du-options.js'
import { encodeUtf8 } from '../util.js'
import { parseFindArgs } from './find-parse.js'
import { markUnsupported, unsupported, unsupportedNote } from '../unsupported.js'
import { appendOutput, emptyOutput } from '../shell/output.js'
import { lookupWithNote, omissionNote } from '../notes.js'
import { quoteLocale } from './mkdir.js'
import { inOverlay } from '../writable.js'

const TYPE_LETTERS = { file: 'f', dir: 'd', link: 'l' }

// What `ls -l` and `du` report of an entry: a directory is a block of its
// own, a link is as long as the path it holds, and a file is its bytes.
const sizeOf = (entry, ctx) => (entry.kind === 'dir' ? BLOCK
  : ctx.fs.fileSize?.(entry.abs) ?? encodeUtf8(ctx.fs.readFile(entry.abs)).length)

// A walk whose own -exec keeps making directories for it to go into goes on
// for as long as there is room on the disk — `-exec mkdir -p {}/z \;` never
// runs out of names, and `-exec mkdir {}/a {}/b \;` doubles at every level
// long before PATH_MAX stops it — which no answer here can stand in for.
// GNU's own walk into a tree it grows is followed this far, which is past
// the deepest any one path can be built to: one directory a level until a
// name reaches PATH_MAX is some two thousand of them.
const GROWTH_LIMIT = 4096

export async function find(stdin, tokens, ctx) {
  const parsed = parseFindArgs(tokens, ctx)
  if (parsed.error) return parsed.error
  if (stdin !== '' && tokens.includes('-exec')) return unsupported('feature', 'find', '-exec stdin', 'find: passing shared standard input to -exec is not supported')
  const { starts, minDepth, maxDepth, deepestFirst, tree, batches } = parsed
  const result = emptyOutput()
  const omitted = new Set()
  // The newest inode before the walk began: a directory newer than it was
  // made by the walk itself.
  const before = ctx.fs.newestInode?.()
  let grown = 0
  try {
    for (const start of starts) {
      // find walks the names it is given, not what they point at: `-P` is its
      // default, so a link named as a root is the entry it reports.
      const { path: startAbs, error } = lookupWithNote(ctx, 'find', start, { follow: false })
      if (error) {
        // A bad root does not prevent traversal of the remaining roots.
        collectOutput(result, ctx.flushOutput(emptyOutput(`find: ${quoteLocale(start, ctx)}: ${error}\n`)))
        result.exitCode = 1
        continue
      }
      // walkTree consults pruning after evaluating the current entry.
      const pruned = new Set()
      const walk = walkTree(ctx.fs, startAbs, maxDepth, (path) => !pruned.has(path))
      for (const entry of deepestFirst ? deepestFirstOrder(walk) : walk) {
        const display = toDisplayPath(start, startAbs, entry.path)
        // A directory gone, or no longer one, by the time the walk went into
        // it is GNU's unreadable directory: said so, and passed over.
        if (entry.kind === 'unreadable') {
          collectOutput(result, ctx.flushOutput(emptyOutput(`find: ${quoteLocale(display, ctx)}: ${entry.error}\n`)))
          result.exitCode = 1
          continue
        }
        if (entry.kind === 'dir' && before !== undefined && inOverlay(entry.path) && ctx.fs.inode(entry.path) > before && ++grown > GROWTH_LIMIT) {
          const message = `find: a walk into more than ${GROWTH_LIMIT} directories its own actions made is not supported`
          appendOutput(result, ctx.flushOutput(emptyOutput(message + '\n')))
          result.exitCode = 1
          return markUnsupported(result, 'feature', 'find', 'self-growing walk', message)
        }
        if (entry.depth >= minDepth) {
          // oxlint-disable-next-line no-await-in-loop -- an entry is tested after the one the walk reached before it.
          await evaluate(tree, { kind: entry.kind, path: display, abs: entry.path, prune: pruned }, ctx, result)
        }
        if (entry.kind !== 'dir' || entry.depth !== maxDepth || pruned.has(entry.path) || !ctx.fs.isDir(entry.path)) continue
        // Named the way the walk that stopped there would have printed it: a
        // caller reading the note is reading it beside `find`'s own output, and
        // an absolute path is not a name they wrote. Two starts reaching one
        // directory report it twice, under each spelling, as find prints it twice.
        if (holdsAnything(ctx, entry.path)) omitted.add(display)
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

// The operators as GNU evaluates them: `-a` and `-o` read their right side
// only where the left side leaves the answer open, `,` reads both and answers
// with the right, and `!` turns its operand's answer around. Action output
// stays, whatever the entry finally answers.
async function evaluate(node, entry, ctx, result) {
  if (node.type === 'not') return !await evaluate(node.operand, entry, ctx, result)
  if (node.type === 'binary') {
    // A predicate may run a command, which may wait; the one to its right is
    // read only where this one let it be, so it waits for it.
    const left = await evaluate(node.left, entry, ctx, result)
    if (node.op === 'and' && !left) return false
    if (node.op === 'or' && left) return true
    return evaluate(node.right, entry, ctx, result)
  }
  return evalPredicate(node, entry, ctx, result)
}

function evalPredicate(p, entry, ctx, result) {
  if (p.kind === 'true') return true
  if (p.kind === 'false') return false
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
    const size = BigInt(sizeOf(entry, ctx))
    const units = (size + p.unit - 1n) / p.unit
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

// Whether a directory the walk stopped at holds anything, for the note's
// sake alone: find never reads it, so one a kept mode closes (writable.js)
// is left out of the note rather than refusing the run over it.
function holdsAnything(ctx, dir) {
  try {
    const { dirs, files, links } = ctx.fs.listDir(dir)
    return dirs.length + files.length + links.length > 0
  } catch (e) {
    if (!unsupportedNote(e)) throw e
    return false
  }
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
