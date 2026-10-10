// Line selection and presentation shared by grep's output modes. The loop
// over a file is GNU grep's own (grep.c: grepbuf, prtext, prpending, prline),
// down to what it does around a line it will not print: one holding a byte
// its locale cannot read is held back, the context and group separators go on
// as if it had never been there, and the file is said to be binary once the
// search is done with it.
import { MARKER, encodeUtf8Marked, joinLines, splitLines } from '../util.js'
import { UnsupportedError } from '../unsupported.js'
import { stepAt } from '../unicode.js'
import { markedRegex, plainRegex } from './grep-pattern.js'
import { heldBack, markedExtent } from './grep-literal.js'

export const anyMatch = (res, line) => res.some((re) => re.test(line))
export const noMatch = () => ({ stdout: '', stderr: '', exitCode: 1 })
export const isFailure = (item) => item.failure !== undefined
const label = (input) => input.name ?? '(standard input)'

// What a search reads a file as: lines, which in a file GNU calls binary for
// a NUL are ended by every NUL too -- it turns each into a line end before it
// looks. A file of bytes that spell no text is matched with the patterns that
// take no such byte for a character (markedRegex).
const contentOf = (input) => (input.binaryLine === undefined ? input.content : input.content.replaceAll('\0', '\n'))
export const matchersFor = (input, res) => res.map(input.marked ? markedRegex : plainRegex)

// Stop at the selection limit without splitting the unvisited suffix.
// A final newline ends its line; it does not create another empty line.
export function countMatches(input, res, invert, max) {
  // `-m0` reads nothing, which `-L` still lists.
  if (max === 0) return 0
  const tests = matchersFor(input, res)
  const content = contentOf(input)
  let count = 0
  if (max === Infinity) {
    // Native splitting is faster for uncapped counts across many small files.
    for (const line of splitLines(content)) if (anyMatch(tests, line) !== invert) count++
    return count
  }
  let start = 0
  while (start < content.length && count < max) {
    let end = content.indexOf('\n', start)
    if (end < 0) end = content.length
    if (anyMatch(tests, content.slice(start, end)) !== invert) count++
    start = end + 1
  }
  return count
}

// What a run writes, in the order GNU writes it: each file's lines, what it
// has to say about that file after them, and a file it could not open where
// that file came. Lines holding bytes that spell no text go out as the bytes.
function output() {
  const events = []
  const add = (fd, text) => {
    const last = events.at(-1)
    if (last?.fd === fd && last.text !== undefined) last.text += text
    else events.push({ fd, text })
  }
  return {
    events,
    out(text) { if (text) add(1, text) },
    // A file's lines, which for a file of bytes go out as the bytes they are.
    // The name in front of each is text like any other, so one that UTF-8
    // cannot spell is refused here as such text always is.
    lines(text, marked, name) {
      if (!marked || !MARKER.test(text)) return this.out(text)
      if (!name.isWellFormed()) throw new UnsupportedError('feature', 'unpaired surrogate', 'unpaired UTF-16 surrogates cannot be encoded as UTF-8')
      events.push({ fd: 1, bytes: encodeUtf8Marked(text) })
    },
    err(text) { if (text) add(2, text) },
  }
}

function written(events, selected) {
  const text = (fd) => events.filter((event) => event.fd === fd && event.text !== undefined).map((event) => event.text).join('')
  const bytes = events.some((event) => event.bytes !== undefined)
  return { stdout: bytes ? '' : text(1), stderr: text(2), exitCode: selected ? 0 : 1, events }
}

// Default mode: print matching lines, optionally with context.
// Context-line prefix uses `-` as the field separator (e.g.
// `file-12-content`); matches use `:`. `--` separates non-adjacent
// context groups, within a file and across files. -o emits matching
// substrings; with -v these can occur in context lines instead.
export function grepRun(items, res, opts) {
  const run = { used: false, write: output(), selected: false }
  for (const item of items) {
    if (isFailure(item)) run.write.err(item.failure)
    else grepFile(item, res, opts, run)
  }
  return written(run.write.events, run.selected)
}

