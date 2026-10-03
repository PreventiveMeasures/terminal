// Search defaults to BRE; -E selects ERE and -F selects literal patterns.

import { basename, lookup, relativeTo, resolve, walkTree } from '../fs.js'
import { lookupWithNote, omissionNote } from '../notes.js'
import { parseArgs } from '../args.js'
import { consumeStdin, decodeUtf8Marked, encodeUtf8Loose, err, joinLines, parseNonNegativeInt, readFilesFor, readInputs, readTextOrBytes, splitLines, usage } from '../util.js'
import { UnsupportedError, markUnsupported, unsupported, unsupportedFrom, unsupportedNote } from '../unsupported.js'
import { AwkError } from '../awk/common.js'
import { cannotHoldMatch, compilePatterns, inputGap } from './grep-pattern.js'
import { compileGlob } from '../glob.js'
import { countMatches, grepRun, grepSummary, noMatch } from './grep-output.js'
import { grepPatterns } from './grep-pattern-files.js'

const FLAGS = '[-i] [-a|-I] [-s] [-v] [-n] [-r|-R] [-w] [-x] [-o] [-E|-F|-G|-P] [-l] [-L] [-c] [-q] [-m N] [-h] [-H] [-A N] [-B N] [-C N] [--include=GLOB] [--exclude=GLOB] [--exclude-dir=GLOB]'
const USAGE = `grep ${FLAGS} PATTERN [PATH...]\n   or: grep ${FLAGS} [-e PATTERN] [-f FILE] ... [PATH...]`

// -r and -R coincide over a tree holding no links; where one does, -R is the
// spelling that would follow it, and refuses instead.
const SHORT_FLAGS = ['i', 'v', 'n', 'r', 'R', 'l', 'L', 'c', 'w', 'x', 'h', 'H', 'o', 'E', 'F', 'G', 'P', 'q', 'I', 'a', 's']
const VALUE_SHORTS = ['A', 'B', 'C', 'm']

const ARGS = { short: SHORT_FLAGS, long: ['text', 'no-messages'], valueShort: VALUE_SHORTS, repeatable: ['e', 'f', 'file', 'include', 'exclude', 'exclude-dir'] }

// Whether this search was asked for its status alone. Answered by the same
// parse the run uses, so a pattern that merely looks like a flag — `-e -q`,
// or anything after `--` — is read as the operand it is.
export function quietSearch(tokens) {
  try { return parseArgs(tokens, ARGS).flags.has('q') } catch { return false }
}

export function grep(stdin, tokens, ctx) {
  // Repeatable patterns and filename filters retain their own argument values.
  let parsed
  try { parsed = parseArgs(tokens, ARGS) }
  // Preserve diagnostic metadata when converting argument errors to grep status 2.
  catch (e) { return unsupportedFrom(e, 'grep', `grep: ${e.message}`, 2) }
  const { flags, values } = parsed
  const source = grepPatterns(parsed, stdin, ctx)
  if (!source) return usage(USAGE, 2)
  if (source.error) return source.error
  const { patterns, rest } = source
  stdin = source.stdin
  const conflict = checkConflicts(flags)
  if (conflict) return conflict
  let re
  try { re = compilePatterns(patterns, flags, ctx.locale) } catch (e) { return unsupportedFrom(e, 'grep', `grep: ${e.message}`, 2) }
  if (re.error) return re.error
  const counts = parseCounts(values)
  if (counts.error) return counts.error
  // -L still lists readable files at -m0; other modes never open input.
  if (counts.max === 0 && (!flags.has('L') || flags.has('q'))) return noMatch()
  if (counts.max !== 0 && ctx.stdinFile && (flags.has('q') || flags.has('l') || flags.has('L') || values.has('m')) && (rest.length === 0 || rest.includes('-'))) return unsupported('feature', 'grep', 'partial stdin reads', 'grep: early termination on shared file input is not supported', 2)
  const recursive = flags.has('r') || flags.has('R')
  const filters = compileFilters(parsed, ctx)
  const binaryMode = parsed.order.findLast((o) => ['a', 'I', 'text'].includes(o.name))?.name
  filters.ignoreBinary = binaryMode === 'I' && counts.max !== 0
  filters.forceText = binaryMode === 'a' || binaryMode === 'text'
  filters.binaryFiles = filters.forceText ? 'text' : binaryMode === 'I' ? 'without-match' : 'binary'
  filters.silent = flags.has('s') || flags.has('no-messages')
  filters.follow = flags.has('R')
  try { return filteredGrep(stdin, rest, ctx, recursive, filters, re, flags, counts) }
  finally { filterNotes(filters, ctx.notes) }
}

