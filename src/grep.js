// grep — the auditor's main read tool. Own file because the
// feature set (-A/-B/-C context, -l/-L/-c output modes, -o,
// -w, -F/-G/-E dialect, -h/-H name forcing, -r/-R recursive,
// -i/-v/-n composable, -e PATTERN multi, --include/--exclude/
// --exclude-dir recursive globs) outgrew text-commands.js.
//
// Pattern dialects (mutually exclusive, default is BRE):
//   -G  POSIX BRE — `(`, `)`, `{`, `}`, `+`, `?`, `|` are LITERAL;
//       `\(`, `\|`, etc. are the metachars. Default because
//       auditors typing `function(arg)` expect parens to match
//       literally — picking ECMAScript by default would lose data
//       on the common case via silent syntax errors.
//   -E  ERE — pattern passed through; close to POSIX ERE for the
//       common shapes (`(`, `|`, `+`, `?`, `{n,m}`).
//   -F  fixed string — every metachar literal via `RegExp.escape`.

import { basename, relativeTo, resolve } from './fs.js'
import { parseArgs } from './parse.js'
import { err, joinLines, ok, parseNonNegativeInt, readFilesFor, splitLines, usage } from './util.js'
import { breToEs } from './bre.js'
import { compileGlob } from './glob.js'

// Two forms because PATTERN is required UNLESS -e is given. Listing
// both makes the conditional explicit — bare `[PATTERN]` would read
// as if `grep [PATH...]` (no pattern at all) were valid, which it
// isn't.
const FLAGS = '[-i] [-v] [-n] [-r|-R] [-w] [-o] [-E|-F|-G] [-l] [-L] [-c] [-h] [-H] [-A N] [-B N] [-C N] [--include=GLOB] [--exclude=GLOB] [--exclude-dir=GLOB]'
const USAGE = `grep ${FLAGS} PATTERN [PATH...]\n   or: grep ${FLAGS} -e PATTERN ... [PATH...]`

// -R is GNU's "dereference-recursive" — distinct from -r because it
// follows symlinks. The virtual FS has no symlink concept, so the two
// degenerate to the same traversal here; -R is accepted as an alias
// so muscle-memory invocations don't trip over an "unknown option".
const SHORT_FLAGS = ['i', 'v', 'n', 'r', 'R', 'l', 'L', 'c', 'w', 'h', 'H', 'o', 'E', 'F', 'G']
const VALUE_SHORTS = ['A', 'B', 'C']

export function grep(stdin, tokens, ctx) {
  // `-e` is a repeatable value flag, so `-e a -e b` (and the bundled
  // `-ie foo` / inline `-efoo` forms) collect every pattern into an
  // array — they're OR'd together, and a pattern may start with `-`.
  // `--include` / `--exclude` / `--exclude-dir` are likewise repeatable
  // (GNU lets you stack globs); include/exclude filter every file input,
  // exclude-dir prunes directories during the recursive walk.
  // parseArgs throws on a bad flag / stranded `-e`; grep's usage
  // errors exit 2 (GNU), distinct from dispatch's generic exit 1.
  let parsed
  try { parsed = parseArgs(tokens, { short: SHORT_FLAGS, valueShort: VALUE_SHORTS, repeatable: ['e', 'include', 'exclude', 'exclude-dir'] }) }
  catch (e) { return err(`grep: ${e.message}`, 2) }
  const { flags, values, positional } = parsed
  const ePatterns = values.get('e') ?? []
  // If any `-e` patterns were collected, every positional is a file;
  // otherwise the first positional is the pattern.
  let patterns, rest
  if (ePatterns.length > 0) { patterns = ePatterns; rest = positional }
  else if (positional.length > 0) { patterns = [positional[0]]; rest = positional.slice(1) }
  else return usage(USAGE)
  const conflict = checkConflicts(flags)
  if (conflict) return conflict
  const re = compilePatterns(patterns, flags)
  if (re.error) return re.error
  const ctxLines = parseContext(values)
  if (ctxLines.error) return ctxLines.error
  const recursive = flags.has('r') || flags.has('R')
  const filters = compileFilters(parsed)
  const r = grepInputs(recursive, stdin, rest, ctx, filters)
  // include/exclude apply to every file input — named operands AND
  // recursively-discovered files — matching GNU; stdin (name===null) is
  // exempt. exclude-dir already pruned directories inside grepInputs.
  const inputs = r.inputs.filter((inp) => inp.name === null || includedByName(basename(inp.name), filters.name))
  const showName = pickShowName(flags, recursive, rest.length)
  const invert = flags.has('v')
  const opts = { showName, invert, showLine: flags.has('n'), only: flags.has('o'), after: ctxLines.after, before: ctxLines.before }
  const result = flags.has('l') ? grepListFiles(inputs, re.res, invert, false)
    : flags.has('L') ? grepListFiles(inputs, re.res, invert, true)
    : flags.has('c') ? grepCount(inputs, re.res, invert, showName)
    : grepRun(inputs, re.res, opts)
  // Unreadable file/dir operands don't abort the search: scan what we
  // can, then prepend their errors and force grep's exit-2 ("an error
  // occurred"), which outranks the 0/1 match status.
  if (r.failed) return { stdout: result.stdout, stderr: r.stderr + result.stderr, exitCode: 2 }
  return result
}

