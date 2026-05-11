// grep — the auditor's main read tool. Lives in its own file
// because the feature set (the standard line match, plus -A/-B/-C
// context, -l/-L filename listing, -c counting, -o match-only,
// -w word-boundary, -h/-H name forcing, all composable with -r/-i
// /-v/-n) doesn't fit the 300-line cap in text-commands.js, and
// because it's the command auditors reach for most often.
//
// The other helpers (readFilesRecursive, displayName, walking
// inputs) are split out too so the per-mode renderers
// (default / list / count / match-only) read top-down.

import { resolve } from './fs.js'
import { parseArgs } from './parse.js'
import { err, ok, parseNonNegativeInt, readFilesFor, splitLines, usage } from './util.js'

const USAGE = 'grep [-i] [-v] [-n] [-r] [-w] [-o] [-l] [-L] [-c] [-h] [-H] [-A N] [-B N] [-C N] PATTERN [PATH...]'

export function grep(stdin, tokens, ctx) {
  const { flags, values, positional } = parseArgs(tokens, {
    short: ['i', 'v', 'n', 'r', 'l', 'L', 'c', 'w', 'h', 'H', 'o'],
    valueShort: ['A', 'B', 'C'],
  })
  if (positional.length === 0) return usage('grep', USAGE)
  const conflict = checkConflicts(flags)
  if (conflict) return conflict
  const re = compilePattern(positional[0], flags)
  if (re.error) return re.error
  const ctxLines = parseContext(values)
  if (ctxLines.error) return ctxLines.error
  const rest = positional.slice(1)
  const recursive = flags.has('r')
  const r = grepInputs(recursive, stdin, rest, ctx)
  if (r.error) return r.error
  const showName = pickShowName(flags, recursive, rest.length)
  const invert = flags.has('v')
  if (flags.has('l')) return grepListFiles(r.inputs, re.re, invert, false)
  if (flags.has('L')) return grepListFiles(r.inputs, re.re, invert, true)
  if (flags.has('c')) return grepCount(r.inputs, re.re, invert, showName)
  return grepRun(r.inputs, re.re, {
    showName,
    invert,
    showLine: flags.has('n'),
    only: flags.has('o'),
    after: ctxLines.after,
    before: ctxLines.before,
  })
}

// parseArgs collapses flags into a Set so order is lost; with no
// "last one wins" rule available we can't pretend a user-typed
// ordering ever resolved a conflict. Erroring out is clearer than
// the alternative of a silent precedence rule that callers can't
// override. {-l, -L, -c} are mutually exclusive output modes;
// -h / -H are mutually exclusive name controls. (-o is allowed
// alongside any of these — it's a per-line presentation toggle
// that gets silenced under -l/-L/-c, which is unsurprising.)
function checkConflicts(flags) {
  if (flags.has('h') && flags.has('H')) {
    return err('grep: -h and -H are mutually exclusive')
  }
  const modes = ['l', 'L', 'c'].filter((f) => flags.has(f))
  if (modes.length > 1) {
    return err(`grep: ${modes.map((f) => `-${f}`).join(' / ')} are mutually exclusive`)
  }
  return null
}

function compilePattern(pattern, flags) {
  // -w wraps in word-boundary anchors. Using a non-capturing group
  // keeps alternation (`foo|bar`) intact.
  const source = flags.has('w') ? `\\b(?:${pattern})\\b` : pattern
  try { return { re: new RegExp(source, flags.has('i') ? 'iu' : 'u') } } catch (e) {
    return { error: err(`grep: invalid pattern: ${e.message}`) }
  }
}

function parseContext(values) {
  // -C N is shorthand for -A N -B N. Explicit -A / -B win when
  // both are supplied alongside -C.
  const c = values.get('C')
  const a = parseNonNegativeInt(values.get('A') ?? c ?? '0', 'grep: -A')
  if (a.error) return a
  const b = parseNonNegativeInt(values.get('B') ?? c ?? '0', 'grep: -B')
  if (b.error) return b
  return { after: a.value, before: b.value }
}

function pickShowName(flags, recursive, nFiles) {
  // -h / -H override the default. Default: show when -r is set
  // (matches come from discovered descendants) or when multiple
  // explicit files were named.
  if (flags.has('h')) return false
  if (flags.has('H')) return true
  return recursive || nFiles > 1
}

function grepInputs(recursive, stdin, rest, ctx) {
  if (recursive) return readFilesRecursive('grep', rest.length > 0 ? rest : ['.'], ctx)
  if (rest.length > 0) return readFilesFor('grep', rest, ctx)
  return { inputs: [{ name: null, content: stdin }] }
}

// Expand each path into the list of files to scan: a file path
// contributes itself; a directory contributes every file under it
// (via fs.walkFiles). Missing paths surface as the same "no such
// file or directory" error the non-recursive path uses, so the
// user sees a consistent message. Displayed file names preserve
// the user-typed prefix (`grep -r foo src` produces `src/bar.js:…`,
// not `/src/bar.js:…`), matching GNU grep's output convention.
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

