import { compareNames, lookup } from '../fs.js'
import { globMatch } from '../glob.js'
import { compareFiles, joinName, report } from './diff.js'

// Two directories, entry by entry in byte order, the way GNU's dir.c merges
// its two sorted listings: a name in only one prints `Only in`, a pair of
// files is compared, a pair of directories is entered with -r and named
// without it. -N makes a missing entry an empty stand-in of the other's kind.
export function compareDirs(state, dirA, dirB) {
  const { ctx, opts } = state
  const names = mergeNames(entryNames(state, dirA), entryNames(state, dirB))
  for (const [name, inA, inB] of names) {
    const pathA = joinName(dirA, name), pathB = joinName(dirB, name)
    const kindA = inA ? entryKind(ctx, pathA) : null, kindB = inB ? entryKind(ctx, pathB) : null
    if (inA && inB) { comparePair(state, [pathA, pathB], [kindA, kindB]); continue }
    if (opts.newFile) compareStandIn(state, [pathA, pathB], kindA ?? kindB)
    else report(state, `Only in ${inA ? dirA : dirB}: ${name}\n`, 1)
  }
}

// A name in one directory only, with -N: the other side stands in empty.
function compareStandIn(state, [pathA, pathB], kind) {
  if (kind === 'file') compareFiles(state, pathA, pathB, true)
  else if (state.opts.recursive) compareDirs(state, pathA, pathB)
  else report(state, `Common subdirectories: ${pathA} and ${pathB}\n`)
}

function comparePair(state, [pathA, pathB], [kindA, kindB]) {
  const { opts } = state
  if (kindA === 'dir' && kindB === 'dir') {
    if (opts.recursive) compareDirs(state, pathA, pathB)
    else report(state, `Common subdirectories: ${pathA} and ${pathB}\n`)
  } else if (kindA === kindB) compareFiles(state, pathA, pathB, true)
  else {
    const shown = (i, path) => opts.labels[i] ?? path
    report(state, `File ${shown(0, pathA)} is a ${TYPE[kindA]} while file ${shown(1, pathB)} is a ${TYPE[kindB]}\n`, 1)
  }
}

const TYPE = { dir: 'directory', file: 'regular file' }

function entryKind(ctx, path) {
  const found = lookup(ctx.cwd, path, ctx.fs)
  return ctx.fs.isDir(found.path) ? 'dir' : 'file'
}

// Every entry, hidden ones included, sorted as C-locale strcmp sorts, less
// those an -x pattern names. A directory -N stands in for lists nothing.
function entryNames(state, dir) {
  const { ctx, opts } = state
  const found = lookup(ctx.cwd, dir, ctx.fs)
  if (found.error || !ctx.fs.isDir(found.path)) return []
  const { dirs, files } = ctx.fs.listDir(found.path)
  const names = [...dirs, ...files].sort(compareNames)
  return opts.excludes.length ? names.filter((name) => !opts.excludes.some((pattern) => globMatch(name, pattern))) : names
}

function mergeNames(a, b) {
  const out = []
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    const order = i === a.length ? 1 : j === b.length ? -1 : compareNames(a[i], b[j])
    if (order === 0) { out.push([a[i++], true, true]); j++ }
    else if (order < 0) out.push([a[i++], true, false])
    else out.push([b[j++], false, true])
  }
  return out
}
