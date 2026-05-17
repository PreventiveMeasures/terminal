// Commands that primarily transform text — they read from stdin
// or files and write to stdout. None of them mutate `ctx.cwd`.
// Each call to parseArgs declares the exact set of flags the
// command understands; unknown flags throw and are caught by
// `dispatch()` in `index.js`, which formats them as
// `${name}: ${message}` and returns an exit-1 stderr result.

import { parseArgs } from './parse.js'
import { err, ok, parseNonNegativeInt, readFilesFor, splitLines } from './util.js'
import { grep } from './grep.js'

function cat(stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['n'] })
  let content = stdin
  if (positional.length > 0) {
    const r = readFilesFor('cat', positional, ctx)
    if (r.error) return r.error
    content = r.inputs.map((f) => f.content).join('')
  }
  return ok(flags.has('n') ? numberLines(content) : content)
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

function head(stdin, tokens, ctx) {
  const { values, positional } = parseArgs(tokens, { valueShort: ['n'] })
  applyDashNumberShorthand(values, positional)
  const n = parseNonNegativeInt(values.get('n') ?? '10', 'head: -n')
  if (n.error) return n.error
  return takeLines('head', stdin, positional, ctx, (lines) => lines.slice(0, n.value))
}

function tail(stdin, tokens, ctx) {
  const { values, positional } = parseArgs(tokens, { valueShort: ['n'] })
  applyDashNumberShorthand(values, positional)
  const n = parseNonNegativeInt(values.get('n') ?? '10', 'tail: -n')
  if (n.error) return n.error
  // `slice(-0)` is `slice(0)` — the whole array — so guard explicitly.
  return takeLines('tail', stdin, positional, ctx, (lines) => n.value === 0 ? [] : lines.slice(-n.value))
}

// GNU shorthand: `head -200 file` is equivalent to `head -n 200 file`.
// parseArgs leaves `-200` in `positional` (the `^-\d/` guard keeps
// numeric-prefixed tokens out of the flag stream), so promote it
// here. Only honored when -n hasn't been set explicitly.
function applyDashNumberShorthand(values, positional) {
  if (values.has('n')) return
  if (positional[0] && /^-\d+$/u.test(positional[0])) {
    values.set('n', positional.shift().slice(1))
  }
}

function takeLines(cmd, stdin, files, ctx, picker) {
  const r = files.length > 0 ? readFilesFor(cmd, files, ctx) : { inputs: [{ name: null, content: stdin }] }
  if (r.error) return r.error
  const showHeader = r.inputs.length > 1
  const blocks = []
  for (let i = 0; i < r.inputs.length; i++) {
    const { name, content } = r.inputs[i]
    const picked = picker(splitLines(content)).join('\n')
    if (showHeader) blocks.push(`${i > 0 ? '\n' : ''}==> ${name} <==\n${picked}${picked ? '\n' : ''}`)
    else if (picked.length > 0) blocks.push(picked + '\n')
  }
  return ok(blocks.join(''))
}

function wc(stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['l', 'w', 'c'] })
  const which = pickWcFlags(flags)
  const r = positional.length > 0 ? readFilesFor('wc', positional, ctx) : { inputs: [{ name: null, content: stdin }] }
  if (r.error) return r.error
  const lines = []
  const total = { l: 0, w: 0, c: 0 }
  for (const { name, content } of r.inputs) {
    const counts = wcCounts(content)
    lines.push(formatWc(counts, name, which))
    total.l += counts.l; total.w += counts.w; total.c += counts.c
  }
  if (r.inputs.length > 1) lines.push(formatWc(total, 'total', which))
  return ok(lines.join('\n') + '\n')
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
    c: content.length,
  }
}

function formatWc(counts, name, which) {
  const parts = []
  if (which.l) parts.push(String(counts.l).padStart(7))
  if (which.w) parts.push(String(counts.w).padStart(7))
  if (which.c) parts.push(String(counts.c).padStart(7))
  return parts.join(' ') + (name ? ' ' + name : '')
}

function sort(stdin, tokens) {
  const { flags } = parseArgs(tokens, { short: ['r', 'u'] })
  let lines = splitLines(stdin)
  lines.sort()
  if (flags.has('r')) lines.reverse()
  if (flags.has('u')) {
    const seen = new Set()
    lines = lines.filter((l) => seen.has(l) ? false : (seen.add(l), true))
  }
  return ok(lines.length === 0 ? '' : lines.join('\n') + '\n')
}

// Collapse adjacent duplicate lines from stdin. Flags compose:
//   -c    prefix each kept line with its run count (7-wide right-aligned)
//   -d    keep only lines that appeared >= 2 times in their run
//   -u    keep only lines that appeared exactly once
//   -i    case-insensitive comparison (output preserves original case)
// `-d` and `-u` together produces no output (the empty intersection)
// rather than erroring — matches what GNU does on common versions
// and avoids surprising scripts that pass both flags.
function uniq(stdin, tokens) {
  const { flags } = parseArgs(tokens, { short: ['c', 'd', 'u', 'i'] })
  const showCount = flags.has('c')
  const onlyDups = flags.has('d')
  const onlyUniques = flags.has('u')
  const ignoreCase = flags.has('i')
  const norm = (s) => ignoreCase ? s.toLowerCase() : s
  const lines = splitLines(stdin)
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
  return ok(out.length === 0 ? '' : out.join('\n') + '\n')
}

function echo(_stdin, tokens) {
  const { flags, positional } = parseArgs(tokens, { short: ['n'] })
  const out = positional.join(' ')
  return ok(flags.has('n') ? out : out + '\n')
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