// Default mode: print matching lines, optionally with context.
// Context-line prefix uses `-` as the field separator (e.g.
// `file-12-content`); matches use `:`. `--` separates non-adjacent
// context groups within a single file. -o overrides context and
// emits each match (or each match occurrence) on its own line.
function grepRun(inputs, re, opts) {
  const blocks = []
  let matched = false
  for (const { name, content } of inputs) {
    const lines = splitLines(content)
    const fileBlock = grepFileBlock(lines, re, name, opts)
    if (fileBlock.matched) matched = true
    if (fileBlock.lines.length > 0) blocks.push(fileBlock.lines.join('\n'))
  }
  const output = blocks.join('\n')
  return matched
    ? ok(output + (output ? '\n' : ''))
    : { stdout: '', stderr: '', exitCode: 1 }
}

function grepFileBlock(lines, re, name, opts) {
  const { invert, after, before, only } = opts
  // The `--` separator only fires when context is on. Without -A/-B,
  // consecutive matches with gaps between them shouldn't be split
  // by `--` — that matches GNU grep, and matters because the prior
  // (non-context) behaviour piped clean lines into `sort`/`uniq`.
  const hasContext = before > 0 || after > 0
  const out = []
  let matched = false
  let lastShown = -1
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]) === invert) continue
    matched = true
    if (only) { out.push(...extractMatches(lines[i], name, i + 1, re, opts)); continue }
    const start = Math.max(0, i - before)
    const end = Math.min(lines.length - 1, i + after)
    if (hasContext && lastShown >= 0 && start > lastShown + 1) out.push('--')
    for (let j = Math.max(start, lastShown + 1); j <= end; j++) {
      const isMatch = j === i || (re.test(lines[j]) !== invert)
      out.push(formatLine(lines[j], name, j + 1, isMatch, opts))
    }
    lastShown = end
  }
  return { lines: out, matched }
}

function extractMatches(line, name, lineNum, re, opts) {
  // Per-line global regex so we get every occurrence, not just
  // the first. Cheaper than recompiling for the source — the
  // input is small (one line) and the regex is already validated.
  const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  const out = []
  for (const m of line.matchAll(globalRe)) {
    out.push(formatLine(m[0], name, lineNum, true, opts))
  }
  return out
}

function formatLine(text, name, lineNum, isMatch, opts) {
  const { showName, showLine } = opts
  const sep = isMatch ? ':' : '-'
  const parts = []
  // GNU convention: when -H (or any showName mode) hits stdin,
  // the prefix is the literal `(standard input)` so the user can
  // still pipe greps and tell pipeline lines apart from data.
  if (showName) parts.push(name ?? '(standard input)')
  if (showLine) parts.push(String(lineNum))
  return parts.length > 0 ? parts.join(sep) + sep + text : text
}

// -l prints filenames that have at least one matching line; -L
// inverts to filenames with zero matches. Stdin contributes as
// `(standard input)`, matching the convention formatLine and
// grepCount use under -H. Exit 0 if anything was listed, 1
// otherwise.
function grepListFiles(inputs, re, invert, listNonMatching) {
  const out = []
  for (const { name, content } of inputs) {
    const lines = splitLines(content)
    const hasMatch = lines.some((l) => re.test(l) !== invert)
    if (listNonMatching ? !hasMatch : hasMatch) {
      // Match the (standard input) convention from formatLine /
      // grepCount so `echo … | grep -l PATTERN` produces something
      // useful instead of silently dropping the stream.
      out.push(name ?? '(standard input)')
    }
  }
  return out.length > 0
    ? ok(out.join('\n') + '\n')
    : { stdout: '', stderr: '', exitCode: 1 }
}

// -c prints per-file match counts. With showName, each line is
// `name:count`; without, just the count (e.g. when reading from
// stdin or a single explicit file). Exit 0 if any file matched.
function grepCount(inputs, re, invert, showName) {
  const lines = []
  let anyMatched = false
  for (const { name, content } of inputs) {
    const fileLines = splitLines(content)
    let count = 0
    for (const l of fileLines) if (re.test(l) !== invert) count++
    if (count > 0) anyMatched = true
    // Mirror the stdin-label convention from formatLine so
    // `echo … | grep -Hc PATTERN` produces `(standard input):N`
    // rather than a bare count that's indistinguishable from the
    // single-file no-prefix case.
    if (showName) lines.push(`${name ?? '(standard input)'}:${count}`)
    else lines.push(String(count))
  }
  return lines.length === 0
    ? { stdout: '', stderr: '', exitCode: 1 }
    : { stdout: lines.join('\n') + '\n', stderr: '', exitCode: anyMatched ? 0 : 1 }
}