// parseArgs collapses flags into a Set so order is lost; with no
// "last one wins" rule available we can't pretend a user-typed
// ordering ever resolved a conflict. Erroring out is clearer than
// the alternative of a silent precedence rule that callers can't
// override. {-l, -L, -c} are mutually exclusive output modes;
// -h / -H are mutually exclusive name controls; {-E, -F, -G} are
// mutually exclusive pattern dialects. (-o is allowed alongside
// any of these — it's a per-line presentation toggle that gets
// silenced under -l/-L/-c, which is unsurprising.)
function checkConflicts(flags) {
  if (flags.has('h') && flags.has('H')) {
    return err('grep: -h and -H are mutually exclusive')
  }
  const modes = ['l', 'L', 'c'].filter((f) => flags.has(f))
  if (modes.length > 1) {
    return err(`grep: ${modes.map((f) => `-${f}`).join(' / ')} are mutually exclusive`)
  }
  const dialects = ['E', 'F', 'G'].filter((f) => flags.has(f))
  if (dialects.length > 1) {
    return err(`grep: ${dialects.map((f) => `-${f}`).join(' / ')} are mutually exclusive`)
  }
  return null
}

function compilePatterns(patterns, flags) {
  // Pattern dialect (mutually exclusive; default is BRE):
  //   -F: literal match, via the standardized `RegExp.escape`.
  //   -E: pass through — the JS RegExp engine accepts ERE for the
  //       common shapes (`(`, `|`, `+`, `?`, `{n,m}`). POSIX char
  //       classes like `[:alpha:]` are not modeled.
  //   default / -G: translate BRE → ES so `function(arg)`, `a|b`,
  //       `x?` are literal (matching POSIX and GNU grep). Use
  //       `\(`, `\|`, `\?` etc. for the metachar forms.
  // Each `-e` pattern is compiled SEPARATELY (not OR-combined into
  // a single regex). Combining would shift backreference numbering
  // across patterns — `grep -e '\(foo\)\(bar\)' -e '\(baz\)\1'`
  // would let pattern2's `\1` accidentally refer to pattern1's
  // group 1. A line matches when ANY of the regexes match.
  const res = []
  const reFlags = flags.has('i') ? 'iu' : 'u'
  for (const pattern of patterns) {
    let source
    if (flags.has('F')) source = RegExp.escape(pattern)
    else if (flags.has('E')) source = pattern
    else {
      const r = breToEs(pattern)
      if (r.error) return { error: err(`grep: ${r.error}`, 2) }
      source = r.source
    }
    // -w wraps in word-boundary anchors. Per pattern so each gets
    // its own boundary check rather than wrapping the union.
    if (flags.has('w')) source = `\\b(?:${source})\\b`
    try { res.push(new RegExp(source, reFlags)) } catch (e) {
      // POSIX: regex syntax errors exit 2 (separate from "no match"
      // which exits 1). Dialect label tells a confused user which
      // mode was active (e.g. `grep -E "Function("` says ERE).
      const dialect = flags.has('F') ? `fixed-string /${reFlags}`
        : flags.has('E') ? `ERE / ECMAScript /${reFlags}`
        : `BRE /${reFlags}`
      return { error: err(`grep: invalid pattern (${dialect}): ${e.message}`, 2) }
    }
  }
  return { res }
}

// `res.some((re) => re.test(line))` — line matches when any -e regex does.
function anyMatch(res, line) { return res.some((re) => re.test(line)) }

// grep's "found nothing" result: empty output, exit 1. POSIX reserves
// exit 1 for "no lines matched" — distinct from the exit-2 error path.
const noMatch = () => ({ stdout: '', stderr: '', exitCode: 1 })

