import { compareNames, lookup } from '../fs.js'
import { UnsupportedError } from '../unsupported.js'
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
    if (opts.newFile) compareStandIn(state, [pathA, pathB], kindA ?? kindB, [inA, inB])
    else report(state, `Only in ${inA ? dirA : dirB}: ${name}\n`, 1)
  }
}

// A name in one directory only, with -N: the other side stands in empty. Which
// side that is goes with it, since a name the listing did have is one this
// still answers for — a link leading nowhere among them.
function compareStandIn(state, [pathA, pathB], kind, listed) {
  // The kind is the listed side's, and the stand-in is a name nothing holds:
  // a walk that refuses to cross a link names the side the link is on.
  if (isDir(kind)) {
    if (state.opts.recursive) enterDirs(state, [pathA, pathB], listed.map((held) => held ? kind : null))
    else report(state, `Common subdirectories: ${pathA} and ${pathB}\n`)
  } else compareFiles(state, pathA, pathB, true, listed)
}

function comparePair(state, [pathA, pathB], [kindA, kindB]) {
  const { opts } = state
  // A name a directory holds and cannot answer for is read rather than typed,
  // and GNU stops at that read: the side across from it is never opened,
  // which a directory would otherwise be reported missing for.
  const gone = [kindA, kindB].indexOf('gone')
  if (gone !== -1 && isDir([kindA, kindB][1 - gone])) {
    const path = [pathA, pathB][gone]
    return report(state, `diff: ${path}: ${lookup(state.ctx.cwd, path, state.ctx.fs).error}\n`, 2, true)
  }
  if (isDir(kindA) && isDir(kindB)) {
    if (opts.recursive) enterDirs(state, [pathA, pathB], [kindA, kindB])
    else report(state, `Common subdirectories: ${pathA} and ${pathB}\n`)
  } else if (kindA === kindB || gone !== -1) compareFiles(state, pathA, pathB, true, [true, true])
  else {
    const shown = (i, path) => opts.labels[i] ?? path
    report(state, `File ${shown(0, pathA)} is a ${TYPE[kindA]} while file ${shown(1, pathB)} is a ${TYPE[kindB]}\n`, 1)
  }
}

const TYPE = { dir: 'directory', link: 'directory', file: 'regular file' }

const isDir = (kind) => kind === 'dir' || kind === 'link'

// diff compares what a name leads to, as GNU does for an operand: a link to a
// file is that file, and a link to a directory that directory. Entering the
// tree a link names is the one thing left out — a link pointing above itself
// would enter the tree already being compared, which is the cycle GNU stops
// at and this does not model — so only a walk that would cross one refuses,
// and a name listed, named as a type or compared as a file never does.
function entryKind(ctx, path) {
  const found = lookup(ctx.cwd, path, ctx.fs)
  // A name the listing held and the filesystem cannot answer for — a link
  // leading nowhere, or one that loops — is none of the three types.
  if (found.error) return 'gone'
  if (!ctx.fs.isDir(found.path)) return 'file'
  return ctx.fs.isLink?.(lookup(ctx.cwd, path, ctx.fs, { follow: false }).path) ? 'link' : 'dir'
}

function enterDirs(state, [pathA, pathB], [kindA, kindB]) {
  for (const [kind, path] of [[kindA, pathA], [kindB, pathB]]) {
    if (kind !== 'link') continue
    throw new UnsupportedError('feature', 'symbolic link to a directory', `comparing what a symbolic link to a directory holds is not supported: ${path}`)
  }
  compareDirs(state, pathA, pathB)
}

// Every entry, hidden ones included, sorted as C-locale strcmp sorts, less
// those an -x pattern names. A directory -N stands in for lists nothing.
function entryNames(state, dir) {
  const { ctx, opts } = state
  const found = lookup(ctx.cwd, dir, ctx.fs)
  if (found.error || !ctx.fs.isDir(found.path)) return []
  const { dirs, files, links } = ctx.fs.listDir(found.path)
  const names = [...dirs, ...files, ...links].sort(compareNames)
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
