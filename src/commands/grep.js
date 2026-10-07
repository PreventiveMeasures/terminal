// Search defaults to BRE; -E selects ERE and -F selects literal patterns.

import { basename, lookup, relativeTo, resolve, walkTree } from '../fs.js'
import { lookupWithNote, omissionNote } from '../notes.js'
import { consumeStdin, countNewlines, decodeUtf8Marked, encodeUtf8Loose, err, readFilesFor, readInputs, readTextOrBytes, splitLines } from '../util.js'
import { UnsupportedError, markUnsupported, unsupported, unsupportedFrom, unsupportedNote } from '../unsupported.js'
import { AwkError } from '../awk/common.js'
import { cannotHoldMatch, compilePatterns, inputGap } from './grep-pattern.js'
import { compileGlob } from '../glob.js'
import { anyMatch, countMatches, grepRun, grepSummary, isFailure, matchersFor, noMatch } from './grep-output.js'
import { GREP_USAGE, grepPatterns } from './grep-pattern-files.js'
import { argumentError, colourGap, optionDeath, parseCounts, parseGrepArgs } from './grep-options.js'

// Whether this search was asked for its status alone. Answered by the same
// parse the run uses, so a pattern that merely looks like a flag — `-e -q`,
// or anything after `--` — is read as the operand it is.
export function quietSearch(tokens) {
  try { return parseGrepArgs(tokens).flags.has('q') } catch { return false }
}

export function grep(stdin, tokens, ctx) {
  // Repeatable patterns and filename filters retain their own argument values.
  let parsed
  try { parsed = parseGrepArgs(tokens) }
  // Preserve diagnostic metadata when converting argument errors to grep status 2.
  catch (e) { return argumentError(tokens, e, stdin, ctx) ?? unsupportedFrom(e, 'grep', `grep: ${e.message}`, 2) }
  const { flags, values, order } = parsed
  const colour = colourGap(order, tokens)
  if (colour) return colour
  const source = grepPatterns(parsed, stdin, ctx, optionDeath())
  if (!source) return err(GREP_USAGE, 2)
  if (source.error) return source.error
  const { patterns, rest } = source
  stdin = source.stdin
  const counts = parseCounts(values)
  // -q outranks -l and -L, and the later of those two outranks the other
  // and -c.
  const mode = flags.has('q') ? null : order.findLast((o) => o.name === 'l' || o.name === 'L')?.name ?? (flags.has('c') ? 'c' : null)
  // -L still lists readable files at -m0; other modes never open input. Nor
  // do they for a search that can select no line, which GNU does not run —
  // and decides before it looks at a pattern at all.
  if ((counts.max === 0 || selectsNothing(patterns, flags)) && mode !== 'L') return noMatch()
  let re
  try { re = compilePatterns(patterns, flags, ctx.locale, source.origins) } catch (e) { return unsupportedFrom(e, 'grep', `grep: ${e.message}`, 2) }
  if (re.error) return re.error
  if (counts.max !== 0 && ctx.stdinFile && (flags.has('q') || mode === 'l' || mode === 'L' || counts.max !== undefined) && (rest.length === 0 || rest.includes('-'))) return unsupported('feature', 'grep', 'partial stdin reads', 'grep: early termination on shared file input is not supported', 2)
  const recursive = flags.has('r') || flags.has('R')
  const filters = compileFilters(parsed, ctx)
  const binaryMode = order.findLast((o) => o.name === 'a' || o.name === 'I')?.name
  filters.binaryFiles = binaryMode === 'a' ? 'text' : binaryMode === 'I' ? 'without-match' : 'binary'
  filters.silent = flags.has('s')
  filters.follow = flags.has('R')
  try { return warned(filteredGrep(stdin, rest, ctx, recursive, filters, re, flags, counts, mode, order), re.warnings) }
  finally { filterNotes(filters, ctx.notes) }
}

// What the dfa said of the patterns comes before anything the search says.
function warned(result, warnings) {
  if (!warnings || unsupportedNote(result)) return result
  result.stderr = warnings + result.stderr
  result.events?.unshift({ fd: 2, text: warnings })
  return result
}

