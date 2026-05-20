// grep — the auditor's main read tool. Own file because the
// feature set (-A/-B/-C context, -l/-L/-c output modes, -o,
// -w, -F/-G/-E dialect, -h/-H name forcing, -r recursive,
// -i/-v/-n composable, -e PATTERN multi) outgrew text-commands.js.
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

import { relativeTo, resolve } from './fs.js'
import { parseArgs } from './parse.js'
import { err, ok, parseNonNegativeInt, readFilesFor, splitLines, usage } from './util.js'

// Two forms because PATTERN is required UNLESS -e is given. Listing
// both makes the conditional explicit — bare `[PATTERN]` would read
// as if `grep [PATH...]` (no pattern at all) were valid, which it
// isn't.
const FLAGS = '[-i] [-v] [-n] [-r] [-w] [-o] [-E|-F|-G] [-l] [-L] [-c] [-h] [-H] [-A N] [-B N] [-C N]'
const USAGE = `grep ${FLAGS} PATTERN [PATH...]\n   or: grep ${FLAGS} -e PATTERN ... [PATH...]`

// Shared schema for parseArgs and extractEPatterns. The bundled-`-e`
// pre-pass needs to know which other shorts take a value so it
// doesn't try to split `-Ae 5` (which is `-A=e`) as `-A -e 5`.
const SHORT_FLAGS = ['i', 'v', 'n', 'r', 'l', 'L', 'c', 'w', 'h', 'H', 'o', 'E', 'F', 'G']
const VALUE_SHORTS = ['A', 'B', 'C']
const VALUE_SHORTS_SET = new Set(VALUE_SHORTS)

