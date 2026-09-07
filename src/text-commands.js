// Commands that primarily transform text — they read from stdin
// or files and write to stdout. None of them mutate `ctx.cwd`.
// Each call to parseArgs declares the exact set of flags the
// command understands; unknown flags throw and are caught by
// `dispatch()` in `index.js`, which formats them as
// `${name}: ${message}` and returns an exit-1 stderr result.

import { unsupported } from './unsupported.js'
import { echo } from './echo.js'
import { parseArgs } from './parse.js'
import { consumeStdin, err, joinLines, ok, okWith, parseNonNegativeInt, parseSignedCount, readContent, readInputs, splitLines, utf8, utf8Decoder } from './util.js'
import { awk } from './awk.js'
import { grep } from './grep.js'
import { sort } from './sort.js'
import { xargs } from './xargs.js'

// cat displays actual UTF-8 bytes with -v; numbering uses the original
// lines so marking an empty line with -E never makes -b count it.
function cat(stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['n', 'b', 's', 'v', 'E', 'T', 'A', 'e', 't'] })
  const r = readContent('cat', positional, stdin, ctx)
  const showEnds = flags.has('E') || flags.has('A') || flags.has('e')
  const showTabs = flags.has('T') || flags.has('A') || flags.has('t')
  const visible = flags.has('v') || flags.has('A') || flags.has('e') || flags.has('t')
  const content = flags.has('s') ? squeezeBlankLines(r.content) : r.content
  let n = 0
  const out = (content.match(/[^\n]*\n|[^\n]+$/gu) ?? []).map((raw) => {
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

// Collapse every run of two or more blank lines into a single one.
function squeezeBlankLines(content) {
  if (content === '') return ''
  const trailing = content.endsWith('\n') ? '\n' : ''
  const lines = (trailing ? content.slice(0, -1) : content).split('\n')
  const out = []
  for (const line of lines) {
    if (line === '' && out.at(-1) === '') continue
    out.push(line)
  }
  return out.join('\n') + trailing
}

// `-n` counts lines, `-c` counts bytes; both default to 10 lines. A
// LEADING MINUS flips the count into "all but the last N" — `head -n -1`
// prints every line but the last, `head -c -3` every byte but the last
// three. `+N` is just the explicit form of the plain count. An
// over-large minus count leaves nothing rather than going negative,
// which is why the remainder is clamped at 0.
function head(stdin, tokens, ctx) {
  const { flags, values, positional, order } = parseArgs(dashNumberShorthand(tokens), { short: ['q', 'v'], valueShort: ['c', 'n'] })
  const unit = lastCountUnit(order)
  const count = parseSignedCount(values.get(unit) ?? '10', `head: -${unit}`)
  if (count.error) return count.error
  const banner = bannerMode(flags, order)
  // head always counts from the front; the sign only decides where the
  // slice STOPS — at N, or N short of the end.
  const range = (total) => [0, count.sign === '-' ? Math.max(0, total - count.value) : count.value]
  const leftover = headLeftover(count, unit, ctx)
  if (unit === 'c') return takeBytes('head', stdin, positional, ctx, range, banner, leftover)
  return takeLines('head', stdin, positional, ctx, (lines) => lines.slice(...range(lines.length)), banner, leftover)
}

// What a read of the standard input leaves for the next `-` operand, or
// the next command in the group, as GNU head leaves it (checked against
// coreutils 9.4): `-c N` reads exactly N bytes, and `-n N` on a regular
// file seeks back to the end of line N. The other forms read to the end
// — a minus count must see the end to know where to stop, and `-n N` on
// a pipe takes whole buffers, so anything shorter than one (8 KiB, not
// modeled) is gone with it.
function headLeftover(count, unit, ctx) {
  if (count.value === 0 && count.sign !== '-') return (content) => content
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

// Header options share one setting; the last spelling wins, including bundles.
function bannerMode(flags, order) {
  const last = order.findLast((o) => o.name === 'q' || o.name === 'v')
  if (last) return last.name === 'v'
  if (flags.has('q')) return false
  if (flags.has('v')) return true
  return null
}

// `-n` and `-c` set the same "how much" knob, so a line asking for both
// has to pick one. GNU lets the LAST one typed win — `head -n 5 -c 3`
// prints 3 bytes, `head -c 3 -n 5` prints 5 lines — which the per-name
// `values` map can't express (it loses ordering across names), so read
// the winner off parseArgs's `order`. Neither given (or only the `-NUM`
// shorthand, which promotes to `-n` and never reaches `order`) leaves
// head on lines, its default.
function lastCountUnit(order) {
  const last = order.findLast((o) => o.name === 'n' || o.name === 'c')
  return last ? last.name : 'n'
}

// Mirror image of head's rule: a LEADING PLUS counts from the START,
// so `tail -n +2` prints everything from line 2 on — the idiom for
// dropping a header row. The line number is 1-based, and `+0` is
// treated as `+1` (the whole file) rather than as an empty request.
// An unsigned count, or `-N`, is the familiar last-N.
function tail(stdin, tokens, ctx) {
  const { flags, values, positional, order } = parseArgs(dashNumberShorthand(tokens), { short: ['q', 'v'], valueShort: ['c', 'n'] })
  const unit = lastCountUnit(order)
  const n = parseSignedCount(values.get(unit) ?? '10', `tail: -${unit}`)
  if (n.error) return n.error
  const banner = bannerMode(flags, order)
  if (n.sign === '+') {
    // From position N, 1-based, so `+1` and `+0` are the whole input.
    const range = (total) => [Math.min(total, Math.max(0, n.value - 1)), total]
    if (unit === 'c') return takeBytes('tail', stdin, positional, ctx, range, banner)
    return takeLines('tail', stdin, positional, ctx, (lines) => lines.slice(...range(lines.length)), banner)
  }
  // A zero count short-circuits the whole command: GNU tail returns
  // success before opening anything, so there are no banners, no
  // per-operand errors, and exit 0 even when an operand doesn't exist.
  // Only the last-N form does this — `+0` above is the whole file, and
  // head deliberately does NOT share it either (`head -n 0 a b` still
  // banners both operands and still fails on a missing one). Returning
  // here also means `slice(-n)` below never sees 0, where `slice(-0)`
  // would be `slice(0)` and hand back every line.
  // ...but an invalid flag combination is still an invalid invocation:
  // check it before short-circuiting, or `tail -q -v -n 0` reads as
  // success where `head -q -v -n 0` correctly errors.
  if (n.value === 0) return banner?.error ? err(`tail: ${banner.error}`) : ok('')
  const range = (total) => [Math.max(0, total - n.value), total]
  if (unit === 'c') return takeBytes('tail', stdin, positional, ctx, range, banner)
  return takeLines('tail', stdin, positional, ctx, (lines) => lines.slice(...range(lines.length)), banner)
}

// Only the first argument admits GNU's obsolete -NUM form. Rewrite it
// before option parsing so later -n/-c retain normal last-option precedence;
// other digit options are diagnosed, and -- still protects numeric filenames.
function dashNumberShorthand(tokens) {
  return /^-\d+$/u.test(tokens[0] ?? '') ? ['-n', tokens[0].slice(1), ...tokens.slice(1)] : tokens
}

// `joinLines`, not a check on the JOINED string: one selected blank line
// joins to `''`, which is indistinguishable from having selected no
// lines at all, and suppressing its terminator would print nothing where
// GNU prints a newline. Branching on the array length keeps the two
// apart (`head -n 1` of a file of blank lines is one `\n`).
function takeLines(cmd, stdin, files, ctx, picker, banner, leftover) {
  return takeFrom(cmd, stdin, files, ctx, (content) => picker(content.match(/[^\n]*\n|[^\n]+$/gu) ?? []).join(''), banner, leftover)
}

// `head -c N` takes the first N BYTES of each input instead of its
// first N lines. No newline convention applies here: GNU writes the
// bytes verbatim, so `head -c 3` of `hello\n` is `hel` with nothing
// after it, and in the multi-input form it's the `\n` before the next
// banner that ends the block.
function takeBytes(cmd, stdin, files, ctx, range, banner, leftover) {
  return takeFrom(cmd, stdin, files, ctx, (content) => sliceBytes(content, range), banner, leftover)
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

// The head/tail output shape: each input's chunk, prefixed with GNU's
// `==> name <==` banner once more than one file was NAMED. Operands, not
// successful reads — GNU fixes this before opening anything, so a run
// whose other operands all turn out to be missing still banners the one
// that survived, rather than looking like a plain single-file read.
// No operands at all is stdin, which never banners.
//
// The operand count governs the THRESHOLD; which operands get a banner
// follows GNU's rule that anything it managed to OPEN is bannered. A
// directory opens fine and only fails on the read, so it gets a banner
// with an empty body; a missing path never opens and gets none. That is
// why this walks `entries` — every operand, with its kind — rather than
// `inputs`, the readable subset.
//
// A missing operand still contributes its stderr line and no block —
// and the `\n` that precedes
// every banner but the first still keys off the block index, matching
// GNU, whose own "first file" flag flips on the first banner WRITTEN,
// not on the first operand tried. That same `\n` is what terminates the
// preceding block when its chunk doesn't end in one.
//
// Operands that share the standard input (a `-`, or the nameless input
// of a command given no operand) read it in turn: each gets what the
// one before left, which `leftover` computes (nothing, unless the
// command stops short of the end, as `head -c N` does), and what the
// last one leaves is the next command's.
function takeFrom(cmd, stdin, files, ctx, pick, banner = null, leftover = () => '') {
  if (banner?.error) return err(`${cmd}: ${banner.error}`)
  const r = readInputs(cmd, files, stdin, ctx)
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
    // `name` is null for the stdin input, which only reaches here under
    // an explicit `-v` (no operands means no banner otherwise). GNU
    // titles it `standard input`; interpolating the null printed a
    // literal `==> null <==`. Same convention grep uses for stdin.
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
    const counts = wcCounts(content)
    rows.push({ counts, name })
    total.l += counts.l; total.w += counts.w; total.m += counts.m; total.c += counts.c
  }
  // GNU gates the total on how many files were NAMED, not how many it
  // read: `wc a missing` still totals, and `wc m1 m2` prints a lone
  // `0 total` rather than nothing. The same operand-versus-read rule the
  // head/tail banners and grep's name prefix already follow.
  if (positional.length > 1) rows.push({ counts: total, name: 'total' })
  const width = wcColumnWidth(which, r, positional.length, ctx.stdinFile)
  return okWith(joinLines(rows.map((row) => formatWc(row.counts, row.name, which, width))), r)
}

function wcColumnWidth(which, inputs, operands, stdinFile) {
  if (operands <= 1 && Object.values(which).filter(Boolean).length === 1) return 1
  let bytes = 0
  let width = 1
  for (const input of inputs.inputs) {
    if ((input.name === null || input.shared) && !stdinFile) width = 7
    else bytes += utf8.encode(input.content).length
  }
  return Math.max(width, String(bytes).length)
}

// `-m` sits between `-l` and `-w` in GNU's fixed output order
// (lines, words, chars, bytes), which is NOT the order the flags were
// typed in — `wc -cm` and `wc -mc` print the same two columns.
function pickWcFlags(flags) {
  const named = ['l', 'w', 'm', 'c'].filter((f) => flags.has(f))
  if (named.length === 0) return { l: true, w: true, m: false, c: true }
  return { l: flags.has('l'), w: flags.has('w'), m: flags.has('m'), c: flags.has('c') }
}

// `-c` is bytes, `-m` characters. They differ only on multibyte input:
// `héllo\n` is 7 bytes but 6 characters. GNU's `-m` follows the locale
// and collapses onto `-c` under a C locale; this terminal models UTF-8
// throughout (as `-c` and `head -c` already do), so `-m` counts code
// points — spreading an astral character across two UTF-16 units would
// count an emoji twice, hence the iterator rather than `.length`.
function wcCounts(content) {
  return {
    l: (content.match(/\n/gu) ?? []).length,
    w: (content.match(/\S+/gu) ?? []).length,
    m: [...content].length,
    c: utf8.encode(content).length,
  }
}

function formatWc(counts, name, which, width) {
  const parts = []
  if (which.l) parts.push(String(counts.l).padStart(width))
  if (which.w) parts.push(String(counts.w).padStart(width))
  if (which.m) parts.push(String(counts.m).padStart(width))
  if (which.c) parts.push(String(counts.c).padStart(width))
  return parts.join(' ') + (name ? ' ' + name : '')
}

// Collapse adjacent duplicate lines from stdin. Flags compose:
//   -c    prefix each kept line with its run count (7-wide right-aligned)
//   -d    keep only lines that appeared >= 2 times in their run
//   -u    keep only lines that appeared exactly once
//   -i    case-insensitive comparison (output preserves original case)
// `-d` and `-u` together produces no output (the empty intersection)
// rather than erroring — matches what GNU does on common versions
// and avoids surprising scripts that pass both flags.
// Drop the first N whitespace-delimited fields, leading blanks and all,
// the way `uniq -f` counts them: a field is a run of non-blanks, and the
// blanks BEFORE the next field belong to it, so `-f1` of `k1 v1` leaves
// ` v1`.
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
  // GNU refuses this pair outright rather than picking a meaning:
  // "printing all duplicated lines and repeat counts is meaningless".
  if (allDups && showCount) return err('uniq: printing all duplicated lines and repeat counts is meaningless')
  const r = readContent('uniq', positional.slice(0, 1), stdin, ctx)
  const onlyDups = flags.has('d')
  const onlyUniques = flags.has('u')
  const ignoreCase = flags.has('i')
  // The comparison key: drop `-f` whole fields, then `-s` characters,
  // then keep at most `-w`. GNU applies them in exactly that order, and
  // the key only ever decides EQUALITY — the line is emitted whole.
  const norm = (line) => {
    const rest = skipFields.value > 0 ? dropFields(line, skipFields.value) : line
    const bytes = utf8.encode(rest).subarray(skipChars.value, width.value === undefined ? undefined : skipChars.value + width.value)
    // Keys may contain partial UTF-8: compare bytes without decoding or
    // emitting them. GNU uniq's -s/-w and C case folding operate on bytes.
    return (ignoreCase ? bytes.map((b) => b >= 65 && b <= 90 ? b + 32 : b) : bytes).join(',')
  }
  const lines = splitLines(r.content)
  const out = []
  let prev = null
  let prevKey = null
  let count = 0
  let run = []
  const flush = () => {
    if (prev === null) return
    const isDup = count >= 2
    // `-D` outranks `-d`: GNU gives `uniq -D -d -u` the same output as
    // `uniq -D -u`, so it is tested before the `-d -u` empty-intersection
    // rule rather than after it.
    const keep = allDups ? isDup
      : (onlyDups && onlyUniques) ? false
      : onlyDups ? isDup
      : onlyUniques ? !isDup
      : true
    if (!keep) return
    // `-D` prints every line of the run rather than one representative,
    // so it is the only mode that needs the run kept around. Adding `-u`
    // drops each group's FIRST line — verified against GNU: a doubled
    // `a` prints once, a tripled `c` twice.
    if (allDups) out.push(...(onlyUniques ? run.slice(1) : run))
    else out.push(showCount ? `${String(count).padStart(7)} ${prev}` : prev)
  }
  for (const l of lines) {
    const key = norm(l)
    if (key === prevKey) { count++; run.push(l); continue }
    flush(); prev = l; prevKey = key; count = 1; run = [l]
  }
  flush()
  return okWith(joinLines(out), r)
}

// POSIX shell builtins: zero-arg, deterministic, useful for testing
// `;` / `&&` / `||` chains and as stand-ins in pipelines. Args are
// accepted and ignored, matching the spec.
function cmdTrue() { return ok() }
function cmdFalse() { return { stdout: '', stderr: '', exitCode: 1 } }

export const TEXT_COMMANDS = {
  cat, grep, head, tail, wc, sort, uniq, echo, xargs, awk,
}

// Dispatchable but unlisted: `true` / `false` / `:` are useful in
// chained pipelines but uninteresting to surface in completion or
// the "command not found" hint. index.js folds these into HIDDEN.
export const TRIVIAL_COMMANDS = {
  true: cmdTrue, false: cmdFalse, ':': cmdTrue,
}