function filteredGrep(stdin, rest, ctx, recursive, filters, re, flags, counts, mode, order) {
  if (flags.has('q')) return grepQuiet(stdin, rest, ctx, recursive, filters, re.res, flags.has('v'))
  const r = grepInputs(recursive, stdin, rest, ctx, filters)
  if (counts.max === 0) consumeStdin(ctx, stdin)
  const invert = flags.has('v')
  // Filename filters apply to named and recursively discovered files, but not stdin.
  let items = r.items
  if (filters.name.length > 0) items = items.filter((item) => isFailure(item) || includedInput(item, filters))
  // A file this cannot search is that file's trouble and not the search's.
  // GNU keeps what the other files matched and says which one it could not
  // read, so one such file in a tree does not take the rest of the answers
  // with it; only a search with nothing left to read is the gap itself.
  let gap = null
  if (counts.max !== 0) {
    items = items.flatMap((item) => {
      if (isFailure(item)) return [item]
      const inp = textInput(item, filters, re.res, invert, ctx)
      const found = inputGap(inp, re.res, ctx.locale, !mode && flags.has('o'))
        ?? (mode ? null : lateBinary(inp, re.res, invert, counts.after) ?? contextAcrossReads(inp, counts, flags, filters, ctx))
      gap ??= found
      return found ? [] : [inp]
    })
    if (gap && items.every(isFailure)) return gap
  }
  const showName = pickShowName(order, rest.length)
  const opts = { showName, invert, showLine: flags.has('n'), only: flags.has('o'), binaryFiles: filters.binaryFiles, ...counts }
  let result
  try {
    result = mode ? grepSummary(items, re.res, { ...opts, mode }) : grepRun(items, re.res, opts)
  } catch (e) {
    if (e instanceof AwkError && e.gap) return unsupported('feature', 'grep', e.gap, `grep: ${e.message}`, 2)
    return unsupportedFrom(e, 'grep', `grep: ${e.message}`, 2)
  }
  // Read errors preserve successful output but override the match status with exit 2.
  if (gap) {
    const note = unsupportedNote(gap)
    const left = { ...result, stderr: result.stderr + gap.stderr, exitCode: 2, events: [...result.events, { fd: 2, text: gap.stderr }] }
    return markUnsupported(left, note.kind, note.command, note.detail, note.message)
  }
  if (r.failed) result.exitCode = 2
  return result
}

// Quiet searches stop at the first selected line. Earlier read errors
// remain on stderr, but cannot override a successful -q exit status.
function grepQuiet(stdin, rest, ctx, recursive, filters, res, invert) {
  let stderr = ''
  let failed = false
  for (const paths of rest.length ? rest.map((p) => [p]) : [[]]) {
    const r = grepInputs(recursive, stdin, paths, ctx, filters)
    failed ||= r.failed
    if (paths.includes('-') || (paths.includes('/dev/stdin') && !ctx.stdinFile)) stdin = ''
    for (const item of r.items) {
      if (isFailure(item)) { stderr += item.failure; continue }
      if (!includedInput(item, filters)) continue
      const inp = textInput(item, filters, res, invert, ctx)
      const gap = inputGap(inp, res, ctx.locale)
      if (gap) { gap.stderr = stderr + gap.stderr; return gap }
      if (countMatches(inp, res, invert, 1) > 0) return { stdout: '', stderr, exitCode: 0 }
    }
  }
  return { stdout: '', stderr, exitCode: failed ? 2 : 1 }
}

