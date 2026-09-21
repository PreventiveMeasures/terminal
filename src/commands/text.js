// Text filters share strict option parsing and never change the working directory.

import { unsupported } from '../unsupported.js'
import { echo } from './echo.js'
import { printf } from './printf.js'
import { parseArgs } from '../args.js'
import { formatWc } from './wc-format.js'
import { byteLocale, classTables, consumeStdin, decodeUtf8, encodeUtf8Loose, err, inputLabel, joinLines, ok, okWith, parseNonNegativeInt, parseSignedCount, readContent, readInputs, splitLines, textOfFile, utf8CodePoints } from '../util.js'
import { awk } from '../awk/index.js'
import { grep } from './grep.js'
import { sort } from './sort.js'
import { xargs } from './xargs.js'

// head and tail share count syntax, byte/line slicing and operand presentation.
function headTail(cmd, stdin, tokens, ctx) {
  const { values, positional, order } = parseArgs(dashNumberShorthand(tokens), { short: ['q', 'v'], valueShort: ['c', 'n'] })
  const unit = order.findLast((o) => o.name === 'n' || o.name === 'c')?.name ?? 'n'
  const count = parseSignedCount(values.get(unit) ?? '10', cmd + ': -' + unit)
  if (count.error) return count.error
  const header = order.findLast((o) => o.name === 'q' || o.name === 'v')
  const banner = header ? header.name === 'v' : null
  const isHead = cmd === 'head'
  const fromStart = count.sign === '+'
  // head opens zero-count operands; tail's last-zero form opens nothing.
  if (isHead && count.value === 0 && count.sign !== '-') {
    return takeFrom(cmd, stdin, positional, ctx, () => '', { unit, banner, leftover: (content) => content, readOptions: { noRead: true } })
  }
  if (!isHead && count.value === 0 && !fromStart) {
    // A file snapshot may be stale; only buffered pipes can be counted unread.
    if (!ctx.stdinFile && (!positional.length || positional.includes('-') || positional.includes('/dev/stdin'))) {
      const note = truncationNote(cmd, stdin, '', unit, 'standard input')
      if (note) ctx.notes.add(note)
    }
    return ok()
  }
  const range = (total) => {
    if (isHead) return [0, count.sign === '-' ? Math.max(0, total - count.value) : count.value]
    const start = fromStart ? Math.min(total, Math.max(0, count.value - 1)) : Math.max(0, total - count.value)
    return [start, total]
  }
  const pick = (content) => {
    if (unit === 'c') return sliceBytes(content, range)
    const fromEnd = isHead ? count.sign === '-' : !fromStart
    const n = isHead || fromEnd ? count.value : Math.max(0, count.value - 1)
    const boundary = lineBoundary(content, n, fromEnd)
    return isHead ? content.slice(0, boundary) : content.slice(boundary)
  }
  const leftover = isHead ? headLeftover(count, unit, ctx) : undefined
  const readOptions = !isHead && fromStart ? { stopOnDir: true } : undefined
  return takeFrom(cmd, stdin, positional, ctx, pick, { unit, banner, leftover, readOptions })
}

// head -c leaves exactly the unread bytes. On file-backed stdin, -n also leaves
// unread lines; pipe reads and negative counts consume the buffered input.
function headLeftover(count, unit, ctx) {
  if (count.sign === '-' || (unit === 'n' && !ctx.stdinFile)) return () => ''
  if (unit === 'c') return (content) => sliceBytes(content, (total) => [Math.min(count.value, total), total])
  return (content) => content.slice(lineBoundary(content, count.value))
}

// A final newline terminates a record; it does not add an empty last record.
function lineBoundary(content, count, fromEnd = false) {
  if (fromEnd) {
    if (count === 0) return content.length
    let pos = content.length - Number(content.endsWith('\n'))
    for (let k = 0; k < count; k++) {
      if (pos <= 0) return 0
      pos = content.lastIndexOf('\n', pos - 1)
      if (pos < 0) return 0
    }
    return pos + 1
  }
  let pos = 0
  for (let k = 0; k < count && pos < content.length; k++) {
    const nl = content.indexOf('\n', pos)
    pos = nl === -1 ? content.length : nl + 1
  }
  return pos
}

// Only the first argument admits GNU's obsolete -NUM form. Rewrite it
// before option parsing so later -n/-c retain normal last-option precedence;
// other digit options are diagnosed, and -- still protects numeric filenames.
function dashNumberShorthand(tokens) {
  return /^-\d+$/u.test(tokens[0] ?? '') ? ['-n', tokens[0].slice(1), ...tokens.slice(1)] : tokens
}