// GNU's grep: the lines a read ends are searched, and then, once the file is
// done, a last line no newline ends, on its own -- with the lines before it
// kept for leading context, and where it last printed forgotten unless those
// lines begin there. A file is one read here: past GNU's first, a file whose
// lines can be held back is refused where that would show (contextAcrossReads).
function grepFile(input, res, opts, run) {
  if (input.binaryLine === 0) return grepBinary(input, res, opts, run)
  const content = contentOf(input)
  const f = {
    input, opts, run, lines: splitLines(content), res, tests: matchersFor(input, res), bufbeg: 0,
    name: (opts.showName ?? input.recursive) ? label(input) : null,
    out: [], lastout: null, pending: 0, outleft: opts.max ?? Infinity, quiet: false, heldBack: false,
  }
  const end = f.lines.length
  const ended = end > 0 && !content.endsWith('\n') ? end - 1 : end
  let selected = grepbuf(f, 0, ended)
  if (f.pending > 0) prpending(f, ended)
  if (ended < end && !(f.outleft === 0 && f.pending === 0) && !f.quiet) {
    let beg = ended
    for (let i = 0; i < opts.before && beg > 0 && beg !== f.lastout; i++) beg--
    if (beg !== f.lastout) f.lastout = null
    f.bufbeg = beg
    if (f.outleft > 0) selected += grepbuf(f, ended, end)
    if (f.pending > 0) prpending(f, end)
  }
  run.write.lines(joinLines(f.out), input.marked, f.name ?? '')
  if (selected > 0) run.selected = true
  // `-I` holds the same lines back and says nothing; `-a` holds none back.
  if (f.heldBack || f.quiet) binaryMatches(input, opts, run)
}

// A file binary from its top prints nothing at all, and its first selected
// line is the last thing GNU looks for.
function grepBinary(input, res, opts, run) {
  if (countMatches(input, res, opts.invert, 1) === 0) return
  run.used = run.selected = true
  binaryMatches(input, opts, run)
}

function binaryMatches(input, opts, run) {
  if (opts.binaryFiles === 'binary') run.write.err(`grep: ${label(input)}: binary file matches\n`)
}

// GNU's grepbuf: find each selected line from `from` up to `to` -- a block of
// them under -v -- and hand it to prtext. A NUL makes the file binary from
// where GNU finds it -- the top, where its first read held it -- and from there
// nothing is printed and the first selection is the last.
function grepbuf(f, from, to) {
  const { invert } = f.opts
  const binaryLine = f.input.binaryLine ?? Infinity
  let selected = 0
  for (let p = from; p < to;) {
    let b = p
    while (b < to && !anyMatch(f.tests, f.lines[b])) b++
    if (b === to && !invert) break
    if (!invert || p < b) {
      // A run of -v lines that crosses into the binary part is two: GNU
      // prints what its first read held before it reads the rest.
      if (invert && p < binaryLine && b > binaryLine) {
        selected += prtext(f, p, binaryLine)
        if (f.outleft === 0) break
        p = binaryLine
      }
      // Context still owed when the NUL is found was printed as the read
      // before it ended (lateBinary keeps it within that read).
      if (!f.quiet && (invert ? p : b) >= binaryLine) {
        if (f.pending > 0) prpending(f, binaryLine)
        f.quiet = true
      }
      selected += invert ? prtext(f, p, b) : prtext(f, b, b + 1)
      if (f.outleft === 0 || f.quiet) break
    }
    p = b + 1
  }
  return selected
}