// What a search reads a file as. Text is read as it is, and bytes that spell
// none as the characters they do spell with a marker for each byte that is
// none (decodeUtf8Marked) — GNU searches such a file all the same, and holds
// back each line it would print that has such a byte in it (grepRun). A NUL
// within GNU's first read makes the file binary from its first line: NULs end
// lines there, and the first selection only says that the file matches. `-I`
// passes over that file instead, and `-a` reads both as text.
function textInput(input, filters, res, invert, ctx) {
  const window = firstRead(input, ctx)
  const skip = filters.binaryFiles === 'without-match'
  const text = filters.binaryFiles === 'text'
  if (input.content === undefined) {
    // Unless nothing in it could have been selected anyway: a literal the
    // bytes do not hold selects no line of them, and `-v` selects the lines
    // a pattern does not, which is every line there is.
    if (!invert && cannotHoldMatch(input.bytes, res)) return { ...input, content: '' }
    const at = text ? -1 : input.bytes.indexOf(0)
    if (at >= 0 && skip) return skipBinary(input, filters, at >= window)
    const marked = { ...input, content: decodeUtf8Marked(input.bytes), marked: true }
    return at < 0 ? marked : binaryInput(marked, input.bytes, at, window)
  }
  const at = text ? -1 : input.content.indexOf('\0')
  if (at < 0) return input
  // A character is a byte at least, so the text up to the read's end in
  // characters holds the whole read and says whether the NUL is past it.
  const head = encodeUtf8Loose(input.content.slice(0, Math.min(at, window)))
  return skip ? skipBinary(input, filters, head.length >= window) : binaryInput(input, head, head.length, window)
}

// A file GNU calls binary for a NUL at byte `at`: from the line that NUL is on
// where GNU's first read held it, and from the top where it did not — with the
// lines ended within that read printed as text, if nothing between them and
// the NUL's line depends on how the rest is read (lateBinary).
function binaryInput(input, bytes, at, window) {
  if (at < window) return { ...input, binaryLine: 0 }
  const lineStart = input.content.lastIndexOf('\n', input.content.indexOf('\0')) + 1
  return { ...input, lineStart, readLines: countNewlines(bytes.subarray(0, window)), binaryLine: countNewlines(input.content.slice(0, lineStart)) }
}

const isStdin = (input) => input.name === null || input.name === '/dev/stdin'

// GNU decides on what its first read holds: 96 KiB of a file, and of a pipe
// what the pipe holds, which is 64 KiB.
const firstRead = (input, ctx) => (isStdin(input) && !ctx.stdinFile ? 64 * 1024 : 96 * 1024)

// A NUL past that first read is found once earlier lines have been printed:
// those ended within the read are text, and the file is binary from the NUL's
// line. A line selected between the two, or context reaching past the read,
// depends on how much each later read takes, which is not modelled.
function lateBinary(input, res, invert, after) {
  if (input.readLines === undefined) return null
  const lines = splitLines(input.content.slice(0, input.lineStart))
  const tests = matchersFor(input, res)
  const selects = (from, to) => lines.slice(from, to).some((line) => anyMatch(tests, line) !== invert)
  if (!selects(input.readLines) && !(after > 0 && selects(Math.max(0, input.readLines - after), input.readLines))) return null
  return unsupported('feature', 'grep', 'late binary detection', 'grep: binary detection after the initial input buffer is not supported', 2)
}

// GNU searches a file a read at a time, and a line it holds back leaves the
// last line it printed behind where a read ends. Where the next read begins
// then decides the group separators and the context that follow, and how
// much each read past the first takes is not modelled; within that first
// read, or with no context asked for, nothing depends on it.
function contextAcrossReads(input, counts, flags, filters, ctx) {
  if (!input.marked || input.binaryLine !== undefined || !counts.hasContext || flags.has('o') || filters.binaryFiles === 'text') return null
  if (input.bytes.length <= firstRead(input, ctx)) return null
  return unsupported('feature', 'grep', 'binary context across reads', 'grep: context around lines held back past the first read is not supported', 2)
}

// `-I` passes over a binary file: the name is kept for the note that says so,
// and the search is handed the nothing it reads of it. Earlier output, counts
// and a quiet success stay where the NUL is found late, which is refused.
function skipBinary(input, filters, late) {
  if (late) throw new UnsupportedError('feature', 'late binary detection', 'grep: binary detection after the initial input buffer is not supported')
  const path = isStdin(input) ? filters.stdinPath : resolve(filters.cwd, input.name)
  if (path) filters.binary.add(path)
  else filters.binaryStdin = true
  return { ...input, content: '' }
}