// Output must remain valid UTF-8: partial bytes cannot cross a string
// pipeline faithfully, so the shared decoder reports that limitation.
function sliceBytes(content, range) {
  const bytes = encodeUtf8Loose(content)
  // `range` resolves against THIS input's byte length, so `-c -3` drops
  // the last three bytes of each input separately, as GNU does.
  const [start, end] = range(bytes.length)
  if (start === 0 && end >= bytes.length) return content
  return decodeUtf8(bytes.subarray(start, end))
}

// Banner presence depends on named operands, including missing ones. Only opened
// operands get banners; directories get an empty body. A later banner terminates
// the preceding body if needed. Shared stdin operands consume sequentially.
function takeFrom(cmd, stdin, files, ctx, pick, { unit, banner, leftover = () => '', readOptions }) {
  const r = readInputs(cmd, files, stdin, ctx, readOptions)
  // `-q` / `-v` override the operand-count rule outright; `banner` is
  // null when neither was given.
  const showHeader = banner ?? files.length > 1
  const opened = r.entries.filter((e) => e.kind !== 'missing')
  const blocks = [], notes = []
  let rest = null
  for (let i = 0; i < opened.length; i++) {
    const { name, kind, shared } = opened[i]
    let { content } = opened[i]
    if (shared || name === null) {
      if (rest !== null) content = rest
      rest = leftover(content)
      consumeStdin(ctx, rest)
    }
    // A directory yields no body at all — not even the newline an empty
    // line-pick would append — so `pick` is skipped for it entirely.
    const body = kind === 'dir' ? '' : pick(content)
    if (kind === 'file' && body !== content) {
      const note = truncationNote(cmd, content, body, unit, inputLabel(name, ctx))
      if (note) notes.push(note)
    }
    // Both implicit stdin and an explicit - operand use the standard-input label.
    const label = name === null || name === '-' ? 'standard input' : name
    blocks.push(showHeader ? `${i > 0 ? '\n' : ''}==> ${label} <==\n${body}` : body)
  }
  // A later slice may reject partial UTF-8 and discard the buffered output.
  for (const note of notes) ctx.notes.add(note)
  return okWith(blocks.join(''), r)
}

function countRecords(text) {
  let count = Number(text.length > 0 && !text.endsWith('\n'))
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++
  return count
}

function truncationNote(cmd, content, body, unit, input) {
  const count = unit === 'c' ? (text) => encodeUtf8Loose(text).length : countRecords
  const selected = count(body), total = count(content)
  if (selected >= total) return null
  const label = (unit === 'c' ? 'byte' : 'line') + (total === 1 ? '' : 's')
  return `${cmd}: selected ${selected} of ${total} ${label} from ${input}.`
}

function wc(stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['l', 'w', 'c', 'm'] })
  const which = pickWcFlags(flags)
  // Counted in what each file is: the text of one held as text, and the bytes
  // of one held as bytes, which this terminal may not be able to spell.
  const r = readInputs('wc', positional, stdin, ctx, { read: 'maybe-text' })
  const needsWidth = positional.length > 1 || Object.values(which).filter(Boolean).length > 1
  // GNU aligns multi-column or multi-operand output using file sizes,
  // reserving seven columns when an input is a pipe of unknown size.
  const rows = []
  const total = { l: 0, w: 0, m: 0, c: 0 }
  // A directory is a row of zeros — GNU's `wc -l dir` prints `0 dir`
  // beside its error, because the open succeeded. A missing path gets
  // no row at all.
  for (const { name, content, bytes, kind, shared } of r.entries.filter((e) => e.kind !== 'missing')) {
    const counts = wcCounts(bytes ?? content, ctx, which, needsWidth, () => inputLabel(name, ctx))
    rows.push({ counts, name, kind, shared })
    total.l += counts.l; total.w += counts.w; total.m += counts.m; total.c += counts.c
  }
  // Totals depend on named operands, even when some or all could not be read.
  const width = needsWidth ? wcColumnWidth(rows, ctx.stdinFile) : 1
  if (positional.length > 1) rows.push({ counts: total, name: 'total' })
  return okWith(joinLines(rows.map((row) => formatWc(row.counts, row.name, which, width, ctx))), r)
}

function wcColumnWidth(rows, stdinFile) {
  let bytes = 0
  let width = 1
  for (const { name, kind, shared, counts } of rows) {
    if (kind === 'dir' || ((name === null || shared) && !stdinFile)) width = 7
    else bytes += counts.c
  }
  return Math.max(width, String(bytes).length)
}

