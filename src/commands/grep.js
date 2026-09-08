// Search defaults to BRE; -E selects ERE and -F selects literal patterns.

import { basename, lookup, relativeTo } from '../fs.js'
import { parseArgs } from '../args.js'
import { consumeStdin, err, parseNonNegativeInt, readFilesFor, readInputs, usage, utf8 } from '../util.js'
import { UnsupportedError, unsupported, unsupportedFrom } from '../unsupported.js'
import { AwkError } from '../awk/common.js'
import { compilePatterns, inputGap } from './grep-pattern.js'
import { compileGlob } from '../glob.js'
import { countMatches, grepRun, grepSummary, noMatch } from './grep-output.js'

const FLAGS = '[-i] [-I] [-v] [-n] [-r|-R] [-w] [-o] [-E|-F|-G] [-l] [-L] [-c] [-q] [-m N] [-h] [-H] [-A N] [-B N] [-C N] [--include=GLOB] [--exclude=GLOB] [--exclude-dir=GLOB]'
const USAGE = `grep ${FLAGS} PATTERN [PATH...]\n   or: grep ${FLAGS} -e PATTERN ... [PATH...]`

// -r and -R coincide because the virtual filesystem has no symlinks.
const SHORT_FLAGS = ['i', 'v', 'n', 'r', 'R', 'l', 'L', 'c', 'w', 'h', 'H', 'o', 'E', 'F', 'G', 'q', 'I']
const VALUE_SHORTS = ['A', 'B', 'C', 'm']

export function grep(stdin, tokens, ctx) {
  // Repeatable patterns and filename filters retain their own argument values.
  let parsed
  try { parsed = parseArgs(tokens, { short: SHORT_FLAGS, valueShort: VALUE_SHORTS, repeatable: ['e', 'include', 'exclude', 'exclude-dir'] }) }
  // Preserve diagnostic metadata when converting argument errors to grep status 2.
  catch (e) { return unsupportedFrom(e, 'grep', `grep: ${e.message}`, 2) }
  const { flags, values, positional } = parsed
  const ePatterns = values.get('e') ?? []
  let patterns, rest
  if (ePatterns.length > 0) { patterns = ePatterns; rest = positional }
  else if (positional.length > 0) { patterns = [positional[0]]; rest = positional.slice(1) }
  else return usage(USAGE)
  const conflict = checkConflicts(flags)
  if (conflict) return conflict
  let re
  try { re = compilePatterns(patterns.flatMap((p) => p.split('\n')), flags) } catch (e) { return unsupportedFrom(e, 'grep', `grep: ${e.message}`, 2) }
  if (re.error) return re.error
  const counts = parseCounts(values)
  if (counts.error) return counts.error
  // -L still lists readable files at -m0; other modes never open input.
  if (counts.max === 0 && (!flags.has('L') || flags.has('q'))) return noMatch()
  if (counts.max !== 0 && ctx.stdinFile && (flags.has('q') || flags.has('l') || flags.has('L') || values.has('m')) && (rest.length === 0 || rest.includes('-'))) return unsupported('feature', 'grep', 'partial stdin reads', 'grep: early termination on shared file input is not supported', 2)
  const recursive = flags.has('r') || flags.has('R')
  const filters = compileFilters(parsed)
  filters.ignoreBinary = flags.has('I') && counts.max !== 0
  if (flags.has('q')) return grepQuiet(stdin, rest, ctx, recursive, filters, re.res, flags.has('v'))
  const r = grepInputs(recursive, stdin, rest, ctx, filters)
  if (counts.max === 0) consumeStdin(ctx, stdin)
  // Filename filters apply to named and recursively discovered files, but not stdin.
  let inputs = r.inputs
  if (filters.name.length > 0) inputs = inputs.filter((inp) => inp.name === null || includedByName(basename(inp.name), filters.name))
  if (filters.ignoreBinary) inputs = inputs.map((inp) => textInput(inp, filters))
  const gap = counts.max === 0 ? null : inputGap(inputs, re.res, flags.has('v'))
  if (gap) return gap
  const showName = pickShowName(flags, rest.length)
  const invert = flags.has('v')
  const opts = { showName, invert, showLine: flags.has('n'), only: flags.has('o'), ...counts }
  const mode = ['l', 'L', 'c'].find((flag) => flags.has(flag))
  let result
  try {
    result = mode ? grepSummary(inputs, re.res, { ...opts, mode }) : grepRun(inputs, re.res, opts)
  } catch (e) {
    if (e instanceof AwkError && e.gap) return unsupported('feature', 'grep', e.gap, `grep: ${e.message}`, 2)
    throw e
  }
  // Read errors preserve successful output but override the match status with exit 2.
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
      if (filters.name.length > 0 && input.name !== null && !includedByName(basename(input.name), filters.name)) continue
      const inp = textInput(input, filters)
      const gap = inputGap([inp], res, invert)
      if (gap) { gap.stderr = stderr + gap.stderr; return gap }
      if (countMatches(inp.content, res, invert, 1) > 0) return { stdout: '', stderr, exitCode: 0 }
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
  const dialects = ['E', 'F', 'G'].filter((f) => flags.has(f))
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

function grepInputs(recursive, stdin, rest, ctx, filters) {
  if (!recursive) {
    const r = readInputs('grep', rest, stdin, ctx)
    return { ...r, inputs: r.inputs.map((input) => input.name === '-' ? { ...input, name: null } : input) }
  }
  const inputs = []
  let stderr = ''
  let failed = false
  for (const p of rest.length ? rest : ['.']) {
    if (p === '-' || p === '/dev/stdin' || p === '/dev/null') {
      const r = readFilesFor('grep', [p], ctx, stdin)
      inputs.push(...r.inputs.map((inp) => ({ ...inp, name: p === '-' ? null : p })))
      if (p === '-' || p === '/dev/stdin') stdin = ''
      continue
    }
    const { path: abs, error } = lookup(ctx.cwd, p, ctx.fs)
    // Filename filters apply after collecting both explicit and discovered files.
    if (ctx.fs.isFile(abs)) { inputs.push({ name: p, content: ctx.fs.readFile(abs) }); continue }
    if (error) { stderr += `grep: ${p}: ${error.toLowerCase()}\n`; failed = true; continue }
    if (excludedStartDir(p, filters.dir)) continue
    for (const filePath of ctx.fs.walkFiles(abs)) {
      if (excludedByDir(filePath, abs, filters.dir)) continue
      // Preserve operand spelling; the implicit '.' root has no display prefix.
      inputs.push({ name: displayName(rest.length ? p : '', abs, filePath), content: ctx.fs.readFile(filePath), recursive: true })
    }
  }
  return { inputs, stderr, failed }
}

// Name filters retain option order so the last matching include/exclude wins.
function compileFilters(parsed) {
  const name = parsed.order
    .filter((o) => o.name === 'include' || o.name === 'exclude')
    .map((o) => ({ include: o.name === 'include', re: compileGlob(o.value) }))
  const dir = (parsed.values.get('exclude-dir') ?? []).map((g) => compileGlob(g))
  return { name, dir }
}

function someMatch(res, name) { return res.some((re) => re.test(name)) }

// The last matching filter wins. If none matches, the first filter determines
// whether unmatched names are included by default.
function includedByName(name, nameFilters) {
  if (nameFilters.length === 0) return true
  let last = null
  for (const f of nameFilters) if (f.re.test(name)) last = f
  return last ? last.include : !nameFilters[0].include
}

// Exclude a file when any directory component below its search root matches.
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