// The lines from `beg` up to `lim`, with the leading context GNU reaches back
// for -- never past the last line it printed -- and the group separator where
// what it prints does not follow on from that line. `used` is set by any
// selection, printed or not, so a binary file's match separates the next one.
function prtext(f, beg, lim) {
  const { before, after, hasContext, invert } = f.opts
  if (!f.quiet && f.pending > 0) prpending(f, beg)
  let p = beg
  if (!f.quiet) {
    const bp = f.lastout ?? f.bufbeg
    for (let i = 0; i < before; i++) if (p > bp) p--
    if (hasContext && f.run.used && p !== f.lastout) f.out.push('--')
    for (; p < beg; p++) prline(f, p, false)
  }
  let n
  if (invert) {
    for (n = 0; p < lim && n < f.outleft; n++, p++) if (!f.quiet) prline(f, p, true)
  } else {
    if (!f.quiet) prline(f, beg, true)
    n = 1
  }
  f.pending = f.quiet ? 0 : after
  f.run.used = true
  f.outleft -= n
  return n
}

// Trailing context, which goes on through lines that would be selected once
// the cap is reached. It starts after the last line printed, which is the top
// of the file when none has been yet, and a line held back is not printed: it
// is tried again for every line of context still owed.
function prpending(f, lim) {
  f.lastout ??= f.bufbeg
  for (; f.pending > 0 && f.lastout < lim; f.pending--) prline(f, f.lastout, false)
}

function prline(f, i, selected) {
  const line = f.lines[i]
  if (!f.opts.only) {
    if (f.input.marked && f.opts.binaryFiles !== 'text' && MARKER.test(line) && heldBack(line)) {
      f.heldBack = true
      return
    }
    f.out.push(formatLine(f, line, i, selected))
  } else if (selected !== f.opts.invert) presentMatches(f, line, i, selected)
  f.lastout = i + 1
}

// Across patterns, choose the leftmost-longest nonoverlapping match each time.
// Skip zero-length matches while advancing by a full code point.
function presentMatches(f, line, i, selected) {
  const marked = f.input.marked && MARKER.test(line)
  let cursor = 0
  while (cursor < line.length) {
    let best = null
    for (let k = 0; k < f.res.length; k++) {
      const match = matchFrom(f.res[k], f.tests[k], line, cursor, marked)
      if (match && (!best || match.start < best.start || (match.start === best.start && match.end > best.end))) best = match
    }
    if (!best) break
    if (best.end === best.start) { cursor = best.end + stepAt(line, best.end); continue }
    f.out.push(formatLine(f, line.slice(best.start, best.end), i, selected))
    cursor = best.end
  }
}

// Where the pattern next matches: by the POSIX extent matcher where it has
// one, and by the matcher the line is selected with where it does not -- a
// global copy of it, kept apart so the one testing lines stays a plain RegExp.
const SCANS = new WeakMap()

function matchFrom(re, test, line, cursor, marked) {
  if (re.extent) return (marked ? re.markedExtent ??= markedExtent(re.extent) : re.extent).search(line, cursor)
  let scan = SCANS.get(test)
  if (!scan) SCANS.set(test, scan = new RegExp(test.source, test.flags + 'g'))
  scan.lastIndex = cursor
  const m = scan.exec(line)
  if (m && m[0] === '' && re.pcre) throw new UnsupportedError('feature', 'PCRE empty match extent', 'only-matching with empty PCRE matches is not supported')
  return m ? { start: m.index, end: m.index + m[0].length } : null
}

function formatLine(f, text, i, isMatch) {
  const sep = isMatch ? ':' : '-'
  return (f.name === null ? '' : f.name + sep) + (f.opts.showLine ? i + 1 + sep : '') + text
}

// -L lists files without selections, but status still reports any selected input.
export function grepSummary(items, res, { mode, invert, showName, max = Infinity }) {
  const write = output()
  let anySelected = false
  const limit = mode === 'c' ? max : Math.min(1, max)
  for (const item of items) {
    if (isFailure(item)) { write.err(item.failure); continue }
    const count = countMatches(item, res, invert, limit)
    if (count > 0) anySelected = true
    if (mode === 'c') write.out(((showName ?? item.recursive) ? label(item) + ':' + count : String(count)) + '\n')
    else if ((count > 0) === (mode === 'l')) write.out(label(item) + '\n')
  }
  return written(write.events, anySelected)
}
