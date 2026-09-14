// ripgrep over the same engine `grep -P` uses. The two dialects agree on every
// construct both accept, so the work here is deciding what to refuse: rg's
// defaults filter the tree before searching it, and a filter this runtime does
// not model would silently shrink the answer.

import { basename, lookup, relativeTo, walkTree } from '../fs.js'
import { parseArgs } from '../args.js'
import { unsupported, unsupportedFrom, unsupportedNote } from '../unsupported.js'
import { ARGS, checkPatterns, patternArgs, rgOptions } from './rg-options.js'
import { grep } from './grep.js'

// Ignore files this runtime does not implement. `.gitignore` only takes effect
// inside a git repository, so it is `.git` that makes one matter.
const IGNORE_FILES = new Set(['.git', '.ignore', '.rgignore'])

const gap = (detail, message) => unsupported('feature', 'rg', detail, `rg: ${message}`, 2)

export function rg(stdin, tokens, ctx) {
  let options, parsed
  try {
    parsed = parseArgs(tokens, ARGS)
    options = rgOptions(parsed)
  } catch (e) { return unsupportedFrom(e, 'rg', e.message.startsWith('rg: ') ? e.message : `rg: ${e.message}`, 2) }
  const operands = [...parsed.positional]
  if (!options.patterns.length) {
    if (!operands.length) return gap('usage', 'a pattern is required')
    options.patterns.push(operands.shift())
  }
  try { checkPatterns(options.patterns, options.literal) }
  catch (e) { return unsupportedFrom(e, 'rg', e.message, 2) }
  // With readable stdin and no path operand, ripgrep searches stdin rather than
  // the tree. This runtime cannot tell an empty pipe from no pipe, so only
  // content or a redirected file counts as connected.
  const piped = !operands.length && (stdin !== '' || ctx.stdinFile)
  const targets = piped ? { roots: [], recursive: false, stdin: true } : resolveTargets(operands, ctx)
  if (targets.error) return targets.error
  if (!parsed.flags.has('no-ignore') && !options.unrestricted && targets.recursive) {
    const found = ignoreFileIn(targets.roots, ctx)
    if (found) return gap('ignore rules', `${JSON.stringify(found)} would change which files are searched, and its rules are not implemented`)
  }
  // A walk skips binary files, which `grep -I` also does; a named one draws
  // ripgrep's "binary file matches" line, which this runtime cannot produce.
  const binary = options.text ? null : namedBinary(operands, ctx)
  if (binary) return gap('named binary file', `${JSON.stringify(binary)} is binary, and reporting a binary match is not supported`)
  return runGrep(stdin, options, operands, targets, ctx)
}

// rg filters only what it discovers by walking; an operand named on the command
// line is always searched. Mixing the two would need two different filters in
// one run, so a named hidden path alongside a directory is refused instead.
function resolveTargets(operands, ctx) {
  const roots = []
  let hiddenNamed = false
  for (const operand of operands) {
    const found = lookup(ctx.cwd, operand, ctx.fs)
    if (found.path !== null && ctx.fs.isDir(found.path)) roots.push(found.path)
    if (operand.split('/').some((part) => part.startsWith('.') && part !== '.' && part !== '..')) hiddenNamed = true
  }
  if (!operands.length) roots.push(ctx.cwd)
  const recursive = roots.length > 0
  if (recursive && hiddenNamed && operands.length) {
    return { error: gap('named hidden path', 'a hidden path named beside a directory is searched by ripgrep but skipped while walking, and both cannot apply at once') }
  }
  return { roots, recursive }
}

function ignoreFileIn(roots, ctx) {
  for (const root of roots) {
    for (const entry of walkTree(ctx.fs, root)) {
      if (IGNORE_FILES.has(basename(entry.path))) return relativeTo(ctx.cwd === '/' ? '/' : ctx.cwd, entry.path) || basename(entry.path)
    }
  }
  return null
}

function namedBinary(operands, ctx) {
  for (const operand of operands) {
    const found = lookup(ctx.cwd, operand, ctx.fs)
    if (found.path === null || ctx.fs.isDir(found.path)) continue
    if (ctx.fs.readFile(found.path)?.includes('\0')) return operand
  }
  return null
}

function runGrep(stdin, options, operands, targets, ctx) {
  const argv = options.literal ? ['-F'] : ['-P']
  if (options.ignoreCase) argv.push('-i')
  if (options.lineNumbers) argv.push('-n')
  if (options.word) argv.push('-w')
  if (options.invert) argv.push('-v')
  if (options.quiet) argv.push('-q')
  if (options.mode) argv.push('-' + options.mode)
  if (options.showName) argv.push('-' + options.showName)
  argv.push(options.text ? '-a' : '-I')
  for (const [flag, value] of options.context) argv.push(flag, value)
  if (targets.recursive) argv.push('-r')
  // Dot-prefixed names are what rg leaves out of a walk; `.?*` spares the
  // starting directory, which `.` would otherwise match.
  if (targets.recursive && !options.hidden) argv.push('--exclude=.*', '--exclude-dir=.?*')
  argv.push(...patternArgs(options.patterns, options.literal))
  if (!targets.stdin) argv.push('--', ...(operands.length ? operands : ['.']))
  const before = new Set(ctx.notes)
  const result = grep(stdin, argv, ctx)
  relabelNotes(ctx.notes, before, targets)
  return relabel(countOnly(result, options), operands)
}

// grep -c reports every file it opened; ripgrep lists only the ones that matched.
function countOnly(result, options) {
  if (options.mode !== 'c') return result
  const kept = result.stdout.split('\n').filter((line) => line !== '' && line !== '0' && !line.endsWith(':0'))
  return { ...result, stdout: kept.length ? kept.join('\n') + '\n' : '' }
}

// ripgrep prints the operating system's error number beside the text.
const ERRNO = new Map([['No such file or directory', 2], ['Not a directory', 20], ['Is a directory', 21]])
const osError = (text) => text.replaceAll(/^(rg: .*: )([A-Z][a-z].*)$/gmu,
  (line, head, reason) => (ERRNO.has(reason) ? `${head}${reason} (os error ${ERRNO.get(reason)})` : line))

// grep names the operand it was given; rg prints the path it walked to.
function relabel(result, operands) {
  const strip = (text) => (operands.length ? text : text.replaceAll(/^\.\//gmu, ''))
  const out = { ...result, stdout: strip(result.stdout), stderr: osError(strip(result.stderr).replaceAll(/^grep: /gmu, 'rg: ')) }
  const note = unsupportedNote(result)
  return note ? unsupported(note.kind, 'rg', note.detail, out.stderr.trimEnd() || note.message, result.exitCode) : out
}

// The excluded-entries note is grep's wording for a rule rg applies by default.
function relabelNotes(notes, before, targets) {
  const added = []
  for (const note of notes) if (!before.has(note) && note.startsWith('grep: excluded ')) added.push(note)
  for (const note of added) {
    notes.delete(note)
    if (!targets.recursive) continue
    notes.add(note.replace(/^grep: excluded (\d+) (entry|entries) by --include\/--exclude\/--exclude-dir rules/u,
      'rg: skipped $1 hidden $2').replace(/\.$/u, '. Hidden entries are searched with --hidden.'))
  }
}
