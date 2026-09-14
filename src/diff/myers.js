// The linear-space Myers difference algorithm, as GNU diff runs it: a
// middle snake found by searching forward from the start and backward from
// the end at once, then the two halves either side of it, so the work is
// O((N+M)·D) in time and O(N+M) in space. Lines are interned to integers
// first, so the inner loops compare numbers, never strings.
//
// What comes out is a change set: blocks of `a` replaced by blocks of `b`.
// Before any caller sees it, the change set is replayed against `a` and the
// result compared with `b`, line by line. A change set that fails that check
// is never returned, whatever the search did — the guarantee is on the data,
// not on how it was found.

// GNU's cutoff: past this many edit steps in one subproblem, split at the
// furthest point reached rather than keep searching for the minimum. The
// result is still a valid change set, just not always the shortest one.
// `--minimal` turns it off.
function costLimit(total) {
  let limit = 1
  for (let i = total; i !== 0; i >>= 2) limit <<= 1
  return Math.max(256, limit)
}

// `key` maps a line to what it is compared by (case folded, whitespace
// squeezed, …); lines with equal keys are equal. Identity when omitted.
export function diffLines(a, b, { key = null, minimal = false } = {}) {
  const { A, B } = intern(a, b, key)
  const changedA = new Uint8Array(A.length)
  const changedB = new Uint8Array(B.length)
  compareSequences(A, B, changedA, changedB, minimal)
  const blocks = collectBlocks(changedA, changedB)
  verifyChangeSet(a, b, blocks, key)
  return blocks
}

// Whether two line arrays are equal under the comparison, without a search.
export function sameLines(a, b, key = null) {
  if (a.length !== b.length) return false
  const equal = key ? (x, y) => key(x) === key(y) : (x, y) => x === y
  for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false
  return true
}

function intern(a, b, key) {
  const ids = new Map()
  const assign = (line) => {
    const k = key ? key(line) : line
    let id = ids.get(k)
    if (id === undefined) { id = ids.size; ids.set(k, id) }
    return id
  }
  const A = new Int32Array(a.length)
  const B = new Int32Array(b.length)
  for (let i = 0; i < a.length; i++) A[i] = assign(a[i])
  for (let i = 0; i < b.length; i++) B[i] = assign(b[i])
  return { A, B }
}

// Explicit stack rather than recursion: the cutoff can split unevenly, and
// nothing about the depth should depend on the input.
function compareSequences(A, B, changedA, changedB, minimal) {
  const diagonals = A.length + B.length + 3
  // Diagonal d = x - y ranges over [-M-1, N+1]; offset it into the arrays.
  const search = { A, B, fd: new Int32Array(diagonals), bd: new Int32Array(diagonals), base: B.length + 1, limit: costLimit(A.length + B.length) }
  const stack = [{ xoff: 0, xlim: A.length, yoff: 0, ylim: B.length, minimal }]
  const part = { xmid: 0, ymid: 0, loMinimal: false, hiMinimal: false }
  while (stack.length) {
    let { xoff, xlim, yoff, ylim, minimal: findMinimal } = stack.pop()
    while (xoff < xlim && yoff < ylim && A[xoff] === B[yoff]) { xoff++; yoff++ }
    while (xoff < xlim && yoff < ylim && A[xlim - 1] === B[ylim - 1]) { xlim--; ylim-- }
    if (xoff === xlim) { for (; yoff < ylim; yoff++) changedB[yoff] = 1; continue }
    if (yoff === ylim) { for (; xoff < xlim; xoff++) changedA[xoff] = 1; continue }
    middleSnake(search, xoff, xlim, yoff, ylim, findMinimal, part)
    // The right half is pushed first so the left half is taken next: blocks
    // are then noted in order, and the final collection is a single pass.
    stack.push({ xoff: part.xmid, xlim, yoff: part.ymid, ylim, minimal: part.hiMinimal })
    stack.push({ xoff, xlim: part.xmid, yoff, ylim: part.ymid, minimal: part.loMinimal })
  }
}

