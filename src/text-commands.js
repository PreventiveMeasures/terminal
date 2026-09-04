// Commands that primarily transform text — they read from stdin
// or files and write to stdout. None of them mutate `ctx.cwd`.
// Each call to parseArgs declares the exact set of flags the
// command understands; unknown flags throw and are caught by
// `dispatch()` in `index.js`, which formats them as
// `${name}: ${message}` and returns an exit-1 stderr result.

import { parseArgs } from './parse.js'
import { err, joinLines, ok, okWith, parseNonNegativeInt, parseSignedCount, readContent, readInputs, splitLines, utf8, utf8Decoder } from './util.js'
import { awk } from './awk.js'
import { grep } from './grep.js'
import { sort } from './sort.js'
import { xargs } from './xargs.js'

// `-n` numbers every line, `-b` only the non-blank ones (and wins when
// both are given, as in GNU). `-s` squeezes runs of blank lines to one.
// The display flags mark otherwise invisible characters: `-E` ends each
// line with `$`, `-T` shows tabs as `^I`, and `-A` is both (GNU's `-A`
// is `-vET`, and `-e` is `-vE`; the `-v` part, escaping other
// non-printables, has nothing to escape in this virtual FS's text).
function cat(stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['n', 'b', 's', 'E', 'T', 'A', 'e'] })
  const r = readContent('cat', positional, stdin, ctx)
  const showEnds = flags.has('E') || flags.has('A') || flags.has('e')
  const showTabs = flags.has('T') || flags.has('A')
  let content = r.content
  // Order matters and follows GNU: squeeze first, so numbering counts
  // the lines that actually survive, then mark, then number — a `$`
  // belongs after the text but inside the numbered line.
  if (flags.has('s')) content = squeezeBlankLines(content)
  if (showEnds || showTabs) content = markInvisible(content, showEnds, showTabs)
  if (flags.has('b')) content = numberLines(content, true)
  else if (flags.has('n')) content = numberLines(content, false)
  return okWith(content, r)
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

// `-E` appends `$` at end of line, `-T` renders a tab as the two
// characters `^I`. Both are applied per line so the `$` lands after any
// tab marking, matching GNU's `cat -A`.
function markInvisible(content, showEnds, showTabs) {
  if (content === '') return ''
  const trailing = content.endsWith('\n') ? '\n' : ''
  const lines = (trailing ? content.slice(0, -1) : content).split('\n')
  const mark = (l) => (showTabs ? l.replaceAll('\t', '^I') : l) + (showEnds ? '$' : '')
  return lines.map(mark).join('\n') + trailing
}

// GNU `cat -n` numbers lines starting from 1, right-aligned in a
// 6-wide field with a tab separator. Trailing newlines are
// preserved so `cat -n` of a file ending in '\n' produces output
// that also ends in '\n' (no extra blank line at the end).
function numberLines(content, skipBlank) {
  if (content === '') return ''
  const trailing = content.endsWith('\n') ? '\n' : ''
  const lines = trailing ? content.slice(0, -1).split('\n') : content.split('\n')
  let n = 0
  // `-b` leaves a blank line completely unprefixed — no number, no
  // padding, unlike `nl`, which blanks the column instead. The counter
  // only advances on the lines it numbers.
  const number = (l) => skipBlank && l === ''
    ? l
    : `${String(++n).padStart(6)}\t${l}`
  return lines.map(number).join('\n') + trailing
}

// `-n` counts lines, `-c` counts bytes; both default to 10 lines. A
// LEADING MINUS flips the count into "all but the last N" — `head -n -1`
// prints every line but the last, `head -c -3` every byte but the last
// three. `+N` is just the explicit form of the plain count. An
// over-large minus count leaves nothing rather than going negative,
// which is why the remainder is clamped at 0.
function head(stdin, tokens, ctx) {
  const { flags, values, positional, order } = parseArgs(tokens, { short: ['q', 'v'], valueShort: ['c', 'n'] })
  applyDashNumberShorthand(tokens, values, positional)
  const unit = lastCountUnit(order)
  const count = parseSignedCount(values.get(unit) ?? '10', `head: -${unit}`)
  if (count.error) return count.error
  const banner = bannerMode(flags)
  // head always counts from the front; the sign only decides where the
  // slice STOPS — at N, or N short of the end.
  const range = (total) => [0, count.sign === '-' ? Math.max(0, total - count.value) : count.value]
  if (unit === 'c') return takeBytes('head', stdin, positional, ctx, range, banner)
  return takeLines('head', stdin, positional, ctx, (lines) => lines.slice(...range(lines.length)), banner)
}

