import { UnsupportedError } from '../unsupported.js'
import { PatchFatal } from './patch-parse.js'

// One hunk of each format, read as pch.c another_hunk reads it, into one
// shape: the old side (context and deletions) and the new side (context and
// insertions), each line carrying its terminator, so a line the patch says
// has no newline compares only with a last line that has none.
//
// A hunk: { oldStart, oldLines, newStart, newLines, prefix, suffix, fn,
//   marks, beg, blank } (the context format's is in ./patch-context.js). `marks` keeps context-format markers, for rejects
// and for the change runs a context hunk is applied by; `beg` is the line
// GNU counts the hunk's lines from, and `blank` whether a blank line stood
// before its `---`, which shifts that count.

// pch.c pget_line, as a cursor from line `at`: a line starting with `#` is
// a comment patch passes over — counted, as it counts every line it reads —
// and a last line without its newline is no line at all: patch says so each
// time it reaches it, and reads the end of the patch there. `line` is the
// number patch gives the last line read, and `incomplete` takes the `\ No
// newline` line after it, which patch reads past without counting, so the
// numbers it gives the lines after one lag behind their places. They can run
// ahead too: see restartAt.
export function lineReader(scanner, at = scanner.pos) {
  const reader = {
    at,
    line: at - markersBefore(scanner, at) + scanner.skew,
    next() {
      for (;;) {
        if (reader.at >= scanner.end) {
          if (reader.at === scanner.end && scanner.incomplete) {
            scanner.say('patch unexpectedly ends in middle of line\n')
            reader.at++
          }
          return null
        }
        const text = scanner.lines[reader.at]
        reader.line = lineNumber(scanner, reader.at++)
        if (!text.startsWith('#')) return text
      }
    },
    incomplete() {
      if (!scanner.lines[reader.at]?.startsWith('\\')) return false
      if (!scanner.markers.includes(reader.at)) scanner.markers.push(reader.at)
      reader.at++
      return true
    },
  }
  return reader
}

const markersBefore = (scanner, at) => scanner.markers.filter((marker) => marker < at).length
const lineNumber = (scanner, at) => at + 1 - markersBefore(scanner, at) + scanner.skew

// pch.c skip_to: reading resumes at a hunk's first line, numbered from the
// number patch noted for it — counted, for a context or normal hunk, as the
// line before the one that showed the hunk had begun. A comment between the
// two goes uncounted that way, and every number after it is one more than
// the line it names.
export function restartAt(scanner, at, line) {
  scanner.pos = at
  scanner.skew = line - 1 - (at - markersBefore(scanner, at))
}

// GNU names the line it stopped at, text and all.
export const malformed = (reader, text) => { throw new PatchFatal(`malformed patch at line ${reader.line}: ${text}`) }

// The arrays a hunk is read into grow as pch.c grow_hunkmax grows them, and
// a context hunk too long for them is one patch gives up on.
export function grow(scanner, size) {
  while (size + 1 >= scanner.hunkmax) scanner.hunkmax *= 2
}

export const isDigit = (c) => c >= '0' && c <= '9'

// pch.c scan_linenum: the digits at `at`, which have to be there. A number
// past what patch's line counter holds is fatal, and one past what a double
// holds exactly, short of that, is a count this code cannot keep.
export function scanLinenum(reader, text, at) {
  const digits = /^\d*/u.exec(text.slice(at))[0]
  if (digits === '') throw new PatchFatal(`missing line number at line ${reader.line}: ${text}`)
  const value = BigInt(digits)
  if (value > LINENUM_MAX) throw new PatchFatal(`line number ${digits} is too large at line ${reader.line}: ${text}`)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new UnsupportedError('feature', 'line number size', `line number ${digits} at line ${reader.line} is too large to be counted here`)
  return { value: Number(value), at: at + digits.length }
}

const LINENUM_MAX = 2n ** 63n - 1n

// The header, read the way another_hunk reads it: a number, an optional
// count, a blank or not, `+`, the same again, a blank or not, and an `@` —
// one is enough. A second `@` and a blank start the function -p named.
// Anything else in its place is a malformed patch, which is fatal.
function unifiedHeader(reader, text) {
  let at = 4
  const range = () => {
    const first = scanLinenum(reader, text, at)
    at = first.at
    if (text[at] !== ',') return [first.value, 1]
    const count = scanLinenum(reader, text, at + 1)
    at = count.at
    return [first.value, count.value]
  }
  const [oldFirst, ptrn] = range()
  if (text[at] === ' ') at++
  if (text[at] !== '+') malformed(reader, text)
  at++
  const [newFirst, repl] = range()
  if (text[at] === ' ') at++
  if (text[at++] !== '@') malformed(reader, text)
  const fn = text[at++] === '@' && text[at] === ' ' ? text.slice(at).replace(/\n$/u, '') : null
  return { oldFirst, ptrn, newFirst, repl, fn }
}

