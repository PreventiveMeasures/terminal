import { PatchFatal } from './patch-parse.js'

// One hunk of each format, read as pch.c another_hunk reads it, into one
// shape: the old side (context and deletions) and the new side (context and
// insertions), each line carrying its terminator, so a line the patch says
// has no newline compares only with a last line that has none.
//
// A hunk: { oldStart, oldLines, newStart, newLines, prefix, suffix, fn,
//   marks, line }. `marks` keeps context-format markers for rejects.

// GNU names the line it stopped at, text and all; past the end, the last one.
const malformed = (scanner, i, raw) => { throw new PatchFatal(`malformed patch at line ${Math.min(i, scanner.lines.length - 1) + 1}: ${raw ?? ''}`) }

// `\ No newline at end of file` after a line takes that line's newline away.
function incomplete(scanner, i) {
  if (scanner.lines[i + 1]?.startsWith('\\')) return true
  return false
}

export function parseUnifiedHunk(scanner) {
  const { lines } = scanner
  let i = scanner.pos
  const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?\n$/u.exec(lines[i] ?? '')
  if (!head) return null
  const line = i
  let newStart = Number(head[3]), oldStart = Number(head[1])
  const ptrn = head[2] === undefined ? 1 : Number(head[2])
  const repl = head[4] === undefined ? 1 : Number(head[4])
  if (ptrn === 0) oldStart++
  if (repl === 0) newStart++
  const newLines = [], oldLines = []
  let context = 0, last = i, prefix = -1
  for (i++; oldLines.length < ptrn || newLines.length < repl; i += 1) {
    const fromFile = lines[i] !== undefined
    // Up to three lines missing at the end are taken for chopped blanks.
    if (!fromFile && repl - newLines.length > 3) throw new PatchFatal('unexpected end of file in patch')
    const raw = fromFile ? lines[i] : ' \n'
    if (fromFile) last = i
    let ch = raw[0], text = raw
    if (ch === '\t' || ch === '\n') ch = ' '
    else text = raw.slice(1)
    if (ch !== '-' && ch !== '+' && ch !== ' ') malformed(scanner, i, raw)
    // The marker after a side's last line takes that line's newline; a
    // context line last on the old side loses it on the new side too.
    let marker = false
    if (ch !== '+') {
      if (oldLines.length >= ptrn) malformed(scanner, i, raw)
      marker = fromFile && oldLines.length + 1 === ptrn && incomplete(scanner, i)
      if (marker) text = text.replace(/\n$/u, '')
      oldLines.push({ tag: ch, text })
      if (ch === ' ') context++
    }
    if (ch !== '-') {
      if (newLines.length >= repl) malformed(scanner, i, raw)
      if (!marker && fromFile && newLines.length + 1 === repl && incomplete(scanner, i)) { marker = true; text = text.replace(/\n$/u, '') }
      newLines.push({ tag: ch, text })
    }
    if (ch !== ' ') { if (prefix === -1) prefix = context; context = 0 }
    if (marker) i++
  }
  if (prefix === -1) malformed(scanner, last, lines[last])
  scanner.pos = i
  return { oldStart, oldLines, newStart, newLines, prefix, suffix: context, fn: head[5] === undefined ? null : ' ' + head[5], marks: null, line }
}

// A context hunk's sides are separate lists, either of which may be left
// out when it has no changes of its own; the missing one is the other's
// context lines. `!` on both sides is a change, `-`/`+` a deletion or
// insertion; both read as old-side and new-side lines here.
export function parseContextHunk(scanner) {
  const { lines } = scanner
  let i = scanner.pos
  if (!lines[i]?.startsWith('********')) return null
  const line = i
  const fn = /^\*+( .*)?\n$/u.exec(lines[i])?.[1] ?? null
  const oldHead = /^\*\*\* (\d+)(?:,(\d+))?/u.exec(lines[++i] ?? '')
  if (!oldHead) throw new PatchFatal(`unexpected '***' at line ${i + 1}: ${lines[i] ?? ''}`)
  const oldRange = rangeOf(oldHead)
  const oldSide = []
  const newHeadAt = (k) => /^--- (\d+)(?:,(\d+))? ----/u.exec(lines[k] ?? '') ?? /^--- (\d+)(?:,(\d+))?/u.exec(lines[k] ?? '')
  for (i++; !newHeadAt(i); i++) {
    if (lines[i] === undefined || oldSide.length >= oldRange.count) throw new PatchFatal(`no '---' found in patch at line ${line + 1}`)
    oldSide.push(sideLine(scanner, i, oldSide.length + 1 === oldRange.count))
    if (oldSide.at(-1).skip) i++
  }
  const newRange = rangeOf(newHeadAt(i))
  const newSide = []
  for (i++; newSide.length < newRange.count; i++) {
    const text = lines[i]
    if (text === undefined || !/^[ !+\-\t\n]/u.test(text) || text.startsWith('***')) break
    newSide.push(sideLine(scanner, i, newSide.length + 1 === newRange.count))
    if (newSide.at(-1).skip) i++
  }
  if (newSide.length !== 0 && newSide.length < newRange.count) malformed(scanner, i, lines[i])
  scanner.pos = i
  return assembleContext({ oldRange, oldSide, newRange, newSide, fn, line })
}

