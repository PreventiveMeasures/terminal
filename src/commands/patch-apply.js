import { PatchFatal } from './patch-parse.js'
import { swapHunk } from './patch-hunks.js'
import { okToReverse } from './patch-names.js'

// Where a hunk goes and what it does there, as patch.c decides: at the line
// it names, adjusted by the offset earlier hunks were found at; failing
// that, nearby, searching outward; failing that, with fuzz, ignoring a line
// or two of context at each end. The first hunk that fits nowhere is tried
// the other way round, which is how an already-applied patch is noticed.

export function createFileState(input) {
  return { input, frozen: 0, inOffset: 0, outOffset: 0, out: [] }
}

const ifetch = (state, n) => n < 1 || n > state.input.length ? '' : state.input[n - 1]

// -l: any run of blanks matches any run, and blanks at the end of a line
// (and the newline itself) do not count.
function similar(a, b) {
  const strip = (s) => s.replace(/\n$/u, '').replace(/[ \t]+$/u, '').replace(/[ \t]+/gu, ' ')
  return strip(a) === strip(b)
}

function patchMatch(state, hunk, base, offset, prefixFuzz, suffixFuzz, loose) {
  const pattern = hunk.oldLines
  const end = pattern.length - suffixFuzz
  for (let i = base + offset + prefixFuzz, p = prefixFuzz; p < end; p++, i++) {
    const line = ifetch(state, i)
    const want = pattern[p].text
    if (loose ? !similar(line, want) : line !== want) return false
  }
  return true
}

// patch.c locate_hunk, line for line. Returns the 1-based line the pattern
// starts at, or 0; a find moves the running offset.
export function locateHunk(state, hunk, fuzz, loose) {
  const firstGuess = hunk.oldStart + state.inOffset
  const patLines = hunk.oldLines.length
  const context = Math.max(hunk.prefix, hunk.suffix)
  let prefixFuzz = fuzz + hunk.prefix - context
  let suffixFuzz = fuzz + hunk.suffix - context
  const inputLines = state.input.length
  const maxWhere = inputLines - (patLines - suffixFuzz) + 1
  const minWhere = state.frozen + 1
  const maxPosOffset = maxWhere - firstGuess
  let maxNegOffset = firstGuess - minWhere
  const maxOffset = Math.max(maxPosOffset, maxNegOffset)
  if (!patLines) return firstGuess
  if (firstGuess <= maxNegOffset) maxNegOffset = firstGuess - 1
  const found = (offset) => { state.inOffset += offset; return firstGuess + offset }
  if (prefixFuzz < 0 && hunk.oldStart <= 1) {
    // Can only match the start of the file.
    if (suffixFuzz < 0 && (patLines !== inputLines || hunk.prefix < state.frozen)) return 0
    const offset = 1 - firstGuess
    if (state.frozen <= hunk.prefix && offset <= maxPosOffset && patchMatch(state, hunk, firstGuess, offset, 0, suffixFuzz, loose)) return found(offset)
    return 0
  } else if (prefixFuzz < 0) prefixFuzz = 0
  if (suffixFuzz < 0) {
    // Can only match the end of the file.
    const offset = firstGuess - (inputLines - patLines + 1)
    if (offset <= maxNegOffset && patchMatch(state, hunk, firstGuess, -offset, prefixFuzz, 0, loose)) return found(-offset)
    return 0
  }
  const minOffset = maxPosOffset < 0 ? firstGuess - maxWhere : maxNegOffset < 0 ? firstGuess - minWhere : 0
  for (let offset = minOffset; offset <= maxOffset; offset++) {
    if (offset <= maxPosOffset && patchMatch(state, hunk, firstGuess, offset, prefixFuzz, suffixFuzz, loose)) return found(offset)
    if (offset <= maxNegOffset && patchMatch(state, hunk, firstGuess, -offset, prefixFuzz, suffixFuzz, loose)) return found(-offset)
  }
  return 0
}

// Lines up to `n` (1-based) that have not been output yet. A hunk placed
// past the end asks for lines that are not there, and gets none.
function copyTill(state, n) {
  if (state.frozen > n) return false
  while (state.frozen < n) {
    if (state.frozen < state.input.length) state.out.push(state.input[state.frozen])
    state.frozen++
  }
  return true
}

