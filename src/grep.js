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

import { basename, lookup, relativeTo } from './fs.js'
import { parseArgs } from './parse.js'
import { consumeStdin, err, joinLines, parseNonNegativeInt, readFilesFor, splitLines, usage, utf8 } from './util.js'
import { UnsupportedError, unsupported, unsupportedFrom } from './unsupported.js'
import { AwkError } from './awk-common.js'
import { compilePatterns, inputGap } from './grep-pattern.js'
import { compileGlob } from './glob.js'
import { anyMatch, grepCount, grepListFiles, grepRun } from './grep-output.js'

// Two forms because PATTERN is required UNLESS -e is given. Listing
// both makes the conditional explicit — bare `[PATTERN]` would read
// as if `grep [PATH...]` (no pattern at all) were valid, which it
// isn't.
const FLAGS = '[-i] [-I] [-v] [-n] [-r|-R] [-w] [-o] [-E|-F|-G] [-l] [-L] [-c] [-q] [-m N] [-h] [-H] [-A N] [-B N] [-C N] [--include=GLOB] [--exclude=GLOB] [--exclude-dir=GLOB]'
const USAGE = `grep ${FLAGS} PATTERN [PATH...]\n   or: grep ${FLAGS} -e PATTERN ... [PATH...]`

// -R is GNU's "dereference-recursive" — distinct from -r because it
// follows symlinks. The virtual FS has no symlink concept, so the two
// degenerate to the same traversal here; -R is accepted as an alias
// so muscle-memory invocations don't trip over an "unknown option".
const SHORT_FLAGS = ['i', 'v', 'n', 'r', 'R', 'l', 'L', 'c', 'w', 'h', 'H', 'o', 'E', 'F', 'G', 'q', 'I']
const VALUE_SHORTS = ['A', 'B', 'C', 'm']

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
  // `unsupportedFrom` keeps an unknown-option throw classified on its
  // way through this catch — grep builds its own result here, so the
  // dispatcher never sees the original.
  catch (e) { return unsupportedFrom(e, 'grep', `grep: ${e.message}`, 2) }
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
  let re
  try { re = compilePatterns(patterns.flatMap((p) => p.split('\n')), flags) } catch (e) { return unsupportedFrom(e, 'grep', `grep: ${e.message}`, 2) }
  if (re.error) return re.error
  const ctxLines = parseContext(values)
  if (ctxLines.error) return ctxLines.error
  const max = parseMaxCount(values)
  if (max.error) return max.error
  // -L still lists readable files at -m0; other modes never open input.
  if (max.value === 0 && (!flags.has('L') || flags.has('q'))) return noMatch()
  if (max.value !== 0 && ctx.stdinFile && (flags.has('q') || flags.has('l') || flags.has('L') || values.has('m')) && (rest.length === 0 || rest.includes('-'))) return unsupported('feature', 'grep', 'partial stdin reads', 'grep: early termination on shared file input is not supported', 2)
  const recursive = flags.has('r') || flags.has('R')
  const filters = compileFilters(parsed)
  filters.ignoreBinary = flags.has('I') && max.value !== 0
  if (flags.has('q')) return grepQuiet(stdin, rest, ctx, recursive, filters, re.res, flags.has('v'))
  const r = grepInputs(recursive, stdin, rest, ctx, filters)
  if (max.value === 0) consumeStdin(ctx, stdin)
  // include/exclude apply to every file input — named operands AND
  // recursively-discovered files — matching GNU; stdin (name===null) is
  // exempt. exclude-dir already pruned directories inside grepInputs.
  const inputs = r.inputs.filter((inp) => inp.name === null || includedByName(basename(inp.name), filters.name)).map((inp) => textInput(inp, filters))
  const gap = max.value === 0 ? null : inputGap(inputs, re.res, flags.has('v'))
  if (gap) return gap
  const showName = pickShowName(flags, rest.length)
  const invert = flags.has('v')
  const opts = { showName, invert, showLine: flags.has('n'), only: flags.has('o'), after: ctxLines.after, before: ctxLines.before, hasContext: ctxLines.given, max: max.value }
  // -l / -L / -c only ask how many (or whether) lines were selected, and
  // truncating the input at the Nth selection answers that exactly. The
  // line-printing path gets the cap itself instead, because it also has
  // to emit the trailing context that follows the last selection — see
  // grepFileBlock.
  const capped = max.value === undefined ? inputs : inputs.map((inp) => capMatches(inp, re.res, invert, max.value))
  let result
  try { result = flags.has('l') ? grepListFiles(capped, re.res, invert, false)
    : flags.has('L') ? grepListFiles(capped, re.res, invert, true)
    : flags.has('c') ? grepCount(capped, re.res, invert, showName)
    : grepRun(inputs, re.res, opts)
  } catch (e) {
    if (e instanceof AwkError && e.gap) return unsupported('feature', 'grep', e.gap, `grep: ${e.message}`, 2)
    throw e
  }
  // Unreadable file/dir operands don't abort the search: scan what we
  // can, then prepend their errors and force grep's exit-2 ("an error
  // occurred"), which outranks the 0/1 match status.
  if (r.failed) return { stdout: result.stdout, stderr: r.stderr + result.stderr, exitCode: 2 }
  return result
}

