import { UnsupportedError } from '../unsupported.js'
import { PatchFatal } from './patch-parse.js'
import { grow, isDigit, lineReader, malformed, scanLinenum } from './patch-hunks.js'

// A context hunk, read by pch.c's own state machine: the old side, a `---`
// line, the new side, either side free to be left out when it holds nothing
// the other does not, and every way of getting that wrong in the words GNU
// gives it. The lines land in one array as they do there — the `***` line,
// the old side, a blank line if one stood before the `---`, the `---` line,
// the new side — each with the character that marked it, and the hunk this
// code applies is read off that array at the end.

export function parseContextHunk(scanner) {
  const reader = lineReader(scanner)
  const first = reader.next()
  if (first === null || first.length <= 8 || !first.startsWith('********')) return null
  let stars = 0
  while (first[stars] === '*') stars++
  const h = {
    scanner, reader, fn: first[stars] === ' ' ? first.slice(stars).replace(/\n$/u, '') : null, beg: scanner.hunkBeg = reader.line + 1,
    chars: [], texts: [], end: -1, max: scanner.hunkmax, context: 0,
    oldFirst: 0, ptrnLines: 0, newFirst: 0, replLines: 0, replBeginning: 0, replCouldBeMissing: true, replMissing: false, backtrack: null, replContext: 0,
    fillcnt: 0, fillsrc: 0, filldst: 0, ptrnMissing: false, ptrnSpacesEaten: false, someContext: false,
    ptrnPrefix: -1, ptrnSuffix: -1, replPrefix: -1, ptrnCopiable: 0, replCopiable: 0,
  }
  readLines(h)
  if (h.end >= 0 && !h.replBeginning) fatal(`no '---' found in patch at line ${h.beg}`)
  settle(h)
  fill(h)
  scanner.pos = reader.at
  return shape(h)
}

const fatal = (message) => { throw new PatchFatal(message) }
const mangled = (h) => fatal(`replacement text or line numbers mangled in hunk at line ${h.beg}`)

// Up to the array's end, or until the new side turns out to have been left
// out: a line that cannot belong to a new side that is there, where one that
// is not could still be — which each kind of line answers for itself, by
// returning false, once whatever it changes on the way has been changed.
function readLines(h) {
  while (h.end < h.max) {
    let text = h.reader.next()
    if (text === null) {
      if (missable(h)) { h.replMissing = true; return }
      if (h.max - h.end >= 4) fatal('unexpected end of file in patch')
      text = '  \n'
    }
    h.end++
    if (h.end === h.scanner.hunkmax) fatal(`unterminated hunk starting at line ${h.beg}; giving up at line ${h.reader.line}: ${text}`)
    h.chars[h.end] = text[0]
    h.texts[h.end] = null
    const line = Object.hasOwn(LINES, text[0]) ? LINES[text[0]] : null
    if (line === null && !missable(h)) malformed(h.reader, text)
    if (line === null || !line(h, text)) { h.replMissing = true; return }
  }
}

const missable = (h) => h.replBeginning !== 0 && h.replCouldBeMissing

const LINES = {
  '*': (h, text) => {
    if (text.startsWith('********') || h.end !== 0) {
      if (missable(h)) return false
      fatal(text.startsWith('********') ? `unexpected end of hunk at line ${h.reader.line}` : `unexpected '***' at line ${h.reader.line}: ${text}`)
    }
    h.context = 0
    h.texts[h.end] = text
    // `*** 0,0` is read as `*** 0`.
    let at = 0
    while (at < text.length && !isDigit(text[at])) at++
    const spelt = text.startsWith('0,0', at) ? text.slice(0, at) + text.slice(at + 2) : text
    const first = scanLinenum(h.reader, spelt, at)
    h.oldFirst = first.value
    if (spelt[first.at] === ',') {
      at = first.at
      while (at < spelt.length && !isDigit(spelt[at])) at++
      h.ptrnLines = scanLinenum(h.reader, spelt, at).value + 1 - h.oldFirst
      if (h.ptrnLines < 0) malformed(h.reader, spelt)
    } else if (h.oldFirst) h.ptrnLines = 1
    else { h.ptrnLines = 0; h.oldFirst = 1 }
    grow(h.scanner, h.ptrnLines + 6)
    h.max = h.scanner.hunkmax
    return true
  },
  '-': (h, text) => text[1] === '-' ? replacementLine(h, text) : changeLine(h, text),
  '+': (h, text) => { h.replCouldBeMissing = false; return changeLine(h, text) },
  '!': (h, text) => { h.replCouldBeMissing = false; return changeLine(h, text) },
  // A context line whose blanks were eaten. What is kept is the line less as
  // many bytes as the tab GNU stepped over, its own newline among them —
  // which is what pch.c keeps.
  '\t': (h, text) => eatenLine(h, text),
  '\n': (h, text) => eatenLine(h, text),
  ' ': (h, text) => {
    // Under -l GNU keeps a one-blank line as a newline and a NUL, which no
    // line of a file ever matches.
    const blank = text[1] === ' ' || text[1] === '\t'
    if (!blank && missable(h)) return false
    if (text === ' \n' && h.scanner.loose) throw new UnsupportedError('option', '-l', `-l with a context line of one blank (line ${h.reader.line}) is not supported`)
    const line = text.slice(blank ? 2 : 1)
    h.someContext = true
    h.context++
    if (h.replBeginning) h.replCopiable++
    else h.ptrnCopiable++
    h.texts[h.end] = take(h, line)
    return true
  },
}

