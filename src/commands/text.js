// Text filters share strict option parsing and never change the working directory.

import { unsupported } from '../unsupported.js'
import { echo } from './echo.js'
import { printf } from './printf.js'
import { parseArgs } from '../args.js'
import { formatWc } from './wc-format.js'
import { consumeStdin, decodeUtf8, encodeUtf8Loose, err, joinLines, ok, okWith, parseNonNegativeInt, parseSignedCount, readContent, readInputs, splitLines } from '../util.js'
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
    return takeFrom(cmd, stdin, positional, ctx, () => '', banner, (content) => content, { noRead: true })
  }
  if (!isHead && count.value === 0 && !fromStart) return ok()
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
  return takeFrom(cmd, stdin, positional, ctx, pick, banner, leftover, !isHead && fromStart ? { stopOnDir: true } : undefined)
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
function takeFrom(cmd, stdin, files, ctx, pick, banner = null, leftover = () => '', readOptions) {
  const r = readInputs(cmd, files, stdin, ctx, readOptions)
  // `-q` / `-v` override the operand-count rule outright; `banner` is
  // null when neither was given.
  const showHeader = banner ?? files.length > 1
  const opened = r.entries.filter((e) => e.kind !== 'missing')
  const blocks = []
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
    // Both implicit stdin and an explicit - operand use the standard-input label.
    const label = name === null || name === '-' ? 'standard input' : name
    blocks.push(showHeader ? `${i > 0 ? '\n' : ''}==> ${label} <==\n${body}` : body)
  }
  return okWith(blocks.join(''), r)
}

function wc(stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['l', 'w', 'c', 'm'] })
  const which = pickWcFlags(flags)
  const r = readInputs('wc', positional, stdin, ctx)
  const needsWidth = positional.length > 1 || Object.values(which).filter(Boolean).length > 1
  // GNU aligns multi-column or multi-operand output using file sizes,
  // reserving seven columns when an input is a pipe of unknown size.
  const rows = []
  const total = { l: 0, w: 0, m: 0, c: 0 }
  // A directory is a row of zeros — GNU's `wc -l dir` prints `0 dir`
  // beside its error, because the open succeeded. A missing path gets
  // no row at all.
  for (const { name, content, kind, shared } of r.entries.filter((e) => e.kind !== 'missing')) {
    const counts = wcCounts(content, ctx, which, needsWidth)
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

// Character counts use code points in UTF-8 mode and bytes in an explicit C locale.
function wcCounts(content, ctx, which, needsWidth) {
  const locale = ctx.vars.get('LC_ALL') || ctx.vars.get('LC_CTYPE') || ctx.vars.get('LANG')
  const cLocale = locale === 'C' || locale === 'POSIX'
  const bytes = which.c || needsWidth || (which.m && cLocale) ? encodeUtf8Loose(content).length : 0
  return {
    l: which.l ? (content.match(/\n/gu) ?? []).length : 0,
    w: which.w ? (content.match(cLocale ? /[^\t\n\v\f\r ]+/gu : /[^\t\n\v\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u2060\u3000]+/gu) ?? []).length : 0,
    m: which.m ? cLocale ? bytes : content.length - (content.match(/[\u{10000}-\u{10FFFF}]/gu) ?? []).length : 0,
    c: bytes,
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