// Columns always follow lines, words, characters, bytes, regardless of flag order.
function pickWcFlags(flags) {
  if (flags.size === 0) return { l: true, w: true, m: false, c: true }
  return { l: flags.has('l'), w: flags.has('w'), m: flags.has('m'), c: flags.has('c') }
}

// `input` is the file as it is held: the text of one declared as text, or the
// bytes of one declared as bytes. Lines and words are counted in either, so a
// file this terminal cannot spell as text is counted like any other, and text
// is never encoded to be counted. Bytes are the size, which text has to be
// encoded to know; characters are the spelling itself, which bytes that spell
// no text do not have — the C locale counts them as the bytes they are, and a
// UTF-8 one says so rather than counting a guess.
function wcCounts(input, ctx, which, needsWidth, label) {
  const cLocale = byteLocale(ctx)
  const size = which.c || needsWidth || (which.m && cLocale) ? byteLength(input) : 0
  return {
    l: which.l ? countNewlines(input) : 0,
    w: which.w ? wordCount(input, ctx) : 0,
    m: which.m ? (cLocale ? size : characterCount(input, label)) : 0,
    c: size,
  }
}

const byteLength = (input) => typeof input === 'string' ? encodeUtf8Loose(input).length : input.length

// A newline is one byte and no part of another, and one character and no part
// of another, so counting them is counting lines whatever the file holds.
function countNewlines(input) {
  let lines = 0
  if (typeof input !== 'string') {
    for (const byte of input) if (byte === 0x0a) lines++
    return lines
  }
  for (let at = input.indexOf('\n'); at >= 0; at = input.indexOf('\n', at + 1)) lines++
  return lines
}

// A character of the text, which a JS string spells in one UTF-16 unit or two.
function characterCount(input, label) {
  const text = typeof input === 'string' ? input : textOfFile(input, label(), 'counting their characters')
  return text.length - (text.match(/[\u{10000}-\u{10FFFF}]/gu) ?? []).length
}

// wc's own reading of a word, which is coreutils' loop rather than a rule
// about blanks: the six blanks ASCII spells always part one, and past them
// only a printable character is looked at at all. A printable character
// glibc calls a space parts a word, and so do the four non-breaking spaces
// wc adds to them itself; any other printable character is a word's own; and
// everything else — a control, an unassigned code point, a byte that spells
// no character — passes through without beginning a word or ending one. So
// `\x01` alone is no word and `abc\x89def` is one, while U+2028, a space
// glibc does not call printable, joins the two sides of it into one.
const ASCII_BLANKS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20])
// wc's iswnbspace: the spaces it parts words on that glibc's own class does
// not hold. POSIXLY_CORRECT drops them, and nothing may set it here.
const NO_BREAK_SPACES = new Set([0x00a0, 0x2007, 0x202f, 0x2060])

// The three answers a character gets, and ASCII's own, which every locale
// here reads the same way: a table of them keeps a line of ordinary text off
// the locale's classes, which are ranges to search rather than an index.
const PARTS = 1
const PASSES = 0
const WORD = 2
const ASCII = Uint8Array.from({ length: 0x80 }, (_, code) =>
  ASCII_BLANKS.has(code) ? PARTS : code > 0x20 && code < 0x7f ? WORD : PASSES)

const classify = (code, tables) => tables.has('print', code)
  ? (tables.has('space', code) || NO_BREAK_SPACES.has(code) ? PARTS : WORD)
  : PASSES

function wordCount(input, ctx) {
  const tables = classTables(ctx.locale)
  let words = 0
  let inWord = false
  for (const code of wordCharacters(input, ctx)) {
    // A byte that spells no character is none, and so begins no word.
    const kind = code < 0 ? PASSES : code < 0x80 ? ASCII[code] : classify(code, tables)
    if (kind === PARTS) {
      if (inWord) words++
      inWord = false
    } else if (kind === WORD) inWord = true
  }
  return inWord ? words + 1 : words
}

// The characters wc reads one at a time: the text's own where it has text,
// and where it has bytes, the characters they spell — with -1 for a byte that
// spells none, which no class holds. A lone surrogate is read as the
// replacement character its bytes are, which is how every reader that only
// measures text reads one. The C locale reads bytes throughout, where each
// one is a character of its own.
function* wordCharacters(input, ctx) {
  if (typeof input !== 'string') { yield* byteLocale(ctx) ? input : utf8CodePoints(input); return }
  if (byteLocale(ctx)) { yield* encodeUtf8Loose(input); return }
  for (let at = 0; at < input.length;) {
    const code = input.codePointAt(at)
    yield code >= 0xd800 && code <= 0xdfff ? 0xfffd : code
    at += code > 0xffff ? 2 : 1
  }
}

