// Commands that primarily transform text — they read from stdin
// or files and write to stdout. None of them mutate `ctx.cwd`.
// Each call to parseArgs declares the exact set of flags the
// command understands; unknown flags throw and are caught by
// `dispatch()` in `index.js`, which formats them as
// `${name}: ${message}` and returns an exit-1 stderr result.

import { parseArgs } from './parse.js'
import { err, joinLines, ok, okWith, parseNonNegativeInt, parseSignedCount, readContent, readInputs, splitLines, utf8, utf8Decoder } from './util.js'
import { grep } from './grep.js'

function cat(stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['n'] })
  const r = readContent('cat', positional, stdin, ctx)
  return okWith(flags.has('n') ? numberLines(r.content) : r.content, r)
}

// GNU `cat -n` numbers lines starting from 1, right-aligned in a
// 6-wide field with a tab separator. Trailing newlines are
// preserved so `cat -n` of a file ending in '\n' produces output
// that also ends in '\n' (no extra blank line at the end).
function numberLines(content) {
  if (content === '') return ''
  const trailing = content.endsWith('\n') ? '\n' : ''
  const lines = trailing ? content.slice(0, -1).split('\n') : content.split('\n')
  return lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n') + trailing
}

// `-n` counts lines, `-c` counts bytes; both default to 10 lines. A
// LEADING MINUS flips the count into "all but the last N" — `head -n -1`
// prints every line but the last, `head -c -3` every byte but the last
// three. `+N` is just the explicit form of the plain count. An
// over-large minus count leaves nothing rather than going negative,
// which is why the remainder is clamped at 0.
function head(stdin, tokens, ctx) {
  const { values, positional, order } = parseArgs(tokens, { valueShort: ['c', 'n'] })
  applyDashNumberShorthand(tokens, values, positional)
  const unit = lastCountUnit(order)
  const count = parseSignedCount(values.get(unit) ?? '10', `head: -${unit}`)
  if (count.error) return count.error
  const keep = (total) => count.sign === '-' ? Math.max(0, total - count.value) : count.value
  if (unit === 'c') return takeBytes('head', stdin, positional, ctx, keep)
  return takeLines('head', stdin, positional, ctx, (lines) => lines.slice(0, keep(lines.length)))
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
  const { values, positional } = parseArgs(tokens, { valueShort: ['n'] })
  applyDashNumberShorthand(tokens, values, positional)
  const n = parseSignedCount(values.get('n') ?? '10', 'tail: -n')
  if (n.error) return n.error
  if (n.sign === '+') {
    return takeLines('tail', stdin, positional, ctx, (lines) => lines.slice(Math.max(0, n.value - 1)))
  }
  // A zero count short-circuits the whole command: GNU tail returns
  // success before opening anything, so there are no banners, no
  // per-operand errors, and exit 0 even when an operand doesn't exist.
  // Only the last-N form does this — `+0` above is the whole file, and
  // head deliberately does NOT share it either (`head -n 0 a b` still
  // banners both operands and still fails on a missing one). Returning
  // here also means `slice(-n)` below never sees 0, where `slice(-0)`
  // would be `slice(0)` and hand back every line.
  if (n.value === 0) return ok('')
  return takeLines('tail', stdin, positional, ctx, (lines) => lines.slice(-n.value))
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
function takeLines(cmd, stdin, files, ctx, picker) {
  return takeFrom(cmd, stdin, files, ctx, (content) => joinLines(picker(splitLines(content))))
}

// `head -c N` takes the first N BYTES of each input instead of its
// first N lines. No newline convention applies here: GNU writes the
// bytes verbatim, so `head -c 3` of `hello\n` is `hel` with nothing
// after it, and in the multi-input form it's the `\n` before the next
// banner that ends the block.
function takeBytes(cmd, stdin, files, ctx, keep) {
  return takeFrom(cmd, stdin, files, ctx, (content) => firstBytes(content, keep))
}

// A cut can land mid-character: `head -c 1` of `é` keeps only the
// leading byte of a two-byte sequence. No JS string can hold that lone
// byte, so the decoder yields U+FFFD — which is also what a real
// terminal renders for it, making this the closest a string-based model
// gets. The cost is that a severed character comes back OUT as 3 bytes:
// `head -c 2` of `héllo` pipes 4 bytes into `wc -c`, where GNU pipes
// exactly 2. Only a cut mid-character is affected. Content short enough
// to survive whole skips the round-trip entirely.
function firstBytes(content, keep) {
  const bytes = utf8.encode(content)
  // `keep` resolves against THIS input's byte length, so `-c -3` drops
  // the last three bytes of each input separately, as GNU does.
  const n = keep(bytes.length)
  if (n >= bytes.length) return content
  return utf8Decoder.decode(bytes.subarray(0, n))
}

// The head/tail output shape: each input's chunk, prefixed with GNU's
// `==> name <==` banner once more than one file was NAMED. Operands, not
// successful reads — GNU fixes this before opening anything, so a run
// whose other operands all turn out to be missing still banners the one
// that survived, rather than looking like a plain single-file read.
// No operands at all is stdin, which never banners.
//
// The operand count governs the THRESHOLD only; which operands get a
// banner is still whatever `readInputs` could read. GNU is subtler
// there: it banners anything it managed to OPEN, so a directory operand
// (open succeeds, read fails with EISDIR) gets a banner from GNU and
// none from us, since `readFilesFor` drops directories before we see
// them. Teaching that distinction to the shared reader would change
// cat/grep/wc too, so it stays a divergence for now.
//
// Only readable inputs are iterated, so an unreadable operand
// contributes its stderr line and no block — and the `\n` that precedes
// every banner but the first still keys off the block index, matching
// GNU, whose own "first file" flag flips on the first banner WRITTEN,
// not on the first operand tried. That same `\n` is what terminates the
// preceding block when its chunk doesn't end in one.
function takeFrom(cmd, stdin, files, ctx, pick) {
  const r = readInputs(cmd, files, stdin, ctx)
  const showHeader = files.length > 1
  const blocks = []
  for (let i = 0; i < r.inputs.length; i++) {
    const { name, content } = r.inputs[i]
    const body = pick(content)
    blocks.push(showHeader ? `${i > 0 ? '\n' : ''}==> ${name} <==\n${body}` : body)
  }
  return okWith(blocks.join(''), r)
}

function wc(stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['l', 'w', 'c'] })
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
  const total = { l: 0, w: 0, c: 0 }
  for (const { name, content } of r.inputs) {
    const counts = wcCounts(content)
    rows.push({ counts, name })
    total.l += counts.l; total.w += counts.w; total.c += counts.c
  }
  if (r.inputs.length > 1) rows.push({ counts: total, name: 'total' })
  const width = wcColumnWidth(rows, which)
  return okWith(joinLines(rows.map((row) => formatWc(row.counts, row.name, which, width))), r)
}