function parseContext(values) {
  // -C N is shorthand for -A N -B N (explicit -A / -B win). Validate
  // -C separately so `-C garbage -A 2 -B 2` reports `-C`, not a
  // silent fallthrough to 0 via `??`.
  const c = values.get('C')
  const cv = c === undefined ? null : parseNonNegativeInt(c, 'grep: -C')
  if (cv?.error) return cv
  const a = parseNonNegativeInt(values.get('A') ?? c ?? '0', 'grep: -A')
  if (a.error) return a
  const b = parseNonNegativeInt(values.get('B') ?? c ?? '0', 'grep: -B')
  return b.error ? b : { after: a.value, before: b.value }
}

function pickShowName(flags, recursive, nFiles) {
  // -h / -H override the default. Default: show when -r is set
  // (matches come from discovered descendants) or when multiple
  // explicit files were named.
  if (flags.has('h')) return false
  if (flags.has('H')) return true
  return recursive || nFiles > 1
}

function grepInputs(recursive, stdin, rest, ctx, filters) {
  if (recursive) return readFilesRecursive('grep', rest.length > 0 ? rest : ['.'], ctx, filters.dir)
  if (rest.length > 0) return readFilesFor('grep', rest, ctx)
  return { inputs: [{ name: null, content: stdin }], stderr: '', failed: false }
}

// Expand each path into the list of files to scan: a file path
// contributes itself; a directory contributes every file under it
// (via fs.walkFiles). Missing paths surface as the same "no such
// file or directory" error the non-recursive path uses, so the
// user sees a consistent message. Displayed file names preserve
// the user-typed prefix (`grep -r foo src` produces `src/bar.js:…`,
// not `/src/bar.js:…`), matching GNU grep's output convention.
function readFilesRecursive(cmd, paths, ctx, dirRes) {
  const inputs = []
  let stderr = ''
  let failed = false
  for (const p of paths) {
    const abs = resolve(ctx.cwd, p)
    // A named file operand is read as-is; include/exclude filtering of
    // both named and discovered files happens once, after collection.
    if (ctx.fs.isFile(abs)) { inputs.push({ name: p, content: ctx.fs.readFile(abs) }); continue }
    if (!ctx.fs.isDir(abs)) { stderr += `${cmd}: ${p}: no such file or directory\n`; failed = true; continue }
    if (excludedStartDir(p, dirRes)) continue
    for (const filePath of ctx.fs.walkFiles(abs)) {
      if (excludedByDir(filePath, abs, dirRes)) continue
      inputs.push({ name: displayName(p, abs, filePath), content: ctx.fs.readFile(filePath) })
    }
  }
  return { inputs, stderr, failed }
}

// Compile the filter globs once (glob.js's note: reuse the RegExp on hot
// paths) and match against base names — GNU's rule for these options, so
// `*` never needs to span `/`. include/exclude share one ORDERED list so
// the last matching option can win (an --exclude before an --include is
// honored); exclude-dir has no "include" counterpart, so order doesn't
// matter and a plain list suffices.
function compileFilters(parsed) {
  const name = parsed.order
    .filter((o) => o.name === 'include' || o.name === 'exclude')
    .map((o) => ({ include: o.name === 'include', re: compileGlob(o.value) }))
  const dir = (parsed.values.get('exclude-dir') ?? []).map(compileGlob)
  return { name, dir }
}

function someMatch(res, name) { return res.some((re) => re.test(name)) }

// GNU include/exclude precedence: the LAST option whose glob matches the
// base name decides it (include→keep, exclude→drop). With no match the
// name is kept UNLESS the first option was an --include — an --include
// with nothing matching excludes everything else by default.
function includedByName(name, nameFilters) {
  if (nameFilters.length === 0) return true
  let last = null
  for (const f of nameFilters) if (f.re.test(name)) last = f
  return last ? last.include : !nameFilters[0].include
}

// --exclude-dir skips a file when ANY directory component below the
// search root matches (GNU prunes mid-descent; post-filtering the walked
// paths is equivalent for this in-memory FS — there are no empty dirs to
// make the difference observable).
function excludedByDir(filePath, absRoot, dirRes) {
  if (dirRes.length === 0) return false
  const parts = relativeTo(absRoot, filePath).split('/')
  parts.pop() // drop the file's own base name; keep the dir components
  return parts.some((d) => someMatch(dirRes, d))
}

// GNU also prunes a NAMED start directory by its own trailing component,
// matched as typed — `--exclude-dir=foo` drops a `foo` operand but not a
// `foo/` one (the trailing slash defeats the base-name match).
function excludedStartDir(operand, dirRes) {
  if (dirRes.length === 0 || operand.endsWith('/')) return false
  return someMatch(dirRes, operand.slice(operand.lastIndexOf('/') + 1))
}

function displayName(userPath, absRoot, absFile) {
  const rel = relativeTo(absRoot, absFile)
  if (userPath === '.') return rel
  return userPath.endsWith('/') ? userPath + rel : userPath + '/' + rel
}

