// Text filters share strict option parsing and never change the working directory.

import { unsupported } from '../unsupported.js'
import { echo } from './echo.js'
import { parseArgs } from '../args.js'
import { formatWc } from './wc-format.js'
import { consumeStdin, err, joinLines, lineRecords, ok, okWith, parseNonNegativeInt, parseSignedCount, readContent, readInputs, splitLines, utf8, utf8Decoder } from '../util.js'
import { awk } from '../awk/index.js'
import { grep } from './grep.js'
import { sort } from './sort.js'
import { xargs } from './xargs.js'

// cat displays actual UTF-8 bytes with -v; numbering uses the original
// lines so marking an empty line with -E never makes -b count it.
function cat(stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['n', 'b', 's', 'v', 'E', 'T', 'A', 'e', 't'] })
  const r = readContent('cat', positional, stdin, ctx)
  if (!flags.size) return okWith(r.content, r)
  const showEnds = flags.has('E') || flags.has('A') || flags.has('e')
  const showTabs = flags.has('T') || flags.has('A') || flags.has('t')
  const visible = flags.has('v') || flags.has('A') || flags.has('e') || flags.has('t')
  const content = flags.has('s') ? squeezeBlankLines(r.content) : r.content
  let n = 0
  const out = lineRecords(content).map((raw) => {
    const ended = raw.endsWith('\n')
    let line = ended ? raw.slice(0, -1) : raw
    const prefix = (flags.has('b') ? line !== '' : flags.has('n')) ? `${String(++n).padStart(6)}\t` : ''
    if (visible) line = [...utf8.encode(line)].map((b) => visibleByte(b, showTabs)).join('')
    else {
      if (showTabs) line = line.replaceAll('\t', '^I')
      if (showEnds && ended && line.endsWith('\r')) line = line.slice(0, -1) + '^M'
    }
    return prefix + line + (ended ? (showEnds ? '$\n' : '\n') : '')
  }).join('')
  return okWith(out, r)
}

function visibleByte(b, tabs) {
  if (b === 9) return tabs ? '^I' : '\t'
  if (b >= 128) return 'M-' + visibleByte(b - 128, true)
  if (b < 32) return '^' + String.fromCodePoint(b + 64)
  return b === 127 ? '^?' : String.fromCodePoint(b)
}

// Keep one blank line, plus the preceding nonempty line's terminator if present.
function squeezeBlankLines(content) {
  return content.replace(/(^|\n)\n+/gu, '$1\n')
}

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
    const lines = lineRecords(content)
    return lines.slice(...range(lines.length)).join('')
  }
  const leftover = isHead ? headLeftover(count, unit, ctx) : undefined
  return takeFrom(cmd, stdin, positional, ctx, pick, banner, leftover, !isHead && fromStart ? { stopOnDir: true } : undefined)
}

// head -c leaves exactly the unread bytes. On file-backed stdin, -n also leaves
// unread lines; pipe reads and negative counts consume the buffered input.
function headLeftover(count, unit, ctx) {
  if (count.sign === '-' || (unit === 'n' && !ctx.stdinFile)) return () => ''
  if (unit === 'c') return (content) => sliceBytes(content, (total) => [Math.min(count.value, total), total])
  return (content) => {
    let pos = 0
    for (let k = 0; k < count.value && pos < content.length; k++) {
      const nl = content.indexOf('\n', pos)
      pos = nl === -1 ? content.length : nl + 1
    }
    return content.slice(pos)
  }
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
  const bytes = utf8.encode(content)
  // `range` resolves against THIS input's byte length, so `-c -3` drops
  // the last three bytes of each input separately, as GNU does.
  const [start, end] = range(bytes.length)
  if (start === 0 && end >= bytes.length) return content
  return utf8Decoder.decode(bytes.subarray(start, end))
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
  // GNU aligns multi-column or multi-operand output using file sizes,
  // reserving seven columns when an input is a pipe of unknown size.
  const rows = []
  const total = { l: 0, w: 0, m: 0, c: 0 }
  // A directory is a row of zeros — GNU's `wc -l dir` prints `0 dir`
  // beside its error, because the open succeeded. A missing path gets
  // no row at all.
  for (const { name, content } of r.entries.filter((e) => e.kind !== 'missing')) {
    const counts = wcCounts(content, ctx)
    rows.push({ counts, name })
    total.l += counts.l; total.w += counts.w; total.m += counts.m; total.c += counts.c
  }
  // Totals depend on named operands, even when some or all could not be read.
  if (positional.length > 1) rows.push({ counts: total, name: 'total' })
  const width = wcColumnWidth(which, r, positional.length, ctx.stdinFile)
  return okWith(joinLines(rows.map((row) => formatWc(row.counts, row.name, which, width, ctx))), r)
}

function wcColumnWidth(which, inputs, operands, stdinFile) {
  if (operands <= 1 && Object.values(which).filter(Boolean).length === 1) return 1
  let bytes = 0
  let width = inputs.entries.some((e) => e.kind === 'dir') ? 7 : 1
  for (const input of inputs.inputs) {
    if ((input.name === null || input.shared) && !stdinFile) width = 7
    else bytes += utf8.encode(input.content).length
  }
  return Math.max(width, String(bytes).length)
}

// Columns always follow lines, words, characters, bytes, regardless of flag order.
function pickWcFlags(flags) {
  if (flags.size === 0) return { l: true, w: true, m: false, c: true }
  return { l: flags.has('l'), w: flags.has('w'), m: flags.has('m'), c: flags.has('c') }
}

// Character counts use code points in UTF-8 mode and bytes in an explicit C locale.
function wcCounts(content, ctx) {
  const locale = ctx.vars.get('LC_ALL') || ctx.vars.get('LC_CTYPE') || ctx.vars.get('LANG')
  const cLocale = locale === 'C' || locale === 'POSIX'
  const bytes = utf8.encode(content).length
  return {
    l: (content.match(/\n/gu) ?? []).length,
    w: (content.match(cLocale ? /[^\t\n\v\f\r ]+/gu : /[^\t\n\v\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u2060\u3000]+/gu) ?? []).length,
    m: cLocale ? bytes : [...content].length,
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
    const bytes = utf8.encode(rest).subarray(skipChars.value, width.value === undefined ? undefined : skipChars.value + width.value)
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
  cat, grep,
  head: (stdin, tokens, ctx) => headTail('head', stdin, tokens, ctx),
  tail: (stdin, tokens, ctx) => headTail('tail', stdin, tokens, ctx),
  wc, sort, uniq, echo, xargs, awk,
}

export const TRIVIAL_COMMANDS = {
  true: cmdTrue, false: cmdFalse, ':': cmdTrue,
}