// `*** 3,5 ****`: first and last, inclusive; a single number is one line;
// `0` is an empty range before the first line.
function rangeOf(match) {
  const first = Number(match[1])
  const last = match[2] === undefined ? first : Number(match[2])
  if (first === 0 && match[2] === undefined) return { first: 1, count: 0 }
  return { first, count: last - first + 1 }
}

function sideLine(scanner, i, last) {
  let text = scanner.lines[i]
  let mark = text[0]
  if (mark === '\t' || mark === '\n') mark = ' '
  else {
    text = text.slice(1)
    if (text[0] === ' ' || text[0] === '\t') text = text.slice(1)
  }
  const skip = last && incomplete(scanner, i)
  return { mark, text: skip ? text.replace(/\n$/u, '') : text, skip }
}

function assembleContext({ oldRange, oldSide, newRange, newSide, fn, line }) {
  let newMarks = newSide, oldMarks = oldSide
  if (oldSide.length === 0 && oldRange.count) oldMarks = newSide.filter((l) => l.mark === ' ')
  if (newSide.length === 0 && newRange.count) newMarks = oldSide.filter((l) => l.mark === ' ')
  if (oldMarks.length !== oldRange.count || newMarks.length !== newRange.count) throw new PatchFatal(`replacement text or line numbers mangled in hunk at line ${line + 1}`)
  const oldLines = oldMarks.map((l) => ({ tag: l.mark === ' ' ? ' ' : '-', text: l.text }))
  const newLines = newMarks.map((l) => ({ tag: l.mark === ' ' ? ' ' : '+', text: l.text }))
  const contextOf = (list) => { let n = 0; for (const l of list) { if (l.tag !== ' ') break; n++ } return n }
  const prefix = Math.min(contextOf(oldLines), contextOf(newLines))
  const suffix = Math.min(contextOf(oldLines.toReversed()), contextOf(newLines.toReversed()))
  if (oldLines.every((l) => l.tag === ' ') && newLines.every((l) => l.tag === ' ')) throw new PatchFatal(`replacement text or line numbers mangled in hunk at line ${line + 1}`)
  return { oldStart: oldRange.first, oldLines, newStart: newRange.first, newLines, prefix, suffix, fn, marks: { old: oldMarks.map((l) => l.mark), new: newMarks.map((l) => l.mark) }, line }
}

// `3,4c3,5`: no context at all, so a normal hunk applies at its line or
// wherever its old lines are found nearby.
export function parseNormalHunk(scanner) {
  const { lines } = scanner
  let i = scanner.pos
  const head = /^(\d+)(?:,(\d+))?([acd])(\d+)(?:,(\d+))?[ \t]*\r?\n$/u.exec(lines[i] ?? '')
  if (!head) return null
  const line = i
  let oldStart = Number(head[1])
  const oldCount = head[3] === 'a' ? 0 : head[2] === undefined ? 1 : Number(head[2]) - oldStart + 1
  if (head[3] === 'a') oldStart++
  let newStart = Number(head[4])
  const newLast = head[5] === undefined ? newStart : Number(head[5])
  if (head[3] === 'd') newStart++
  const newCount = newLast - newStart + 1
  if (oldCount < 0 || newCount < 0) malformed(scanner, i, lines[i])
  const newLines = [], oldLines = []
  i++
  for (let n = 0; n < oldCount; n++, i++) {
    if (lines[i] === undefined) throw new PatchFatal(`unexpected end of file in patch at line ${i}`)
    if (!/^<[ \t]/u.test(lines[i])) throw new PatchFatal(`'<' followed by space or tab expected at line ${i + 1} of patch`)
    const last = n + 1 === oldCount && incomplete(scanner, i)
    oldLines.push({ tag: '-', text: last ? lines[i].slice(2).replace(/\n$/u, '') : lines[i].slice(2) })
    if (last) i++
  }
  if (head[3] === 'c') {
    if (lines[i] === undefined) throw new PatchFatal(`unexpected end of file in patch at line ${i}`)
    if (!lines[i].startsWith('-')) throw new PatchFatal(`'---' expected at line ${i + 1} of patch`)
    i++
  }
  for (let n = 0; n < newCount; n++, i++) {
    if (lines[i] === undefined) throw new PatchFatal(`unexpected end of file in patch at line ${i}`)
    if (!/^>[ \t]/u.test(lines[i])) throw new PatchFatal(`'>' followed by space or tab expected at line ${i + 1} of patch`)
    const last = n + 1 === newCount && incomplete(scanner, i)
    newLines.push({ tag: '+', text: last ? lines[i].slice(2).replace(/\n$/u, '') : lines[i].slice(2) })
    if (last) i++
  }
  scanner.pos = i
  return { oldStart, oldLines, newStart, newLines, prefix: 0, suffix: 0, fn: null, marks: null, line }
}

// -R, or a hunk tried the other way round: old and new change places, and
// so do the context-format marks that name a side (pch.c pch_swap).
export function swapHunk(hunk) {
  const flip = (list, from, to) => list.map((l) => ({ tag: l.tag === from ? to : l.tag, text: l.text }))
  const flipMarks = (marks, from, to) => marks.map((mark) => mark === from ? to : mark)
  return { ...hunk, oldStart: hunk.newStart, newStart: hunk.oldStart, oldLines: flip(hunk.newLines, '+', '-'), newLines: flip(hunk.oldLines, '-', '+'),
    marks: hunk.marks && { old: flipMarks(hunk.marks.new, '+', '-'), new: flipMarks(hunk.marks.old, '-', '+') } }
}
