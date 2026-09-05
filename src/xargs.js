// `xargs`, split out from the text-command registry once its input
// splitting grew three modes (whitespace, NUL, per-line) and two run
// shapes (chunked, placeholder-substituted).

import { parseArgs } from './parse.js'
import { err, ok, parseNonNegativeInt, splitLines } from './util.js'

export // Read whitespace-separated tokens from stdin and append them as
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
    short: ['r', '0'],
    valueShort: ['n', 'I'],
    stopAtFirstPositional: true,
  })
  const [cmd = 'echo', ...baseArgs] = positional
  const replace = values.get('I')
  // `-0` splits on NUL, the pairing for `find -print0`, so a path with
  // spaces survives as one item. `-I` splits on LINES instead: GNU
  // treats each line as a single argument there, which is why
  // `xargs -I{} echo [{}]` on `a b` prints `[a b]`, not `[a] [b]`.
  const items = flags.has('0') ? stdin.split('\0').filter(Boolean)
    : replace === undefined ? stdin.split(/\s+/u).filter(Boolean)
    // A blank line yields no item at all under `-I` — GNU runs the
    // command twice, not three times, for `a\n\nb\n`.
    : splitLines(stdin).filter((l) => l !== '')
  // `-I` runs the command once per item, substituting the placeholder
  // wherever it appears in the arguments — including inside a larger
  // word, as GNU does for `pre{} post{}`. With no items that is zero
  // invocations, so it is checked BEFORE the run-once-anyway fallback
  // below: substituting nothing and running the command with a literal
  // `{}` would be worse than not running it.
  // An empty placeholder would reach `replaceAll('', item)`, which
  // splices the item between every character of every argument —
  // `-I "" echo abc` would emit `xaxbxcx`. GNU refuses the invocation
  // outright, so refuse it here rather than silently corrupting args.
  if (replace === '') return err('xargs: -I: replacement string must not be empty')
  if (replace !== undefined) return xargsReplace(ctx, cmd, baseArgs, items, replace)
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

// One invocation per item, with every occurrence of the placeholder in
// the arguments replaced by that item. Output and exit status combine
// exactly as the chunked form's do.
function xargsReplace(ctx, cmd, baseArgs, items, replace) {
  let stdout = ''
  let stderr = ''
  let exitCode = 0
  for (const item of items) {
    const args = baseArgs.map((a) => a.replaceAll(replace, item))
    const r = ctx.dispatch(cmd, args, '')
    stdout += r.stdout
    stderr += r.stderr
    if (r.exitCode !== 0) exitCode = r.exitCode
  }
  return { stdout, stderr, exitCode }
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