// A skipped field includes its leading blanks, leaving the next field’s blanks
// in the comparison key: skipping one field of "k1 v1" leaves " v1".
function dropFields(line, n) {
  let i = 0
  for (let f = 0; f < n && i < line.length; f++) {
    while (i < line.length && /[ \t]/u.test(line[i])) i++
    while (i < line.length && !/[ \t]/u.test(line[i])) i++
  }
  return line.slice(i)
}

function uniq(stdin, tokens, ctx) {
  const { flags, values, positional } = parseArgs(tokens, {
    short: ['c', 'd', 'u', 'i', 'D'],
    valueShort: ['f', 's', 'w'],
  })
  if (positional.length > 2) return err(`uniq: extra operand: ${positional[2]}`)
  if (positional.length === 2 && positional[1] !== '-') return unsupported('feature', 'uniq', 'output file', 'uniq: output files are not supported (filesystem is read-only)')
  const skipFields = parseNonNegativeInt(values.get('f') ?? '0', 'uniq: -f')
  if (skipFields.error) return skipFields.error
  const skipChars = parseNonNegativeInt(values.get('s') ?? '0', 'uniq: -s')
  if (skipChars.error) return skipChars.error
  const width = values.has('w') ? parseNonNegativeInt(values.get('w'), 'uniq: -w') : { value: undefined }
  if (width.error) return width.error
  const allDups = flags.has('D')
  const showCount = flags.has('c')
  if (allDups && showCount) return err('uniq: printing all duplicated lines and repeat counts is meaningless')
  const r = readContent('uniq', positional.slice(0, 1), stdin, ctx)
  const onlyDups = flags.has('d')
  const onlyUniques = flags.has('u')
  const ignoreCase = flags.has('i')
  // Apply field skipping, byte skipping, then byte width; emit the original line.
  const norm = (line) => {
    const rest = skipFields.value > 0 ? dropFields(line, skipFields.value) : line
    if (skipChars.value === 0 && width.value === undefined) {
      // UTF-8 replaces lone surrogates, and byte case folding is ASCII-only.
      const text = rest.toWellFormed()
      return ignoreCase ? text.replace(/[A-Z]/gu, (c) => c.toLowerCase()) : text
    }
    const bytes = encodeUtf8Loose(rest).subarray(skipChars.value, width.value === undefined ? undefined : skipChars.value + width.value)
    // Keys may contain partial UTF-8: compare bytes without decoding or
    // emitting them. GNU uniq's -s/-w and C case folding operate on bytes.
    return (ignoreCase ? bytes.map((b) => b >= 65 && b <= 90 ? b + 32 : b) : bytes).join(',')
  }
  const lines = splitLines(r.content)
  const out = []
  let start = 0
  let key = lines.length ? norm(lines[0]) : null
  for (let end = 1; end <= lines.length; end++) {
    const next = end === lines.length ? null : norm(lines[end])
    if (end < lines.length && next === key) continue
    const count = end - start
    const isDup = count >= 2
    // -D outranks -d; adding -u removes each duplicate run's first line.
    const keep = allDups ? isDup
      : (onlyDups && onlyUniques) ? false
      : onlyDups ? isDup
      : onlyUniques ? !isDup
      : true
    if (keep) {
      if (allDups) out.push(...lines.slice(start + (onlyUniques ? 1 : 0), end))
      else out.push(showCount ? String(count).padStart(7) + ' ' + lines[start] : lines[start])
    }
    start = end
    key = next
  }
  return okWith(joinLines(out), r)
}

// These builtins accept and ignore arguments.
function cmdTrue() { return ok() }
function cmdFalse() { return { stdout: '', stderr: '', exitCode: 1 } }

export const TEXT_COMMANDS = {
  grep,
  head: (stdin, tokens, ctx) => headTail('head', stdin, tokens, ctx),
  tail: (stdin, tokens, ctx) => headTail('tail', stdin, tokens, ctx),
  wc, sort, uniq, echo, printf, xargs, awk,
}

export const TRIVIAL_COMMANDS = {
  true: cmdTrue, false: cmdFalse, ':': cmdTrue,
}