export function parseUnifiedHunk(scanner) {
  const reader = lineReader(scanner)
  const head = reader.next()
  // Anything that does not open a hunk ends this file's hunks, and is read
  // again from where it starts.
  if (head === null || head.length <= 4 || !head.startsWith('@@ -')) return null
  const { oldFirst, ptrn, newFirst, repl, fn } = unifiedHeader(reader, head)
  let newStart = newFirst, oldStart = oldFirst
  if (ptrn === 0) oldStart++
  if (repl === 0) newStart++
  grow(scanner, ptrn + repl + 1)
  const beg = scanner.hunkBeg = reader.line + 1
  const newLines = [], oldLines = []
  let context = 0, prefix = -1, raw = head
  while (oldLines.length < ptrn || newLines.length < repl) {
    raw = reader.next()
    const fromFile = raw !== null
    // Up to three lines missing at the end are taken for chopped blanks.
    if (!fromFile) {
      if (repl - newLines.length > 3) throw new PatchFatal('unexpected end of file in patch')
      raw = ' \n'
    }
    let ch = raw[0], text = raw
    if (ch === '\t' || ch === '\n') ch = ' '
    else text = raw.slice(1)
    if (ch === '=') ch = ' '
    if (ch !== '-' && ch !== '+' && ch !== ' ') malformed(reader, raw)
    // The marker after a side's last line takes that line's newline; a
    // context line last on the old side loses it on the new side too, and
    // is looked past for a second marker if it is last there as well.
    if (ch !== '+') {
      if (oldLines.length >= ptrn) malformed(reader, raw)
      if (fromFile && oldLines.length + 1 === ptrn && reader.incomplete()) text = text.slice(0, -1)
      oldLines.push({ tag: ch, text })
      if (ch === ' ') context++
    }
    if (ch !== '-') {
      if (newLines.length >= repl) malformed(reader, raw)
      if (fromFile && newLines.length + 1 === repl && reader.incomplete()) text = text.slice(0, -1)
      newLines.push({ tag: ch, text })
    }
    if (ch !== ' ') { if (prefix === -1) prefix = context; context = 0 }
  }
  if (prefix === -1) malformed(reader, raw)
  scanner.pos = reader.at
  scanner.prefixContext = prefix
  return { oldStart, oldLines, newStart, newLines, prefix, suffix: context, fn, marks: null, beg, blank: false }
}

// `3,4c3,5`: no context at all, so a normal hunk applies at its line or
// wherever its old lines are found nearby. The command letter is read for
// what it says about counts and nothing else, so any letter a hunk after
// the first carries is taken; the rest of the line is not read at all.
export function parseNormalHunk(scanner) {
  const reader = lineReader(scanner)
  const head = reader.next()
  if (head === null || !isDigit(head[0])) return null
  let scanned = scanLinenum(reader, head, 0)
  let oldCount, oldStart = scanned.value
  if (head[scanned.at] === ',') {
    const last = scanLinenum(reader, head, scanned.at + 1)
    oldCount = last.value + 1 - oldStart
    scanned = last
  } else oldCount = head[scanned.at] === 'a' ? 0 : 1
  const type = head[scanned.at]
  if (type === 'a') oldStart++
  scanned = scanLinenum(reader, head, scanned.at + 1)
  let newStart = scanned.value
  const newLast = head[scanned.at] === ',' ? scanLinenum(reader, head, scanned.at + 1).value : newStart
  if (newStart > newLast) malformed(reader, head)
  if (type === 'd') newStart++
  const newCount = newLast - newStart + 1
  // A range that runs backwards is one GNU goes on with regardless.
  if (oldCount < 0) throw new UnsupportedError('feature', 'malformed normal hunk', `a normal hunk whose range runs backwards (line ${reader.line}) is not supported`)
  grow(scanner, oldCount + newCount + 1)
  const side = (count, mark, tag) => {
    const lines = []
    for (let n = 0; n < count; n++) {
      const text = reader.next()
      if (text === null) throw new PatchFatal(`unexpected end of file in patch at line ${reader.line}`)
      if (text[0] !== mark || (text[1] !== ' ' && text[1] !== '\t')) throw new PatchFatal(`'${mark}' followed by space or tab expected at line ${reader.line} of patch`)
      lines.push({ tag, text: n + 1 === count && reader.incomplete() ? text.slice(2, -1) : text.slice(2) })
    }
    return lines
  }
  const oldLines = side(oldCount, '<', '-')
  if (type === 'c') {
    const text = reader.next()
    if (text === null) throw new PatchFatal(`unexpected end of file in patch at line ${reader.line}`)
    if (text[0] !== '-') throw new PatchFatal(`'---' expected at line ${reader.line} of patch`)
  }
  const newLines = side(newCount, '>', '+')
  scanner.pos = reader.at
  scanner.prefixContext = 0
  return { oldStart, oldLines, newStart, newLines, prefix: 0, suffix: 0, fn: null, marks: null, beg: scanner.hunkBeg, blank: false }
}

// -R, or a hunk tried the other way round: old and new change places, and
// so do the context-format marks that name a side (pch.c pch_swap).
export function swapHunk(hunk) {
  const flip = (list, from, to) => list.map((l) => ({ tag: l.tag === from ? to : l.tag, text: l.text }))
  const flipMarks = (marks, from, to) => marks.map((mark) => mark === from ? to : mark)
  return { ...hunk, oldStart: hunk.newStart, newStart: hunk.oldStart, oldLines: flip(hunk.newLines, '+', '-'), newLines: flip(hunk.oldLines, '-', '+'),
    marks: hunk.marks && { old: flipMarks(hunk.marks.new, '+', '-'), new: flipMarks(hunk.marks.old, '-', '+') } }
}