// GNU diffseq.h's diag(): a point on some shortest path (or, past the cost
// limit, the furthest point either search has reached) splitting the
// problem in two. Diagonals are absolute, as in GNU, so subproblems need no
// coordinate shift.
function middleSnake(search, xoff, xlim, yoff, ylim, findMinimal, part) {
  const { A, B, fd, bd, base, limit } = search
  const dmax = xlim - yoff, dmin = xoff - ylim
  const bmid = xlim - ylim, fmid = xoff - yoff
  let bmax = bmid, bmin = bmid, fmax = fmid, fmin = fmid
  const odd = ((fmid - bmid) & 1) !== 0
  fd[base + fmid] = xoff
  bd[base + bmid] = xlim
  for (let c = 1; ; c++) {
    if (fmin > dmin) fd[base + --fmin - 1] = -1
    else ++fmin
    if (fmax < dmax) fd[base + ++fmax + 1] = -1
    else --fmax
    for (let d = fmax; d >= fmin; d -= 2) {
      const thi = fd[base + d + 1], tlo = fd[base + d - 1]
      let x = tlo < thi ? thi : tlo + 1
      let y = x - d
      while (x < xlim && y < ylim && A[x] === B[y]) { x++; y++ }
      fd[base + d] = x
      if (odd && bmin <= d && d <= bmax && bd[base + d] <= x) {
        part.xmid = x; part.ymid = y; part.loMinimal = part.hiMinimal = true
        return
      }
    }
    if (bmin > dmin) bd[base + --bmin - 1] = 0x7FFFFFFF
    else ++bmin
    if (bmax < dmax) bd[base + ++bmax + 1] = 0x7FFFFFFF
    else --bmax
    for (let d = bmax; d >= bmin; d -= 2) {
      const thi = bd[base + d + 1], tlo = bd[base + d - 1]
      let x = tlo < thi ? tlo : thi - 1
      let y = x - d
      while (xoff < x && yoff < y && A[x - 1] === B[y - 1]) { x--; y-- }
      bd[base + d] = x
      if (!odd && fmin <= d && d <= fmax && x <= fd[base + d]) {
        part.xmid = x; part.ymid = y; part.loMinimal = part.hiMinimal = true
        return
      }
    }
    if (findMinimal || c < limit) continue
    splitAtFurthest(search, { xoff, xlim, yoff, ylim, fmin, fmax, bmin, bmax }, part)
    return
  }
}

// Past the cost limit: the forward point that got furthest, or the backward
// point that got furthest, whichever made more progress. Any point a search
// reached lies on a valid path, so the halves either side of it still
// compose into a correct change set; the search just resumes from there.
function splitAtFurthest(search, bounds, part) {
  const { fd, bd, base } = search
  const { xoff, xlim, yoff, ylim, fmin, fmax, bmin, bmax } = bounds
  let fxbest = 0, fxybest = -1
  for (let d = fmax; d >= fmin; d -= 2) {
    let x = Math.min(fd[base + d], xlim)
    let y = x - d
    if (ylim < y) { x = ylim + d; y = ylim }
    if (fxybest < x + y) { fxybest = x + y; fxbest = x }
  }
  let bxbest = 0, bxybest = 0x7FFFFFFF
  for (let d = bmax; d >= bmin; d -= 2) {
    let x = Math.max(xoff, bd[base + d])
    let y = x - d
    if (y < yoff) { x = yoff + d; y = yoff }
    if (x + y < bxybest) { bxybest = x + y; bxbest = x }
  }
  if (xlim + ylim - bxybest < fxybest - (xoff + yoff)) {
    part.xmid = fxbest; part.ymid = fxybest - fxbest; part.loMinimal = true; part.hiMinimal = false
  } else {
    part.xmid = bxbest; part.ymid = bxybest - bxbest; part.loMinimal = false; part.hiMinimal = true
  }
}

// Runs of changed lines, paired up: a[a0..a1) is replaced by b[b0..b1).
// Either side may be empty, never both.
function collectBlocks(changedA, changedB) {
  const blocks = []
  const M = changedB.length, N = changedA.length
  let i = 0, j = 0
  while (i < N || j < M) {
    if (i < N && j < M && !changedA[i] && !changedB[j]) { i++; j++; continue }
    const a0 = i, b0 = j
    while (i < N && changedA[i]) i++
    while (j < M && changedB[j]) j++
    if (a0 === i && b0 === j) throw new DiffError('a kept line has no counterpart')
    blocks.push({ a0, a1: i, b0, b1: j })
  }
  return blocks
}

// The guarantee. Apply the change set to `a` the way patch would — keep what
// is between the blocks, take each block's replacement from `b` — and the
// result has to be `b`, line for line under the comparison in force. The
// original strings are compared, not the interned ids, so the interning is
// checked along with the search.
export function verifyChangeSet(a, b, blocks, key = null) {
  const equal = key ? (x, y) => key(x) === key(y) : (x, y) => x === y
  let ai = 0, bi = 0
  for (const { a0, a1, b0, b1 } of blocks) {
    if (a0 < ai || b0 < bi || a1 < a0 || b1 < b0 || a1 > a.length || b1 > b.length) throw new DiffError('a block is out of order or out of range')
    if (a0 === a1 && b0 === b1) throw new DiffError('a block changes nothing')
    if (a0 - ai !== b0 - bi) throw new DiffError('the kept lines before a block differ in count')
    for (; ai < a0; ai++, bi++) if (!equal(a[ai], b[bi])) throw new DiffError(`kept line ${ai + 1} does not match`)
    ai = a1
    bi = b1
  }
  if (a.length - ai !== b.length - bi) throw new DiffError('the kept lines after the last block differ in count')
  for (; ai < a.length; ai++, bi++) if (!equal(a[ai], b[bi])) throw new DiffError(`kept line ${ai + 1} does not match`)
}

export class DiffError extends Error {
  constructor(detail) {
    super(`the computed change set does not reconstruct the second file (${detail})`)
    this.name = 'DiffError'
  }
}