function filterNotes(filters, notes) {
  const explanation = 'Binary input is treated as text with -a.'
  omissionNote(notes, { command: 'grep', action: 'skipped', noun: ['binary file', 'binary files'], paths: filters.binary, explanation })
  if (filters.binaryStdin) notes.add('grep: skipped binary standard input. ' + explanation)
  omissionNote(notes, { command: 'grep', action: 'excluded', noun: ['entry', 'entries'], paths: filters.excluded, context: ' by --include/--exclude/--exclude-dir rules' })
}

// No pattern at all matches no line, which GNU reads as `-v ''`; and an
// empty pattern matches every line, so `-v` with nothing else selects none —
// unless -x or -w ask more of a line than that it is there.
function selectsNothing(patterns, flags) {
  if (patterns.length === 0) return !flags.has('v')
  return flags.has('v') && !flags.has('x') && !flags.has('w') && patterns.every((pattern) => pattern === '')
}

function pickShowName(order, nFiles) {
  // The later of -h and -H overrides the default. Multiple operands force
  // names; otherwise each file decides from whether it was found recursively.
  const named = order.findLast((o) => o.name === 'h' || o.name === 'H')?.name
  if (named) return named === 'H'
  return nFiles > 1 ? true : undefined
}

// What a search reads, in the order it reads it: each file, and the words for
// one it could not open where that one came. -s drops the words.
function grepInputs(recursive, stdin, rest, ctx, filters) {
  const say = (failure) => (filters.silent ? [] : [{ failure }])
  if (!recursive) {
    const r = readInputs('grep', rest, stdin, ctx, { read: 'maybe-text' })
    const items = r.entries.flatMap((entry) => (entry.kind === 'file' ? [entry.name === '-' ? { ...entry, name: null } : entry] : say(entry.failure)))
    return { items, failed: r.failed }
  }
  const items = []
  let failed = false
  const fail = (failure) => { items.push(...say(failure)); failed = true }
  for (const p of rest.length ? rest : ['.']) {
    if (p === '-' || p === '/dev/stdin' || p === '/dev/null') {
      const r = readFilesFor('grep', [p], ctx, stdin)
      items.push(...r.inputs.map((inp) => ({ ...inp, name: p === '-' ? null : p })))
      if (p === '-' || p === '/dev/stdin') stdin = ''
      continue
    }
    const { path: abs, error } = lookupWithNote(ctx, 'grep', p)
    // Filename filters apply after collecting both explicit and discovered files.
    if (ctx.fs.isFile(abs)) { items.push({ name: p, ...searchable(ctx, abs) }); continue }
    if (error) { fail(`grep: ${p}: ${error}\n`); continue }
    if (excludedStartDir(p, filters.dir, rest.length === 0)) { filters.excluded.add(abs); continue }
    const descend = (path) => {
      if (path === abs || filters.dir.length === 0 || !someMatch(filters.dir, basename(path))) return true
      filters.excluded.add(path)
      return false
    }
    for (const entry of walkTree(ctx.fs, abs, Infinity, descend)) {
      // `-r` passes over a link a walk reaches; `-R` searches what it names.
      if (entry.kind === 'link') {
        if (!filters.follow) continue
        const found = followedLink(entry.path, displayName(rest.length ? p : '', abs, entry.path), ctx, filters)
        if (found?.input) items.push(found.input)
        if (found?.error) fail(found.error)
        continue
      }
      if (entry.kind !== 'file') continue
      const filePath = entry.path
      // Preserve operand spelling; the implicit '.' root has no display prefix.
      items.push({ name: displayName(rest.length ? p : '', abs, filePath), ...searchable(ctx, filePath), recursive: true })
    }
  }
  return { items, failed }
}