// `-v` always banners, `-q` never does, and with neither the operand
// count decides (see `takeFrom`). GNU lets the two coexist, last one
// winning, but parseArgs collapses booleans into a Set — so, following
// grep's precedent for -h/-H, a line asking for both is an error rather
// than a silent guess.
function bannerMode(flags) {
  if (flags.has('q') && flags.has('v')) return { error: '-q and -v are mutually exclusive' }
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
  const { flags, values, positional, order } = parseArgs(tokens, { short: ['q', 'v'], valueShort: ['c', 'n'] })
  applyDashNumberShorthand(tokens, values, positional)
  const unit = lastCountUnit(order)
  const n = parseSignedCount(values.get(unit) ?? '10', `tail: -${unit}`)
  if (n.error) return n.error
  const banner = bannerMode(flags)
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

// GNU's obsolete shorthand: `head -200 file` means `head -n 200 file`.
// POSITION is the whole rule. GNU rewrites `-NUM` to `-n NUM` only when
// it is the FIRST argument, so it then loses to any later count the
// same way one `-n` loses to the next (`head -1 -c 3` prints 3 bytes,
// `head -2 -n 1` prints 1 line); a `-NUM` anywhere else is rejected
// outright as an "invalid trailing option". Hence the check against
// `tokens[0]` rather than the first positional — the two forms leave
// `positional` looking identical.
//
// A trailing `-NUM` is where we diverge: it stays positional and fails
// as a missing file operand, so unlike GNU (which rejects the line
// before opening anything) the other operands are still read and still
// print. An error either way, but not the same error, and not the same
// stdout.
function applyDashNumberShorthand(tokens, values, positional) {
  const first = tokens[0] ?? ''
  if (!/^-\d+$/u.test(first)) return
  // parseArgs's `^-\d/` guard routes such a token straight to
  // `positional`, and this one led the line, so it heads that list too.
  positional.shift()
  // Deliberately does NOT clobber an explicit `-n`: `head -1 -n 2` is
  // the later option's count, exactly as `lastCountUnit` resolves `-c`.
  if (!values.has('n')) values.set('n', first.slice(1))
}

// `joinLines`, not a check on the JOINED string: one selected blank line
// joins to `''`, which is indistinguishable from having selected no
// lines at all, and suppressing its terminator would print nothing where
// GNU prints a newline. Branching on the array length keeps the two
// apart (`head -n 1` of a file of blank lines is one `\n`).
function takeLines(cmd, stdin, files, ctx, picker, banner) {
  return takeFrom(cmd, stdin, files, ctx, (content) => joinLines(picker(splitLines(content))), banner)
}

// `head -c N` takes the first N BYTES of each input instead of its
// first N lines. No newline convention applies here: GNU writes the
// bytes verbatim, so `head -c 3` of `hello\n` is `hel` with nothing
// after it, and in the multi-input form it's the `\n` before the next
// banner that ends the block.
function takeBytes(cmd, stdin, files, ctx, range, banner) {
  return takeFrom(cmd, stdin, files, ctx, (content) => sliceBytes(content, range), banner)
}

// A cut can land mid-character: `head -c 1` of `é` keeps only the
// leading byte of a two-byte sequence. No JS string can hold that lone
// byte, so the decoder yields U+FFFD — which is also what a real
// terminal renders for it, making this the closest a string-based model
// gets. The cost is that a severed character comes back OUT as 3 bytes:
// `head -c 2` of `héllo` pipes 4 bytes into `wc -c`, where GNU pipes
// exactly 2. Only a cut mid-character is affected. Content short enough
// to survive whole skips the round-trip entirely.
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
function takeFrom(cmd, stdin, files, ctx, pick, banner = null) {
  if (banner?.error) return err(`${cmd}: ${banner.error}`)
  const r = readInputs(cmd, files, stdin, ctx)
  // `-q` / `-v` override the operand-count rule outright; `banner` is
  // null when neither was given.
  const showHeader = banner ?? files.length > 1
  const opened = r.entries.filter((e) => e.kind !== 'missing')
  const blocks = []
  for (let i = 0; i < opened.length; i++) {
    const { name, content, kind } = opened[i]
    // A directory yields no body at all — not even the newline an empty
    // line-pick would append — so `pick` is skipped for it entirely.
    const body = kind === 'dir' ? '' : pick(content)
    // `name` is null for the stdin input, which only reaches here under
    // an explicit `-v` (no operands means no banner otherwise). GNU
    // titles it `standard input`; interpolating the null printed a
    // literal `==> null <==`. Same convention grep uses for stdin.
    blocks.push(showHeader ? `${i > 0 ? '\n' : ''}==> ${name ?? 'standard input'} <==\n${body}` : body)
  }
  return okWith(blocks.join(''), r)
}

function wc(stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['l', 'w', 'c', 'm'] })
  const which = pickWcFlags(flags)
  const r = readInputs('wc', positional, stdin, ctx)
  // Collect rows first so we can compute the adaptive column width:
  // every count is padded to the widest across ALL rows, the `total`
  // included. `wc -l b` on a 3-line file emits `3 b`; the same on a
  // 1234-line file emits `1234 b`; `wc -l small big` pads to the max:
  // `   3 small\n1234 big\n1237 total`.
  //
  // GNU derives that width differently — from the largest count the
  // inputs COULD produce, i.e. their byte size — so it pads `wc -l` of
  // a 27-byte 4-line file to width 2 where this pads to 1. Widening on
  // bytes nobody counted reads as a bug rather than alignment, so the
  // divergence is deliberate; both keep the columns aligned.
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
  const width = wcColumnWidth(rows, which)
  return okWith(joinLines(rows.map((row) => formatWc(row.counts, row.name, which, width))), r)
}