// Default mode: print matching lines, optionally with context.
// Context-line prefix uses `-` as the field separator (e.g.
// `file-12-content`); matches use `:`. `--` separates non-adjacent
// context groups within a single file. -o overrides context and
// emits each match (or each match occurrence) on its own line.
function grepRun(inputs, res, opts) {
  const blocks = []
  let matched = false
  for (const { name, content } of inputs) {
    const lines = splitLines(content)
    const fileBlock = grepFileBlock(lines, res, name, opts)
    if (fileBlock.matched) matched = true
    if (fileBlock.lines.length > 0) blocks.push(fileBlock.lines.join('\n'))
  }
  const output = blocks.join('\n')
  return matched ? ok(output + (output ? '\n' : '')) : noMatch()
}

function grepFileBlock(lines, res, name, opts) {
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
    if (anyMatch(res, lines[i]) === invert) continue
    matched = true
    if (only) { out.push(...extractMatches(lines[i], name, i + 1, res, opts)); continue }
    const start = Math.max(0, i - before)
    const end = Math.min(lines.length - 1, i + after)
    if (hasContext && lastShown >= 0 && start > lastShown + 1) out.push('--')
    for (let j = Math.max(start, lastShown + 1); j <= end; j++) {
      const isMatch = j === i || (anyMatch(res, lines[j]) !== invert)
      out.push(formatLine(lines[j], name, j + 1, isMatch, opts))
    }
    lastShown = end
  }
  return { lines: out, matched }
}

function extractMatches(line, name, lineNum, res, opts) {
  // Per-line global regex so we get every occurrence, not just
  // the first. With multiple -e regexes, gather matches from each,
  // sort by position (longer first at the same position), then
  // filter to non-overlapping leftmost-longest — matches grep `-o`
  // semantics where two patterns covering the same span emit one
  // hit, not two.
  // Zero-length matches (`\b`, `\(\)`, ``) are dropped — ugrep / GNU
  // skip them in `-o`, and they'd duplicate across multi-`-e` since
  // the cursor below can't advance past a length-0 match.
  const matches = []
  for (const re of res) {
    const globalRe = new RegExp(re.source, re.flags + 'g')
    for (const m of line.matchAll(globalRe)) if (m[0].length > 0) matches.push({ index: m.index, text: m[0] })
  }
  matches.sort((a, b) => a.index - b.index || b.text.length - a.text.length)
  const out = []
  let cursor = 0
  for (const m of matches) {
    if (m.index < cursor) continue  // overlaps a previously chosen match
    out.push(formatLine(m.text, name, lineNum, true, opts))
    cursor = m.index + m.text.length
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
// grepCount use under -H.
//
// Exit status follows GNU and is NOT tied to the listing: 0 iff some
// input had a selected line, 1 otherwise. So `grep -L` can print the
// un-matched files yet still exit 1 when nothing matched anywhere (a
// pattern absent from every file). For -l the two coincide — a listed
// file is, by definition, one that matched.
function grepListFiles(inputs, res, invert, listNonMatching) {
  const out = []
  let anySelected = false
  for (const { name, content } of inputs) {
    const lines = splitLines(content)
    const hasMatch = lines.some((l) => anyMatch(res, l) !== invert)
    if (hasMatch) anySelected = true
    if (listNonMatching ? !hasMatch : hasMatch) {
      // Match the (standard input) convention from formatLine /
      // grepCount so `echo … | grep -l PATTERN` produces something
      // useful instead of silently dropping the stream.
      out.push(name ?? '(standard input)')
    }
  }
  return { stdout: joinLines(out), stderr: '', exitCode: anySelected ? 0 : 1 }
}

// -c prints per-file match counts. With showName, each line is
// `name:count`; without, just the count (e.g. when reading from
// stdin or a single explicit file). Exit 0 if any file matched.
function grepCount(inputs, res, invert, showName) {
  const lines = []
  let anyMatched = false
  for (const { name, content } of inputs) {
    const fileLines = splitLines(content)
    let count = 0
    for (const l of fileLines) if (anyMatch(res, l) !== invert) count++
    if (count > 0) anyMatched = true
    // Mirror the stdin-label convention from formatLine so
    // `echo … | grep -Hc PATTERN` produces `(standard input):N`
    // rather than a bare count that's indistinguishable from the
    // single-file no-prefix case.
    if (showName) lines.push(`${name ?? '(standard input)'}:${count}`)
    else lines.push(String(count))
  }
  if (lines.length === 0) return noMatch()
  return { stdout: joinLines(lines), stderr: '', exitCode: anyMatched ? 0 : 1 }
}