// Quiet searches stop at the first selected line. Earlier read errors
// remain on stderr, but cannot override a successful -q exit status.
function grepQuiet(stdin, rest, ctx, recursive, filters, res, invert) {
  let stderr = ''
  let failed = false
  for (const paths of rest.length ? rest.map((p) => [p]) : [[]]) {
    const r = grepInputs(recursive, stdin, paths, ctx, filters)
    stderr += r.stderr
    failed ||= r.failed
    if (paths.includes('-') || (paths.includes('/dev/stdin') && !ctx.stdinFile)) stdin = ''
    for (const input of r.inputs) {
      if (input.name !== null && !includedByName(basename(input.name), filters.name)) continue
      const inp = textInput(input, filters)
      const gap = inputGap([inp], res, invert)
      if (gap) { gap.stderr = stderr + gap.stderr; return gap }
      if (splitLines(inp.content).some((line) => anyMatch(res, line) !== invert)) return { stdout: '', stderr, exitCode: 0 }
    }
  }
  return { stdout: '', stderr, exitCode: failed ? 2 : 1 }
}

// Retain the operand for -L and -c, but binary input selects no lines,
// including under -v. Removing just the NUL-containing line loses data.
function textInput(input, filters) {
  if (!filters.ignoreBinary || !input.content.includes('\0')) return input
  // GNU's initial 96 KiB read detects NUL before matching that buffer.
  // Later discovery may retain earlier output, counts, or a quiet success;
  // buffer growth and read boundaries are not represented by this runtime.
  if (utf8.encode(input.content.slice(0, input.content.indexOf('\0'))).length >= 96 * 1024) throw new UnsupportedError('feature', 'late binary detection', 'grep: binary detection after the initial input buffer is not supported')
  return { ...input, content: '' }
}

// `-m N` stops reading a file after N selected lines. GNU applies it
// per input, and it composes with every output mode — `grep -m1 -c`
// reports 1, not the true total — so rather than teaching each mode a
// limit, truncate the input itself at the line where the Nth match was
// selected. Everything downstream (counts, context, -l) then sees a
// file that genuinely ends there. `-m 0` selects nothing.
function parseMaxCount(values) {
  if (!values.has('m')) return { value: undefined }
  const n = parseNonNegativeInt(values.get('m'), 'grep: -m')
  return n.error ? { error: { ...n.error, exitCode: 2 } } : n
}