function filteredGrep(stdin, rest, ctx, recursive, filters, re, flags, counts) {
  if (flags.has('q')) return grepQuiet(stdin, rest, ctx, recursive, filters, re.res, flags.has('v'))
  const r = grepInputs(recursive, stdin, rest, ctx, filters)
  if (counts.max === 0) consumeStdin(ctx, stdin)
  const invert = flags.has('v')
  const mode = ['l', 'L', 'c'].find((flag) => flags.has(flag))
  // Filename filters apply to named and recursively discovered files, but not stdin.
  let items = r.items
  if (filters.name.length > 0) items = items.filter((item) => item.failure !== undefined || includedInput(item, filters))
  // A file this cannot search is that file's trouble and not the search's.
  // GNU keeps what the other files matched and says which one it could not
  // read, so one such file in a tree does not take the rest of the answers
  // with it; only a search with nothing left to read is the gap itself.
  let gap = null
  if (counts.max !== 0) {
    items = items.flatMap((item) => {
      if (item.failure !== undefined) return [item]
      const inp = textInput(item, filters, re.res, invert, ctx)
      const found = inputGap([inp], re.res, ctx.locale, !mode && flags.has('o')) ?? (mode ? null : lateBinary(inp, re.res, invert, counts.after))
      gap ??= found
      return found ? [] : [inp]
    })
    if (gap && items.every((item) => item.failure !== undefined)) return gap
  }
  const showName = pickShowName(flags, rest.length)
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
  return r.failed ? { ...result, exitCode: 2 } : result
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
      if (item.failure !== undefined) { stderr += item.failure; continue }
      if (!includedInput(item, filters)) continue
      const inp = textInput(item, filters, res, invert, ctx)
      const gap = inputGap([inp], res, ctx.locale)
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
  if (input.content === undefined) {
    // Unless nothing in it could have been selected anyway: a literal the
    // bytes do not hold selects no line of them, and `-v` selects the lines
    // a pattern does not, which is every line there is.
    if (!invert && cannotHoldMatch(input.bytes, res)) return { ...input, content: '' }
    const at = filters.forceText ? -1 : input.bytes.indexOf(0)
    if (at >= 0 && filters.ignoreBinary) return skipBinary(input, filters, at >= window)
    const marked = { ...input, content: decodeUtf8Marked(input.bytes), marked: true }
    return at < 0 ? marked : binaryInput(marked, input.bytes, at, window)
  }
  const at = filters.forceText ? -1 : input.content.indexOf('\0')
  if (at < 0) return input
  const head = encodeUtf8Loose(input.content.slice(0, at))
  return filters.ignoreBinary ? skipBinary(input, filters, head.length >= window) : binaryInput(input, head, head.length, window)
}

// A file GNU calls binary for a NUL at byte `at`: from the line that NUL is on
// where GNU's first read held it, and from the top where it did not — with the
// lines ended within that read printed as text, if nothing between them and
// the NUL's line depends on how the rest is read (lateBinary).
function binaryInput(input, bytes, at, window) {
  const late = at >= window
  const lineStart = input.content.lastIndexOf('\n', input.content.indexOf('\0')) + 1
  if (!late) return { ...input, nul: true, binaryLine: 0 }
  let read = 0
  for (let i = bytes.indexOf(10); i >= 0 && i < window; i = bytes.indexOf(10, i + 1)) read++
  return { ...input, nul: true, late, lineStart, readLines: read, binaryLine: input.content.slice(0, lineStart).split('\n').length - 1 }
}

// GNU decides on what its first read holds: 96 KiB of a file, and of a pipe
// what the pipe holds, which is 64 KiB.
function firstRead(input, ctx) {
  const stdin = input.name === null || input.name === '/dev/stdin'
  return stdin && !ctx.stdinFile ? 64 * 1024 : 96 * 1024
}