// The newline of a side's last line goes where a `\` line follows it.
const lastOfSide = (h) => h.end === (h.replBeginning ? h.max : h.ptrnLines)
const take = (h, text) => text.length > 1 && lastOfSide(h) && h.reader.incomplete() ? text.slice(0, -1) : text

function changeLine(h, text) {
  let line = text.slice(1)
  if (line === '\n' && h.scanner.loose) line = ' \n'
  if (line[0] === ' ' || line[0] === '\t') line = line.slice(1)
  else if (missable(h)) return false
  if (!h.replBeginning) { if (h.ptrnPrefix === -1) h.ptrnPrefix = h.context } else if (h.replPrefix === -1) h.replPrefix = h.context
  h.texts[h.end] = take(h, line)
  h.context = 0
  return true
}

function eatenLine(h, text) {
  if (missable(h) && (!h.ptrnSpacesEaten || h.scanner.newStyle)) return false
  const length = text.length - (text[0] === '\t' ? 1 : 0)
  h.texts[h.end] = length > 1 && lastOfSide(h) && h.reader.incomplete() ? text.slice(0, length - 1) : text.slice(0, length)
  if (h.end === h.ptrnLines + 1) return true
  h.ptrnSpacesEaten ||= h.replBeginning !== 0
  h.someContext = true
  h.context++
  if (h.replBeginning) h.replCopiable++
  else h.ptrnCopiable++
  h.chars[h.end] = ' '
  return true
}

// The `---` line: where the old side should have ended, give or take the
// blank line that may stand before it — or the first line, when the old side
// was left out and is to be filled in from the new side's context lines.
function replacementLine(h, text) {
  if (h.ptrnPrefix === -1) h.ptrnPrefix = h.context
  h.ptrnSuffix = h.context
  if (h.replBeginning || h.end !== h.ptrnLines + 1 + (h.chars[h.end - 1] === '\n' ? 1 : 0)) {
    if (h.end !== 1) {
      if (!h.replBeginning) fatal(`${h.end <= h.ptrnLines ? 'Premature' : 'Overdue'} '---' at line ${h.reader.line}; check line numbers at line ${h.beg}`)
      if (!h.replCouldBeMissing) fatal(`duplicate '---' at line ${h.reader.line}; check line numbers at line ${h.beg + h.replBeginning}`)
      return false
    }
    h.ptrnMissing = true
    h.end = h.ptrnLines + 1
    h.ptrnPrefix = h.ptrnSuffix = -1
    h.fillsrc = h.end + 1
    h.filldst = 1
    h.fillcnt = h.ptrnLines
  }
  h.replBeginning = h.end
  h.backtrack = { at: h.reader.at, line: h.reader.line }
  h.replContext = h.context
  h.texts[h.end] = text
  h.chars[h.end] = '='
  let at = 0
  while (at < text.length && !isDigit(text[at])) at++
  const first = scanLinenum(h.reader, text, at)
  h.newFirst = first.value
  at = first.at
  if (text[at] === ',') {
    do if (++at >= text.length) malformed(h.reader, text)
    while (!isDigit(text[at]))
    h.replLines = scanLinenum(h.reader, text, at).value + 1 - h.newFirst
    if (h.replLines < 0) malformed(h.reader, text)
  } else if (h.newFirst) h.replLines = 1
  else { h.replLines = 0; h.newFirst = 1 }
  h.max = h.replLines + h.end
  grow(h.scanner, h.max)
  if (h.replLines !== h.ptrnCopiable && (h.scanner.prefixContext !== 0 || h.context !== 0 || h.replLines !== 1)) h.replCouldBeMissing = false
  h.context = 0
  return true
}