function capMatches(input, res, invert, max) {
  if (max === 0) return { ...input, content: '' }
  const lines = splitLines(input.content)
  let seen = 0
  for (let i = 0; i < lines.length; i++) {
    if (anyMatch(res, lines[i]) !== invert && ++seen === max) {
      return { ...input, content: joinLines(lines.slice(0, i + 1)) }
    }
  }
  // Fewer matches than the cap.
  return input
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
    return unsupported('option', 'grep', '-h -H', 'grep: combining -h and -H is not supported')
  }
  const modes = ['l', 'L', 'c'].filter((f) => flags.has(f))
  if (modes.length > 1) {
    return unsupported('option', 'grep', 'combined output modes', `grep: ${modes.map((f) => `-${f}`).join(' / ')} are mutually exclusive`)
  }
  const dialects = ['E', 'F', 'G'].filter((f) => flags.has(f))
  if (dialects.length > 1) {
    return err(`grep: ${dialects.map((f) => `-${f}`).join(' / ')} are mutually exclusive`)
  }
  return null
}

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
  // Whether context was ASKED FOR, which is not the same as asking for a
  // non-zero amount. `grep -A 0` still groups its output — GNU prints a
  // `--` between non-adjacent matches — so the separator keys off the
  // flag being present, not off the count.
  const given = c !== undefined || values.has('A') || values.has('B')
  return b.error ? b : { after: a.value, before: b.value, given }
}

function pickShowName(flags, nFiles) {
  // -h / -H override the default. Multiple operands force names;
  // otherwise each file decides from whether it was found recursively.
  if (flags.has('h')) return false
  if (flags.has('H')) return true
  return nFiles > 1 ? true : undefined
}

function grepInputs(recursive, stdin, rest, ctx, filters) {
  if (recursive) return readFilesRecursive('grep', rest.length > 0 ? rest : ['.'], ctx, filters.dir, rest.length === 0, stdin)
  // A `-` operand is stdin, labelled the way grep labels it.
  if (rest.length > 0) {
    const r = readFilesFor('grep', rest, ctx, stdin)
    return { ...r, inputs: r.inputs.map((i) => (i.name === '-' ? { ...i, name: null } : i)) }
  }
  consumeStdin(ctx)
  return { inputs: [{ name: null, content: stdin }], stderr: '', failed: false }
}

// Expand each path into the list of files to scan: a file path
// contributes itself; a directory contributes every file under it
// (via fs.walkFiles). Missing paths surface as the same "no such
// file or directory" error the non-recursive path uses, so the
// user sees a consistent message. Displayed file names preserve
// the user-typed prefix (`grep -r foo src` produces `src/bar.js:…`,
// not `/src/bar.js:…`), matching GNU grep's output convention.
function readFilesRecursive(cmd, paths, ctx, dirRes, implicitRoot, stdin) {
  const inputs = []
  let stderr = ''
  let failed = false
  for (const p of paths) {
    if (p === '-' || p === '/dev/stdin' || p === '/dev/null') {
      const r = readFilesFor(cmd, [p], ctx, stdin)
      inputs.push(...r.inputs.map((inp) => ({ ...inp, name: p === '-' ? null : p })))
      if (p === '-' || p === '/dev/stdin') stdin = ''
      continue
    }
    const { path: abs, error } = lookup(ctx.cwd, p, ctx.fs)
    // A named file operand is read as-is; include/exclude filtering of
    // both named and discovered files happens once, after collection.
    if (ctx.fs.isFile(abs)) { inputs.push({ name: p, content: ctx.fs.readFile(abs) }); continue }
    if (error) { stderr += `${cmd}: ${p}: ${error.toLowerCase()}\n`; failed = true; continue }
    if (excludedStartDir(p, dirRes)) continue
    for (const filePath of ctx.fs.walkFiles(abs)) {
      if (excludedByDir(filePath, abs, dirRes)) continue
      inputs.push({ name: displayName(implicitRoot && p === '.' ? '' : p, abs, filePath), content: ctx.fs.readFile(filePath), recursive: true })
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
  const dir = (parsed.values.get('exclude-dir') ?? []).map((g) => compileGlob(g))
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
  if (userPath === '') return rel
  return userPath.endsWith('/') ? userPath + rel : userPath + '/' + rel
}
