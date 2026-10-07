// Text filters share strict option parsing and never change the working directory.

import { unsupported } from '../unsupported.js'
import { SHELL_STYLE_COMMANDS } from './programs.js'
import { parseArgs } from '../args.js'
import { formatWc } from './wc-format.js'
import { byteLocale, classTables, countNewlines, encodeUtf8Loose, err, joinLines, okWith, quoteLocale, readContent, readInputs, splitLines, usageError, utf8CodePoints } from '../util.js'
import { headTail } from './head-tail.js'
import { awk } from '../awk/index.js'
import { grep } from './grep.js'
import { sort } from './sort.js'
import { xargs } from './xargs.js'

function wc(stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['l', 'w', 'c', 'm'] })
  const which = pickWcFlags(flags)
  // Counted in what each input is: the text a pipe carried, and the bytes of
  // a file, which this terminal may not be able to spell — and need not spell
  // to be counted.
  const r = readInputs('wc', positional, stdin, ctx, { read: 'as-held' })
  const needsWidth = positional.length > 1 || Object.values(which).filter(Boolean).length > 1
  // GNU aligns multi-column or multi-operand output using file sizes,
  // reserving seven columns when an input is a pipe of unknown size.
  const rows = []
  const total = { l: 0, w: 0, m: 0, c: 0 }
  // A directory is a row of zeros — GNU's `wc -l dir` prints `0 dir`
  // beside its error, because the open succeeded. A missing path gets
  // no row at all.
  for (const { name, content, bytes, kind, shared } of r.entries.filter((e) => e.kind !== 'missing')) {
    const counts = wcCounts(bytes ?? content, ctx, which, needsWidth)
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

// `input` is the input as it is held: the text a pipe carried, or the bytes of
// a file. Lines and words are counted in either, so a file this terminal
// cannot spell as text is counted like any other, and text is never encoded
// to be counted. Bytes are the size, which text has to be
// encoded to know; characters are the spelling itself, which bytes that spell
// no text do not have — the C locale counts them as the bytes they are, and a
// UTF-8 one says so rather than counting a guess.
function wcCounts(input, ctx, which, needsWidth) {
  const cLocale = byteLocale(ctx)
  const size = which.c || needsWidth || (which.m && cLocale) ? byteLength(input) : 0
  return {
    l: which.l ? countNewlines(input) : 0,
    w: which.w ? wordCount(input, ctx) : 0,
    m: which.m ? (cLocale ? size : characterCount(input)) : 0,
    c: size,
  }
}

const byteLength = (input) => typeof input === 'string' ? encodeUtf8Loose(input).length : input.length

// A character of the text, which a JS string spells in one UTF-16 unit or two.
// Bytes are counted for the characters they do spell: a byte that spells none
// is a byte and not a character, which is what wc counts of one as well.
function characterCount(input) {
  if (typeof input === 'string') return input.length - (input.match(/[\u{10000}-\u{10FFFF}]/gu) ?? []).length
  let characters = 0
  for (const code of utf8CodePoints(input)) if (code >= 0) characters++
  return characters
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

// uniq reads its sizes as unsigned: blanks, a `+` and decimal digits, and
// one past the type's range saturates. Anything else is the error, which
// names the operand bare. Recorded from coreutils 9.4.
function uniqSize(text, what) {
  if (!/^[ \t\n\r\f\v]*\+?\d+$/u.test(text)) return { error: err(`uniq: ${text}: invalid number of ${what}`) }
  const value = BigInt(text.trim())
  return { value: value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value) }
}

function uniq(stdin, tokens, ctx) {
  const { flags, values, positional } = parseArgs(tokens, {
    short: ['c', 'd', 'u', 'i', 'D'],
    valueShort: ['f', 's', 'w'],
  })
  const skipFields = uniqSize(values.get('f') ?? '0', 'fields to skip')
  if (skipFields.error) return skipFields.error
  const skipChars = uniqSize(values.get('s') ?? '0', 'bytes to skip')
  if (skipChars.error) return skipChars.error
  const width = values.has('w') ? uniqSize(values.get('w'), 'bytes to compare') : { value: undefined }
  if (width.error) return width.error
  if (positional.length > 2) return usageError('uniq', `extra operand ${quoteLocale(positional[2], ctx)}`)
  const allDups = flags.has('D')
  const showCount = flags.has('c')
  if (allDups && showCount) return usageError('uniq', 'printing all duplicated lines and repeat counts is meaningless')
  if (positional.length === 2 && positional[1] !== '-') return unsupported('feature', 'uniq', 'output file', 'uniq: output files are not supported (filesystem is read-only)')
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

export const TEXT_COMMANDS = {
  grep,
  head: (stdin, tokens, ctx) => headTail('head', stdin, tokens, ctx),
  tail: (stdin, tokens, ctx) => headTail('tail', stdin, tokens, ctx),
  wc, sort, uniq, ...SHELL_STYLE_COMMANDS, xargs, awk,
}

export { PROGRAMS, TRIVIAL_COMMANDS, diagnosticName } from './programs.js'