// hunk_done: a missing new side is read again from just after the `---`, to
// be filled in from the old side's context lines; the contexts are settled;
// and an old-style patch whose hunk needed what only the new style does is
// taken for the new style from here on.
function settle(h) {
  if (h.replMissing) {
    h.reader.at = h.backtrack.at
    h.reader.line = h.backtrack.line
    h.context = h.replContext
    h.fillsrc = 1
    h.filldst = h.replBeginning + 1
    h.fillcnt = h.replLines
    h.end = h.max
  } else if (!h.ptrnMissing && h.ptrnCopiable !== h.replCopiable) fatal(`context mangled in hunk at line ${h.beg}`)
  else if (!h.someContext && h.fillcnt === 1) {
    // A null first hunk with no context, expecting one line: an append.
    for (; h.filldst < h.end; h.filldst++) { h.chars[h.filldst] = h.chars[h.filldst + 1]; h.texts[h.filldst] = h.texts[h.filldst + 1] }
    h.end--
    h.oldFirst++
    h.fillcnt = 0
    h.ptrnLines = 0
  }
  h.prefix = h.replPrefix === -1 || (h.ptrnPrefix !== -1 && h.ptrnPrefix < h.replPrefix) ? h.ptrnPrefix : h.replPrefix
  h.suffix = h.ptrnSuffix !== -1 && h.ptrnSuffix < h.context ? h.ptrnSuffix : h.context
  h.scanner.prefixContext = h.prefix
  if (h.prefix === -1 || h.suffix === -1) mangled(h)
  if (h.fillcnt || (h.oldFirst > 1 && h.prefix + h.suffix < h.ptrnCopiable)) h.scanner.newStyle = true
}

// The side that was left out, from the other side's context lines.
function fill(h) {
  if (!h.fillcnt) return
  for (; h.fillcnt > 0; h.fillcnt--) {
    while (h.fillsrc <= h.end && h.fillsrc !== h.replBeginning && h.chars[h.fillsrc] !== ' ') h.fillsrc++
    if (h.end < h.fillsrc || h.fillsrc === h.replBeginning) mangled(h)
    h.chars[h.filldst] = h.chars[h.fillsrc]
    h.texts[h.filldst++] = h.texts[h.fillsrc++]
  }
  for (; h.fillsrc <= h.end && h.fillsrc !== h.replBeginning; h.fillsrc++) if (h.chars[h.fillsrc] === ' ') mangled(h)
}

// The array, as the hunk this code applies: old side from 1, new side after
// the `---` line and the blank line that may stand before it. A side holding
// a mark it has no use for — an addition among the old lines, a deletion
// among the new — is one GNU would apply by rules of its own, and is refused.
function shape(h) {
  const { chars, texts, ptrnLines, replLines } = h
  let start = ptrnLines + 1
  const blank = chars[start] === '\n'
  while (start <= h.end && (chars[start] === '=' || chars[start] === '\n')) start++
  const marks = { old: chars.slice(1, ptrnLines + 1), new: chars.slice(start, start + replLines) }
  if (marks.old.some((mark) => !' -!'.includes(mark)) || marks.new.some((mark) => !' +!'.includes(mark)) || marks.new.length !== replLines) {
    throw new UnsupportedError('feature', 'malformed context hunk', `a context hunk marked the way the hunk at line ${h.beg} is marked is not supported`)
  }
  const oldLines = texts.slice(1, ptrnLines + 1).map((text, i) => ({ tag: marks.old[i] === ' ' ? ' ' : '-', text }))
  const newLines = texts.slice(start, start + replLines).map((text, i) => ({ tag: marks.new[i] === ' ' ? ' ' : '+', text }))
  return { oldStart: h.oldFirst, oldLines, newStart: h.newFirst, newLines, prefix: h.prefix, suffix: h.suffix, fn: h.fn, marks, beg: h.beg, blank }
}