function wcColumnWidth(rows, which) {
  let max = 0
  for (const { counts } of rows) {
    if (which.l) max = Math.max(max, String(counts.l).length)
    if (which.w) max = Math.max(max, String(counts.w).length)
    if (which.c) max = Math.max(max, String(counts.c).length)
  }
  return max
}

function pickWcFlags(flags) {
  if (flags.has('l') || flags.has('w') || flags.has('c')) {
    return { l: flags.has('l'), w: flags.has('w'), c: flags.has('c') }
  }
  return { l: true, w: true, c: true }
}

function wcCounts(content) {
  return {
    l: (content.match(/\n/gu) ?? []).length,
    w: (content.match(/\S+/gu) ?? []).length,
    c: utf8.encode(content).length,
  }
}

function formatWc(counts, name, which, width) {
  const parts = []
  if (which.l) parts.push(String(counts.l).padStart(width))
  if (which.w) parts.push(String(counts.w).padStart(width))
  if (which.c) parts.push(String(counts.c).padStart(width))
  return parts.join(' ') + (name ? ' ' + name : '')
}

function sort(stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['n', 'r', 'u'] })
  // `sort a b` orders the concatenation of all inputs, matching coreutils.
  const r = readContent('sort', positional, stdin, ctx)
  let lines = splitLines(r.content)
  const numeric = flags.has('n')
  const unique = flags.has('u')
  if (numeric) {
    // -n orders by each line's leading numeric value. Equal values keep
    // input order (stable sort); without -u the whole line breaks the
    // tie (GNU's last-resort comparison). -u drops that tiebreak so
    // equal-value lines (e.g. `1` and `01`) dedupe in input order.
    const decorated = lines.map((line) => ({ line, key: numericKey(line) }))
    decorated.sort(unique
      ? (a, b) => a.key - b.key
      : (a, b) => (a.key - b.key) || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0))
    lines = decorated.map((d) => d.line)
  } else {
    lines.sort()
  }
  // Dedup in ascending order (keeping the first of each run) before -r
  // reverses, so the kept representative matches GNU regardless of -r.
  if (unique) {
    const seen = new Set()
    lines = lines.filter((l) => {
      const k = numeric ? numericKey(l) : l
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }
  if (flags.has('r')) lines.reverse()
  return okWith(joinLines(lines), r)
}

// GNU `sort -n`: a line's value is its leading numeric prefix — optional
// blanks, an optional `-`, then digits with an optional decimal part.
// Anything else (a `+` sign, scientific `e`, or non-digit) isn't numeric,
// so such lines sort as 0. Thousands separators aren't recognized (C locale).
function numericKey(line) {
  const m = /^[ \t]*(-?(?:\d+\.?\d*|\.\d+))/u.exec(line)
  return m ? Number(m[1]) : 0
}

// Collapse adjacent duplicate lines from stdin. Flags compose:
//   -c    prefix each kept line with its run count (7-wide right-aligned)
//   -d    keep only lines that appeared >= 2 times in their run
//   -u    keep only lines that appeared exactly once
//   -i    case-insensitive comparison (output preserves original case)
// `-d` and `-u` together produces no output (the empty intersection)
// rather than erroring — matches what GNU does on common versions
// and avoids surprising scripts that pass both flags.
function uniq(stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['c', 'd', 'u', 'i'] })
  const r = readContent('uniq', positional, stdin, ctx)
  const showCount = flags.has('c')
  const onlyDups = flags.has('d')
  const onlyUniques = flags.has('u')
  const ignoreCase = flags.has('i')
  const norm = (s) => ignoreCase ? s.toLowerCase() : s
  const lines = splitLines(r.content)
  const out = []
  let prev = null
  let prevKey = null
  let count = 0
  const flush = () => {
    if (prev === null) return
    const isDup = count >= 2
    const keep = (onlyDups && onlyUniques) ? false
      : onlyDups ? isDup
      : onlyUniques ? !isDup
      : true
    if (keep) out.push(showCount ? `${String(count).padStart(7)} ${prev}` : prev)
  }
  for (const l of lines) {
    const key = norm(l)
    if (key === prevKey) { count++; continue }
    flush(); prev = l; prevKey = key; count = 1
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

// Read whitespace-separated tokens from stdin and append them as
// extra args to CMD. With `-n N`, run CMD once per chunk of N
// items (so `find ... | xargs -n 1 cat` cats each file separately).
// With `-r`, skip the run entirely when stdin has no items (real
// xargs runs CMD once with no extra args by default; `-r` matches
// `--no-run-if-empty`). Defaults to `echo` when CMD is omitted.
function xargs(stdin, tokens, ctx) {
  // stopAtFirstPositional so flags after the inner command name
  // (e.g. `xargs grep -n PATTERN`) belong to grep, not to xargs.
  // Otherwise xargs greedily consumes `-n PATTERN` as its own
  // chunk-size flag and dies on `parseNonNegativeInt('PATTERN')`.
  const { flags, values, positional } = parseArgs(tokens, {
    short: ['r'],
    valueShort: ['n'],
    stopAtFirstPositional: true,
  })
  const [cmd = 'echo', ...baseArgs] = positional
  const items = stdin.split(/\s+/u).filter(Boolean)
  if (items.length === 0) {
    if (flags.has('r')) return ok()
    return ctx.dispatch(cmd, baseArgs, '')
  }
  const n = values.has('n') ? parseNonNegativeInt(values.get('n'), 'xargs: -n') : { value: items.length }
  if (n.error) return n.error
  // Unlike head/tail (where -n 0 = print nothing is meaningful),
  // xargs -n 0 has no useful interpretation: chunking by zero
  // would either loop forever or fall back to "no chunking".
  if (values.has('n') && n.value === 0) return err('xargs: -n: must be at least 1')
  return xargsRun(ctx, cmd, baseArgs, items, n.value)
}

function xargsRun(ctx, cmd, baseArgs, items, chunkSize) {
  let stdout = ''
  let stderr = ''
  let exitCode = 0
  for (let i = 0; i < items.length; i += chunkSize) {
    const r = ctx.dispatch(cmd, [...baseArgs, ...items.slice(i, i + chunkSize)], '')
    stdout += r.stdout
    stderr += r.stderr
    if (r.exitCode !== 0) exitCode = r.exitCode
  }
  return { stdout, stderr, exitCode }
}

// POSIX shell builtins: zero-arg, deterministic, useful for testing
// `;` / `&&` / `||` chains and as stand-ins in pipelines. Args are
// accepted and ignored, matching the spec.
function cmdTrue() { return ok() }
function cmdFalse() { return { stdout: '', stderr: '', exitCode: 1 } }

export const TEXT_COMMANDS = {
  cat, grep, head, tail, wc, sort, uniq, echo, xargs,
}

// Dispatchable but unlisted: `true` / `false` / `:` are useful in
// chained pipelines but uninteresting to surface in completion or
// the "command not found" hint. index.js folds these into HIDDEN.
export const TRIVIAL_COMMANDS = {
  true: cmdTrue, false: cmdFalse, ':': cmdTrue,
}
