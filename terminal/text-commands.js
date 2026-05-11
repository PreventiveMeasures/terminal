// Commands that primarily transform text — they read from stdin
// or files and write to stdout. None of them mutate `ctx.cwd`.
// Each call to parseArgs declares the exact set of flags the
// command understands; unknown flags throw and are caught by
// `dispatch()` in `index.js`, which formats them as
// `${name}: ${message}` and returns an exit-1 stderr result.

import { resolve } from './fs.js'
import { parseArgs } from './parse.js'
import { err, ok, parseNonNegativeInt, readFilesFor, splitLines, usage } from './util.js'

function cat(stdin, tokens, ctx) {
  const { positional } = parseArgs(tokens)
  if (positional.length === 0) return ok(stdin)
  const r = readFilesFor('cat', positional, ctx)
  if (r.error) return r.error
  return ok(r.inputs.map((f) => f.content).join(''))
}

function grep(stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['i', 'v', 'n', 'r'] })
  if (positional.length === 0) return usage('grep', 'grep [-i] [-v] [-n] [-r] PATTERN [PATH...]')
  const [pattern, ...rest] = positional
  let re
  try { re = new RegExp(pattern, flags.has('i') ? 'i' : '') } catch (e) {
    return err(`grep: invalid pattern: ${e.message}`)
  }
  const recursive = flags.has('r')
  const r = grepInputs(recursive, stdin, rest, ctx)
  if (r.error) return r.error
  // Always prefix matches with the file name under -r (matches are
  // from discovered descendants, not the typed path); without -r,
  // only when more than one file was named explicitly.
  const showName = recursive || rest.length > 1
  return grepRun(r.inputs, re, showName, flags.has('v'), flags.has('n'))
}

function grepInputs(recursive, stdin, rest, ctx) {
  if (recursive) return readFilesRecursive('grep', rest.length > 0 ? rest : ['.'], ctx)
  if (rest.length > 0) return readFilesFor('grep', rest, ctx)
  return { inputs: [{ name: null, content: stdin }] }
}

// Expand each path into the list of files to scan: a file path
// contributes itself; a directory contributes every file under it
// (via fs.walkFiles, sorted files-first then descending). Missing
// paths surface as the same "no such file or directory" error the
// non-recursive path uses, so the user sees a consistent message.
// Displayed file names preserve the user-typed prefix (e.g.
// `grep -r foo src` produces `src/bar.js:…`, not `/src/bar.js:…`),
// matching GNU grep's output convention.
function readFilesRecursive(cmd, paths, ctx) {
  const inputs = []
  for (const p of paths) {
    const abs = resolve(ctx.cwd, p)
    if (ctx.fs.isFile(abs)) { inputs.push({ name: p, content: ctx.fs.readFile(abs) }); continue }
    if (!ctx.fs.isDir(abs)) return { error: err(`${cmd}: ${p}: no such file or directory`) }
    for (const filePath of ctx.fs.walkFiles(abs)) {
      inputs.push({ name: displayName(p, abs, filePath), content: ctx.fs.readFile(filePath) })
    }
  }
  return { inputs }
}

function displayName(userPath, absRoot, absFile) {
  const rel = absRoot === '/' ? absFile.slice(1) : absFile.slice(absRoot.length + 1)
  if (userPath === '.') return rel
  return userPath.endsWith('/') ? userPath + rel : userPath + '/' + rel
}

function grepRun(inputs, re, showName, invert, showLine) {
  const out = []
  let matched = false
  for (const { name, content } of inputs) {
    const lines = splitLines(content)
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]) === invert) continue
      matched = true
      out.push(formatGrepLine(lines[i], name, i + 1, showName, showLine))
    }
  }
  // Match GNU grep's exit code: 0 = matched, 1 = no match.
  return matched ? ok(out.join('\n') + '\n') : { stdout: '', stderr: '', exitCode: 1 }
}

function formatGrepLine(line, name, lineNum, showName, showLine) {
  const parts = []
  if (showName) parts.push(name)
  if (showLine) parts.push(String(lineNum))
  return parts.length > 0 ? parts.join(':') + ':' + line : line
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

function uniq(stdin, tokens) {
  const { flags } = parseArgs(tokens, { short: ['c'] })
  const lines = splitLines(stdin)
  const out = []
  let prev = null
  let count = 0
  const flush = () => {
    if (prev !== null) out.push(flags.has('c') ? `${String(count).padStart(7)} ${prev}` : prev)
  }
  for (const l of lines) {
    if (l === prev) { count++; continue }
    flush(); prev = l; count = 1
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

export const TEXT_COMMANDS = { cat, grep, head, tail, wc, sort, uniq, echo, xargs }