export function grep(stdin, tokens, ctx) {
  // Pre-pass `-e PATTERN` / `-ePATTERN` out of the token stream so
  // parseArgs only sees the remaining flags / paths. Multiple `-e`
  // are OR'd together. Patterns may start with `-`, which is the
  // primary reason `-e` exists beyond multi-pattern. Stops at `--`.
  // Pre-pass strips every `-e` form (explicit, inline, bundled) so
  // parseArgs never sees `-e` at all and we keep ALL of the patterns
  // — including repeated bundles like `-ie foo -ie bar` which would
  // otherwise lose one via parseArgs's single-value-per-key Map.
  const eRes = extractEPatterns(tokens)
  if (eRes.error) return eRes.error
  const { ePatterns, remaining } = eRes
  const { flags, values, positional } = parseArgs(remaining, { short: SHORT_FLAGS, valueShort: VALUE_SHORTS })
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
  const recursive = flags.has('r')
  const r = grepInputs(recursive, stdin, rest, ctx)
  const showName = pickShowName(flags, recursive, rest.length)
  const invert = flags.has('v')
  const opts = { showName, invert, showLine: flags.has('n'), only: flags.has('o'), after: ctxLines.after, before: ctxLines.before }
  const result = flags.has('l') ? grepListFiles(r.inputs, re.res, invert, false)
    : flags.has('L') ? grepListFiles(r.inputs, re.res, invert, true)
    : flags.has('c') ? grepCount(r.inputs, re.res, invert, showName)
    : grepRun(r.inputs, re.res, opts)
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

// Pull every `-e PATTERN` form out of the token stream (explicit,
// inline `-efoo`, bundled `-ie foo` / `-iefoo`). Stops at `--`.
// parseArgs can't do this because its values Map keeps only the
// last value per key, dropping `foo` in `-e foo -e bar`. Bundle
// scan stops at the first value-taking short (`-Ae` is `-A=e`,
// not a bundle ending in `-e`).
function extractEPatterns(tokens) {
  const ePatterns = []
  const remaining = []
  let afterTerminator = false
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (afterTerminator) { remaining.push(t); continue }
    if (t === '--') { remaining.push(t); afterTerminator = true; continue }
    if (!t.startsWith('-') || t.length < 2 || t.startsWith('--') || /^-\d/u.test(t)) {
      remaining.push(t); continue
    }
    // Walk the bundle for `e`; capture chars before as bool flags.
    // If the bundle ends in a value-taking short (no inline value),
    // the next token is its value — pass both through verbatim so
    // parseArgs's value-consumption matches across `--` correctly
    // (`-A -- -e foo` keeps `-e` reachable for our extraction).
    let eIdx = -1, preBundle = '', valueShortAtEnd = false
    for (let j = 1; j < t.length; j++) {
      if (t[j] === 'e') { eIdx = j; break }
      if (VALUE_SHORTS_SET.has(t[j])) { valueShortAtEnd = j === t.length - 1; break }
      preBundle += t[j]
    }
    if (eIdx < 0) {
      remaining.push(t)
      if (valueShortAtEnd && i + 1 < tokens.length) { remaining.push(tokens[i + 1]); i++ }
      continue
    }
    const inline = t.slice(eIdx + 1)
    if (inline.length > 0) ePatterns.push(inline)
    else if (i + 1 >= tokens.length) return { error: err('grep: option -e requires an argument', 2) }
    else { ePatterns.push(tokens[i + 1]); i++ }
    if (preBundle.length > 0) remaining.push('-' + preBundle)
  }
  return { ePatterns, remaining }
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

// Translate POSIX-style BRE to ES regex by swapping which form is
// the metachar: in BRE `(` `)` `{` `}` `+` `?` `|` are literal and
// `\(` `\)` etc. are the metachar; in ES it's the reverse. Inside
// `[...]` character classes nothing is swapped (POSIX and ES agree
// that those chars are literal there). Escape sequences other than
// the swapped set (`\d`, `\b`, `\s`, etc.) pass through unchanged
// — matching GNU grep's BRE-with-extensions rather than strict
// POSIX (where `\d` would be literal `d`).
//
// GNU BRE extensions also recognized:
//   `\<` / `\>` — start / end of word, both mapped to ES `\b`.
//     `\b` is symmetric (matches both transitions) where GNU's are
//     directional, but the common pattern `\<word\>` reads the same.
//   `*` at the very start of the pattern or immediately after `^`
//     is treated as literal (POSIX BRE rule: no preceding atom to
//     repeat). ES rejects these as "Nothing to repeat".
//   `^` and `$` are anchors only at the start / end of the pattern
//     (or adjacent to `\(`/`\|`/`\)`). Elsewhere they're literal —
//     POSIX BRE rule. ES treats both as anchors everywhere, which
//     would silently break searches for literal `$VAR` / `a^b`.
//
// Returns `{ source }` or `{ error }` — the latter only for a bare
// trailing `\`, which GNU grep also rejects as "Trailing backslash".
//
// Known divergences vs POSIX (ES semantics; reach for `-F` if needed):
// `\]` inside class is ES escape (POSIX: literal `\`); `[^]` matches
// anything (POSIX: error); `[[:alpha:]]`, `\(*\)` follow ES.

// Return the length (in chars, INCLUDING the leading backslash) of a
// valid ES regex escape at `pattern[i]`. The caller passes through
// `pattern.slice(i, i + len)` verbatim. Returns 0 when `\<next>`
// isn't a valid ES escape (the caller drops the backslash and emits
// `next` as a literal, matching POSIX BRE "identity escape").
// Returns -1 for a trailing `\` with no following char.
//
// Why lookahead matters: ES /u rejects `\x`, `\u`, `\p` etc. unless
// followed by their required suffix (`\xHH`, `\u{...}` / `\uHHHH`,
// `\p{...}`, `\k<...>`, `\cX`). POSIX BRE / ugrep treat bare `\x`
// as literal `x`. Without validation we'd silently fail to compile
// the BRE-literal form.
function escapeLength(pattern, i) {
  const next = pattern[i + 1]
  if (next === undefined) return -1
  // ES-syntactic chars (identity escape) and GNU BRE extensions
  // (`\b`/`\B` word boundary, `\d`/`\D`/`\s`/`\S`/`\w`/`\W` class
  // escapes). NOT included: `\0`, `\t`, `\n`, `\r`, `\f`, `\v` —
  // strict POSIX BRE (and ugrep / GNU grep) treats those as literal
  // letters, not ES control escapes. `\0` in particular has the
  // legacy-octal ES /u footgun (`\01` etc. throws), which Copilot
  // flagged on PR #40.
  if ('^$\\.*+?()[]{}|/bBdDsSwW'.includes(next)) return 2
  if (next >= '1' && next <= '9') return 2  // backreference
  const isHex = (c) => c !== undefined && /[0-9A-Fa-f]/u.test(c)
  const balanced = (open, close) => {
    if (pattern[i + 2] !== open) return 0
    const end = pattern.indexOf(close, i + 3)
    return end > i + 3 ? end - i + 1 : 0
  }
  if (next === 'x') return isHex(pattern[i + 2]) && isHex(pattern[i + 3]) ? 4 : 0
  if (next === 'u') {
    // `\u{H..H}` requires 1-6 hex digits AND code point ≤ 0x10FFFF;
    // `\uHHHH` requires exactly 4 hex digits. Invalid forms fall
    // back to the BRE identity-escape branch (drop the backslash).
    if (pattern[i + 2] === '{') {
      const len = balanced('{', '}')
      const body = len ? pattern.slice(i + 3, i + len - 1) : ''
      const valid = body.length >= 1 && body.length <= 6 && [...body].every(isHex) && parseInt(body, 16) <= 0x10FFFF
      return valid ? len : 0
    }
    return [2, 3, 4, 5].every((k) => isHex(pattern[i + k])) ? 6 : 0
  }
  if (next === 'p' || next === 'P') return balanced('{', '}')
  if (next === 'c') return /[A-Za-z]/u.test(pattern[i + 2] ?? '') ? 3 : 0
  if (next === 'k') return balanced('<', '>')
  return 0
}

function breToEs(pattern) {
  const SWAP = '(){}+?|'
  let out = ''
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (inClass) {
      // Inside `[...]`, escape handling mirrors the outside-class
      // branch but without SWAP / GNU-extension transforms: identity
      // escapes pass through if ES accepts them; otherwise drop the
      // backslash so `[\_]` / `[\a]` don't trip ES's invalid-escape
      // error on POSIX-style literal escapes.
      if (c === '\\') {
        const len = escapeLength(pattern, i)
        if (len === -1) return { error: 'trailing backslash (\\)' }
        if (len > 0) { out += pattern.slice(i, i + len); i += len - 1; continue }
        out += pattern[i + 1]; i++; continue
      }
      out += c
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') {
      // POSIX: `]` immediately after `[` (or `[^`) is literal, not
      // class-close. ES /u rejects `[]…]` / `[^]…]`; escape the
      // leading `]` so the same chars land in the class.
      out += c; inClass = true
      // Skip past a leading `^` (negation) so the next iteration
      // doesn't reprocess it as a class member — `[^a]` was
      // being mis-emitted as `[^^a]`.
      if (pattern[i + 1] === '^') { out += '^'; i++ }
      // POSIX: `]` immediately after `[` (or `[^`) is literal. ES
      // /u rejects `[]…]` / `[^]…]`; escape it so the same chars
      // land in the class and the tracker doesn't exit early.
      if (pattern[i + 1] === ']') { out += '\\]'; i++ }
      continue
    }
    if (c === '\\') {
      if (i + 1 >= pattern.length) return { error: 'trailing backslash (\\)' }
      const next = pattern[i + 1]
      // BRE-specific transforms first — these aren't ES syntax,
      // so escapeLength would return 0 for them.
      if (SWAP.includes(next)) { out += next; i++; continue }
      if (next === '<' || next === '>') { out += '\\b'; i++; continue }
      // Validated ES escape (including multi-char `\xHH`, `\p{...}`).
      const len = escapeLength(pattern, i)
      if (len > 0) { out += pattern.slice(i, i + len); i += len - 1; continue }
      // POSIX BRE: backslash before non-special char is literal.
      out += next; i++; continue
    }
    // POSIX BRE: `*` at the start of the pattern (or right after
    // an anchor `^`) is literal because there's no preceding atom.
    // ES rejects both as "Nothing to repeat", which silently breaks
    // searches for literal `*` strings (e.g. `*ptr` in C source).
    // The `^` predecessor only counts when it's actually an anchor —
    // a literal mid-pattern `^` lets `*` repeat it normally
    // (`a^*b` means a + zero-or-more literal `^` + b).
    if (c === '*' && (i === 0 || (pattern[i - 1] === '^' && caretIsAnchor(pattern, i - 1)))) { out += '\\*'; continue }
    if (c === '^' && !caretIsAnchor(pattern, i)) { out += '\\^'; continue }
    if (c === '$' && !(i === pattern.length - 1 || (pattern[i + 1] === '\\' && (pattern[i + 2] === ')' || pattern[i + 2] === '|')))) { out += '\\$'; continue }
    if (SWAP.includes(c)) { out += '\\' + c; continue }
    out += c
  }
  return { source: out }
}