// What `-R` makes of a link a walk reached: the file it names, read under the
// link's own name, or the diagnostic a link to nothing earns. A rule keeping
// the name out is what neither spelling ever opens, so the rules answer first
// — the --exclude-dir ones where the link leads to a directory, the
// --include/--exclude ones where it leads to a file, as GNU sorts them. A
// directory is the one thing left: crossing into that tree is not modelled, so
// `-R` refuses it rather than search a part of it.
function followedLink(path, named, ctx, filters) {
  const target = lookup(ctx.cwd, path, ctx.fs)
  const directory = ctx.fs.isDir(target.path)
  const kept = directory
    ? filters.dir.length === 0 || !someMatch(filters.dir, basename(path))
    : includedByName(basename(path), filters.name)
  if (!kept) { filters.excluded.add(path); return null }
  if (directory) throw new UnsupportedError('option', '-R', `following a symbolic link to a directory is not supported: ${named}`)
  if (target.error) return { error: `grep: ${named}: ${target.error}\n` }
  return { input: { name: named, ...searchable(ctx, target.path), recursive: true } }
}

// What a search reads of a file: the text it spells, or the bytes where it
// spells none. A file whose bytes its locale cannot read is binary to GNU as
// surely as one holding a NUL, and `textInput` answers for both.
function searchable(ctx, path) {
  const { text, bytes } = readTextOrBytes(ctx.fs, path)
  return text === undefined ? { content: undefined, bytes } : { content: text }
}

// Name filters retain option order so the last matching include/exclude wins.
// GNU strips the trailing slashes off an --exclude-dir pattern as it reads it.
function compileFilters(parsed, ctx) {
  const name = parsed.order
    .filter((o) => o.name === 'include' || o.name === 'exclude')
    .map((o) => ({ include: o.name === 'include', re: compileGlob(o.value) }))
  const dir = (parsed.values.get('exclude-dir') ?? []).map((g) => compileGlob(g.replace(/(?<=.)\/+$/u, '')))
  return { name, dir, binary: new Set(), excluded: new Set(), cwd: ctx.cwd, stdinPath: ctx.stdinHandle?.path }
}

function someMatch(res, name, test = anchored) { return res.some((re) => test(re, name)) }

// A name a walk found is matched by its last component; a name given on the
// command line is matched as typed, and also from just past each `/` in it,
// so `--exclude='d/*'` and `--exclude='*/a.txt'` both reach `d/a.txt` — and
// with `*` taking a `/` as it takes any other character.
const anchored = (re, name) => re.test(name)
function unanchored(re, name) {
  if (re.test(name)) return true
  for (let at = name.indexOf('/'); at >= 0; at = name.indexOf('/', at + 1)) {
    if (name[at + 1] !== '/' && re.test(name.slice(at + 1))) return true
  }
  return false
}

function includedInput(input, filters) {
  if (input.name === null) return true
  if (input.recursive ? includedByName(basename(input.name), filters.name) : includedByName(input.name, filters.name, unanchored)) return true
  filters.excluded.add(resolve(filters.cwd, input.name))
  return false
}

// The last matching filter wins. If none matches, the first filter determines
// whether unmatched names are included by default.
function includedByName(name, nameFilters, test = anchored) {
  if (nameFilters.length === 0) return true
  let last = null
  for (const f of nameFilters) if (test(f.re, name)) last = f
  return last ? last.include : !nameFilters[0].include
}

// GNU also prunes a start directory named on the command line, matched as
// typed (unanchored, above) — `--exclude-dir=foo` drops a `foo` or `d/foo`
// operand but not a `foo/` one, which no pattern without a `/` reaches. The
// `.` a search walks when it was named nothing is never pruned.
function excludedStartDir(operand, dirRes, implicit) {
  return !implicit && dirRes.length > 0 && someMatch(dirRes, operand, unanchored)
}

function displayName(userPath, absRoot, absFile) {
  const rel = relativeTo(absRoot, absFile)
  if (userPath === '') return rel
  return userPath.endsWith('/') ? userPath + rel : userPath + '/' + rel
}