// A NUL past that first read is found once earlier lines have been printed:
// those ended within the read are text, and the file is binary from the NUL's
// line. A line selected between the two, or context reaching past the read,
// depends on how much each later read takes, which is not modelled.
function lateBinary(input, res, invert, after) {
  if (!input.late) return null
  const lines = splitLines(input.content.slice(0, input.lineStart))
  const selects = (some) => countMatches({ ...input, nul: false, content: joinLines(some) }, res, invert, 1) > 0
  if (!selects(lines.slice(input.readLines)) && !(after > 0 && selects(lines.slice(Math.max(0, input.readLines - after), input.readLines)))) return null
  return unsupported('feature', 'grep', 'late binary detection', 'grep: binary detection after the initial input buffer is not supported', 2)
}

// `-I` passes over a binary file: the name is kept for the note that says so,
// and the search is handed the nothing it reads of it. Earlier output, counts
// and a quiet success stay where the NUL is found late, which is refused.
function skipBinary(input, filters, late) {
  if (late) throw new UnsupportedError('feature', 'late binary detection', 'grep: binary detection after the initial input buffer is not supported')
  const path = input.name === null || input.name === '/dev/stdin' ? filters.stdinPath : resolve(filters.cwd, input.name)
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

// Unsupported output/name combinations must be diagnosed; conflicting dialects
// are invalid syntax. -o is only a presentation modifier.
function checkConflicts(flags) {
  if (flags.has('h') && flags.has('H')) {
    return unsupported('option', 'grep', '-h -H', 'grep: combining -h and -H is not supported')
  }
  const modes = ['l', 'L', 'c'].filter((f) => flags.has(f))
  if (modes.length > 1) {
    return unsupported('option', 'grep', 'combined output modes', `grep: ${modes.map((f) => `-${f}`).join(' / ')} are mutually exclusive`)
  }
  const dialects = ['E', 'F', 'G', 'P'].filter((f) => flags.has(f))
  if (dialects.length > 1) {
    return err(`grep: ${dialects.map((f) => `-${f}`).join(' / ')} are mutually exclusive`, 2)
  }
  return null
}

function parseCounts(values) {
  const counts = { A: 0, B: 0, m: undefined }
  // Validate C before explicit A/B overrides; m has grep's distinct error status.
  for (const flag of ['C', 'A', 'B', 'm']) {
    if (!values.has(flag)) continue
    const parsed = parseNonNegativeInt(values.get(flag), 'grep: -' + flag)
    if (parsed.error) {
      if (flag === 'm') parsed.error.exitCode = 2
      return parsed
    }
    if (flag === 'C') counts.A = counts.B = parsed.value
    else counts[flag] = parsed.value
  }
  // An explicit zero context still separates nonadjacent match groups.
  return { after: counts.A, before: counts.B, max: counts.m, hasContext: ['A', 'B', 'C'].some((flag) => values.has(flag)) }
}

function pickShowName(flags, nFiles) {
  // -h / -H override the default. Multiple operands force names;
  // otherwise each file decides from whether it was found recursively.
  if (flags.has('h')) return false
  if (flags.has('H')) return true
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
    if (excludedStartDir(p, filters.dir)) { filters.excluded.add(abs); continue }
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
function compileFilters(parsed, ctx) {
  const name = parsed.order
    .filter((o) => o.name === 'include' || o.name === 'exclude')
    .map((o) => ({ include: o.name === 'include', re: compileGlob(o.value) }))
  const dir = (parsed.values.get('exclude-dir') ?? []).map((g) => compileGlob(g))
  return { name, dir, binary: new Set(), excluded: new Set(), cwd: ctx.cwd, stdinPath: ctx.stdinHandle?.path }
}

function someMatch(res, name) { return res.some((re) => re.test(name)) }

function includedInput(input, filters) {
  if (input.name === null || includedByName(basename(input.name), filters.name)) return true
  filters.excluded.add(resolve(filters.cwd, input.name))
  return false
}

// The last matching filter wins. If none matches, the first filter determines
// whether unmatched names are included by default.
function includedByName(name, nameFilters) {
  if (nameFilters.length === 0) return true
  let last = null
  for (const f of nameFilters) if (f.re.test(name)) last = f
  return last ? last.include : !nameFilters[0].include
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