// POSIX BRE: `^` is an anchor at pos 0 or immediately after `\(` /
// `\|` (GNU group / alternation extension). Elsewhere it's literal.
function caretIsAnchor(pattern, i) {
  if (i === 0) return true
  return i >= 2 && pattern[i - 2] === '\\' && (pattern[i - 1] === '(' || pattern[i - 1] === '|')
}

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

function grepInputs(recursive, stdin, rest, ctx) {
  if (recursive) return readFilesRecursive('grep', rest.length > 0 ? rest : ['.'], ctx)
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
function readFilesRecursive(cmd, paths, ctx) {
  const inputs = []
  let stderr = ''
  let failed = false
  for (const p of paths) {
    const abs = resolve(ctx.cwd, p)
    if (ctx.fs.isFile(abs)) { inputs.push({ name: p, content: ctx.fs.readFile(abs) }); continue }
    if (!ctx.fs.isDir(abs)) { stderr += `${cmd}: ${p}: no such file or directory\n`; failed = true; continue }
    for (const filePath of ctx.fs.walkFiles(abs)) {
      inputs.push({ name: displayName(p, abs, filePath), content: ctx.fs.readFile(filePath) })
    }
  }
  return { inputs, stderr, failed }
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
// grepCount use under -H. Exit 0 if anything was listed, 1
// otherwise.
function grepListFiles(inputs, res, invert, listNonMatching) {
  const out = []
  for (const { name, content } of inputs) {
    const lines = splitLines(content)
    const hasMatch = lines.some((l) => anyMatch(res, l) !== invert)
    if (listNonMatching ? !hasMatch : hasMatch) {
      // Match the (standard input) convention from formatLine /
      // grepCount so `echo … | grep -l PATTERN` produces something
      // useful instead of silently dropping the stream.
      out.push(name ?? '(standard input)')
    }
  }
  return out.length > 0 ? ok(out.join('\n') + '\n') : noMatch()
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
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: anyMatched ? 0 : 1 }
}