// patch.c apply_hunk: deletions skip input lines, insertions add new ones,
// context lines are copied through; both sides' context has to agree.
export function applyHunk(state, hunk, whereArg) {
  const where = whereArg - 1
  const fresh = hunk.newLines, old = hunk.oldLines
  let ni = 0, oi = 0
  const mangled = () => { throw new PatchFatal(`Out-of-sync patch, lines ${hunk.line + 1 + oi + 1},${hunk.line + 1 + old.length + ni + 1} -- mangled text or line numbers, maybe?`) }
  while (oi < old.length) {
    if (old[oi].tag === '-') {
      if (!copyTill(state, where + oi)) return false
      state.frozen++
      oi++
    } else if (ni >= fresh.length) break
    else if (fresh[ni].tag === '+') {
      if (!copyTill(state, where + oi)) return false
      state.out.push(fresh[ni++].text)
    } else if (fresh[ni].tag === old[oi].tag) { oi++; ni++ }
    else mangled()
  }
  for (; ni < fresh.length && fresh[ni].tag === '+'; ni++) {
    if (!copyTill(state, where + oi)) return false
    state.out.push(fresh[ni].text)
  }
  state.outOffset += fresh.length - old.length
  return true
}

export const finishOutput = (state) => state.frozen >= state.input.length || copyTill(state, state.input.length)

// Lines join as written; one without a newline that is not the last gets one.
export const joinOutput = (records) => records.map((r, i) => i < records.length - 1 && !r.endsWith('\n') ? r + '\n' : r).join('')

// The hunk loop of patch.c main, for one file. `hunks` yields raw hunks;
// each is swapped for -R, or after a reversal is detected on the first.
export function applyHunks(run, header, hunks, state, reject) {
  const { opts } = run
  const tally = { count: 0, failed: 0, mismatch: false, applyAnyway: false }
  for (let raw = hunks(); raw; raw = hunks()) {
    tally.count++
    const placed = run.skipRest ? { hunk: run.reverse ? swapHunk(raw) : raw, where: 0, fuzz: 0 } : locateWithFuzz(run, state, run.reverse ? swapHunk(raw) : raw, tally)
    const { hunk, where, fuzz } = placed
    const newWhere = (where || hunk.oldStart) + state.outOffset
    const creating = where === 1 && header.says[run.reverse ? 1 : 0] === 2 && state.input.length > 0
    if (run.skipRest || creating || !where || !applyHunk(state, hunk, where)) {
      if (!run.skipRejectFile) reject.add(hunk, tally.failed === 0, state.outOffset, run.reverse)
      tally.failed++
      if (!run.skipRest && !opts.silent) run.say(`Hunk #${tally.count} FAILED at ${newWhere}.\n`)
    } else if (!opts.silent && (fuzz || state.inOffset)) {
      const offset = state.inOffset ? ` (offset ${state.inOffset} line${state.inOffset === 1 ? '' : 's'})` : ''
      run.say(`Hunk #${tally.count} succeeded at ${newWhere}${fuzz ? ` with fuzz ${fuzz}` : ''}${offset}.\n`)
    }
  }
  return tally
}

// Fuzz 0 first, then more, up to the hunk's own context. The first hunk
// that fits nowhere is tried swapped: if that fits, the patch is reversed
// or already applied, and the options say what to do about it.
function locateWithFuzz(run, state, first, tally) {
  const { opts } = run
  let fuzz = 0, hunk = first, where = 0
  const maxFuzz = Math.min(opts.fuzz, Math.max(hunk.prefix, hunk.suffix))
  do {
    where = locateHunk(state, hunk, fuzz, opts.loose)
    if (!where || fuzz || state.inOffset) tally.mismatch = true
    if (tally.count === 1 && !where && !(opts.force || tally.applyAnyway) && run.reverse === run.reverseFlag) {
      const swapped = swapHunk(hunk)
      where = locateHunk(state, swapped, fuzz, opts.loose)
      if (where && okToReverse(run, `${run.reverse ? 'Unreversed' : 'Reversed (or previously applied)'} patch detected!`)) { run.reverse = !run.reverse; hunk = swapped }
      else if (where) { tally.applyAnyway = true; fuzz--; where = 0 }
    }
  } while (!run.skipRest && !where && ++fuzz <= maxFuzz)
  return { hunk, where, fuzz }
}