function wcColumnWidth(rows, which) {
  let max = 0
  for (const { counts } of rows) {
    if (which.l) max = Math.max(max, String(counts.l).length)
    if (which.w) max = Math.max(max, String(counts.w).length)
    if (which.m) max = Math.max(max, String(counts.m).length)
    if (which.c) max = Math.max(max, String(counts.c).length)
  }
  return max
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
    while (i < line.length && /\s/u.test(line[i])) i++
    while (i < line.length && !/\s/u.test(line[i])) i++
  }
  return line.slice(i)
}

function uniq(stdin, tokens, ctx) {
  const { flags, values, positional } = parseArgs(tokens, {
    short: ['c', 'd', 'u', 'i', 'D'],
    valueShort: ['f', 's', 'w'],
  })
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
  const r = readContent('uniq', positional, stdin, ctx)
  const onlyDups = flags.has('d')
  const onlyUniques = flags.has('u')
  const ignoreCase = flags.has('i')
  // The comparison key: drop `-f` whole fields, then `-s` characters,
  // then keep at most `-w`. GNU applies them in exactly that order, and
  // the key only ever decides EQUALITY — the line is emitted whole.
  const norm = (line) => {
    let rest = skipFields.value > 0 ? dropFields(line, skipFields.value) : line
    if (skipChars.value > 0) rest = rest.slice(skipChars.value)
    if (width.value !== undefined) rest = rest.slice(0, width.value)
    return ignoreCase ? rest.toLowerCase() : rest
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

// `-n` drops the trailing newline; `-e` enables backslash-escape
// interpretation (`-E`, the default, disables it). The parser tracks
// flags in a set, not by order, so when both `-e` and `-E` appear we
// honor `-e` rather than bash's last-one-wins — a rare combination.
function echo(_stdin, tokens) {
  const { flags, positional } = parseArgs(tokens, { short: ['n', 'e', 'E'] })
  let out = positional.join(' ')
  let trailingNewline = !flags.has('n')
  if (flags.has('e')) {
    const r = interpretEscapes(out)
    out = r.text
    // `\c` halts output and suppresses the trailing newline.
    if (r.stop) trailingNewline = false
  }
  return ok(trailingNewline ? out + '\n' : out)
}

// Backslash escapes recognized by GNU coreutils `echo -e`. `\c` stops
// all further output; octal `\0NNN` (up to 3 digits) and hex `\xHH`
// (up to 2 digits) map to the matching code point. An unrecognized
// escape keeps its backslash literal, as GNU does.
function interpretEscapes(s) {
  // letter -> code point: BEL, BS, ESC, FF, LF, CR, TAB, VT, backslash.
  const simple = { a: 7, b: 8, e: 27, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92 }
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\' || i + 1 >= s.length) { out += s[i]; continue }
    const c = s[++i]
    if (c === 'c') return { text: out, stop: true }
    if (c in simple) { out += String.fromCodePoint(simple[c]); continue }
    if (c === '0') {
      let digits = ''
      while (digits.length < 3 && /[0-7]/u.test(s[i + 1] ?? '')) digits += s[++i]
      out += String.fromCodePoint(digits === '' ? 0 : parseInt(digits, 8))
      continue
    }
    if (c === 'x' && /[0-9a-fA-F]/u.test(s[i + 1] ?? '')) {
      let digits = ''
      while (digits.length < 2 && /[0-9a-fA-F]/u.test(s[i + 1] ?? '')) digits += s[++i]
      out += String.fromCodePoint(parseInt(digits, 16))
      continue
    }
    out += '\\' + c
  }
  return { text: out, stop: false }
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
