// ripgrep over the same engine `grep -P` uses. The two dialects agree on every
// construct both accept, so the work here is deciding what to refuse: rg's
// defaults filter the tree before searching it, and a filter this runtime does
// not model would silently shrink the answer.

import { basename, lookup, relativeTo, walkTree } from '../fs.js'
import { parseArgs } from '../args.js'
import { unsupported, unsupportedFrom, unsupportedNote } from '../unsupported.js'
import { grep } from './grep.js'

const SHORT = ['n', 'N', 'i', 's', 'w', 'F', 'v', 'l', 'c', 'q', 'u', 'a']
const LONG = ['line-number', 'no-line-number', 'ignore-case', 'case-sensitive', 'word-regexp',
  'fixed-strings', 'invert-match', 'files-with-matches', 'files-without-match', 'count', 'quiet',
  'hidden', 'no-ignore', 'no-heading', 'with-filename', 'no-filename', 'text']
const ARGS = { short: SHORT, long: LONG, valueShort: ['A', 'B', 'C'], valueLong: ['after-context', 'before-context', 'context'],
  repeatable: ['e', 'regexp'] }

// Every alias that reaches grep unchanged, and the ones that need a rename.
const PASSED = new Map(Object.entries({
  i: 'i', 'ignore-case': 'i', w: 'w', 'word-regexp': 'w', F: 'F', 'fixed-strings': 'F',
  v: 'v', 'invert-match': 'v', c: 'c', count: 'c', q: 'q', quiet: 'q', a: 'a', text: 'a',
  l: 'l', 'files-with-matches': 'l', 'files-without-match': 'L', n: 'n', 'line-number': 'n',
  'with-filename': 'H', 'no-filename': 'h',
}))
const VALUED = new Map(Object.entries({ A: 'A', 'after-context': 'A', B: 'B', 'before-context': 'B', C: 'C', context: 'C' }))
// Accepted and doing nothing: this runtime has no colour, no heading and, once
// the ignore-file check below has passed, no ignore rules left to turn off.
const INERT = new Set(['no-heading', 'no-ignore', 'u', 's', 'case-sensitive', 'N', 'no-line-number'])

// Rust's regex crate has no backtracking, so these parse there rather than
// matching. PCRE accepts all of them, which would answer where rg errors.
const REJECTED = [
  [/\\[1-9]/u, 'backreference'],
  [/\(\?<?[=!]/u, 'look-around'],
  [/\\[QE]/u, String.raw`\Q…\E literal span`],
]
// Ignore files this runtime does not implement. `.gitignore` only takes effect
// inside a git repository, so it is `.git` that makes one matter.
const IGNORE_FILES = new Set(['.git', '.ignore', '.rgignore'])

const gap = (detail, message) => unsupported('feature', 'rg', detail, `rg: ${message}`, 2)

export function rg(stdin, tokens, ctx) {
  let parsed
  try { parsed = parseArgs(tokens, ARGS) }
  catch (e) { return unsupportedFrom(e, 'rg', `rg: ${e.message}`, 2) }
  const explicit = parsed.order.some((o) => o.name === 'e' || o.name === 'regexp')
  const operands = [...parsed.positional]
  const pattern = explicit ? null : operands.shift()
  if (pattern === undefined) return gap('usage', 'a pattern is required')
  const refusal = patternRefusal(explicit ? patternsOf(parsed) : [pattern], parsed)
  if (refusal) return refusal
  // With readable stdin and no path operand, ripgrep searches stdin rather than
  // the tree. This runtime cannot tell an empty pipe from no pipe, so only
  // content or a redirected file counts as connected.
  const piped = !operands.length && (stdin !== '' || ctx.stdinFile)
  const targets = piped ? { roots: [], recursive: false, stdin: true } : resolveTargets(operands, ctx)
  if (targets.error) return targets.error
  if (!parsed.flags.has('no-ignore') && targets.recursive) {
    const found = ignoreFileIn(targets.roots, ctx)
    if (found) return gap('ignore rules', `${JSON.stringify(found)} would change which files are searched, and its rules are not implemented`)
  }
  return runGrep(stdin, parsed, pattern, operands, targets, ctx)
}

const patternsOf = (parsed) => parsed.order.filter((o) => o.name === 'e' || o.name === 'regexp').map((o) => o.value)

function patternRefusal(patterns, parsed) {
  if (parsed.flags.has('F') || parsed.flags.has('fixed-strings')) return null
  for (const source of patterns) {
    for (const [re, detail] of REJECTED) {
      if (re.test(source)) return gap(detail, `${detail} is not supported; ripgrep's regex engine rejects it too`)
    }
  }
  return null
}

// rg filters only what it discovers by walking; an operand named on the command
// line is always searched. Mixing the two would need two different filters in
// one run, so a named hidden path alongside a directory is refused instead.
function resolveTargets(operands, ctx) {
  const roots = []
  let files = 0, hiddenNamed = false
  for (const operand of operands) {
    const found = lookup(ctx.cwd, operand, ctx.fs)
    if (found.path === null) continue
    if (ctx.fs.isDir(found.path)) roots.push(found.path)
    else files++
    if (operand.split('/').some((part) => part.startsWith('.') && part !== '.' && part !== '..')) hiddenNamed = true
  }
  if (!operands.length) roots.push(ctx.cwd)
  const recursive = roots.length > 0
  if (recursive && hiddenNamed) {
    return { error: gap('named hidden path', 'a hidden path named beside a directory is searched by ripgrep but skipped while walking, and both cannot apply at once') }
  }
  return { roots, recursive, onlyFiles: files > 0 && !recursive }
}

function ignoreFileIn(roots, ctx) {
  for (const root of roots) {
    for (const entry of walkTree(ctx.fs, root)) {
      if (IGNORE_FILES.has(basename(entry.path))) return relativeTo(ctx.cwd === '/' ? '/' : ctx.cwd, entry.path) || basename(entry.path)
    }
  }
  return null
}

function runGrep(stdin, parsed, pattern, operands, targets, ctx) {
  // -F selects literal matching in both tools; -P would conflict with it.
  const literal = parsed.flags.has('F') || parsed.flags.has('fixed-strings')
  const argv = literal ? [] : ['-P']
  for (const { name, value } of parsed.order) {
    if (INERT.has(name)) continue
    if (VALUED.has(name)) { argv.push('-' + VALUED.get(name), value); continue }
    const mapped = PASSED.get(name)
    if (mapped) argv.push('-' + mapped)
    else if (name !== 'e' && name !== 'regexp' && name !== 'hidden') return gap(shownName(name), `${shownName(name)} is not supported`)
  }
  if (targets.recursive) argv.push('-r')
  // Dot-prefixed names are what rg leaves out of a walk; `.?*` spares the
  // starting directory, which `.` would otherwise match.
  if (targets.recursive && !parsed.flags.has('hidden')) argv.push("--exclude=.*", "--exclude-dir=.?*")
  for (const source of patternsOf(parsed)) argv.push('-e', source)
  if (pattern !== null) argv.push('-e', pattern)
  if (!targets.stdin) argv.push('--', ...(operands.length ? operands : ['.']))
  const before = new Set(ctx.notes)
  const result = grep(stdin, argv, ctx)
  relabelNotes(ctx.notes, before, targets)
  return relabel(countOnly(result, parsed), operands)
}

// grep -c reports every file it opened; ripgrep lists only the ones that matched.
function countOnly(result, parsed) {
  if (!parsed.flags.has('c') && !parsed.flags.has('count')) return result
  const kept = result.stdout.split('\n').filter((line) => line !== '' && line !== '0' && !line.endsWith(':0'))
  return { ...result, stdout: kept.length ? kept.join('\n') + '\n' : '' }
}

const shownName = (name) => (name.length === 1 ? '-' : '--') + name

// grep names the operand it was given; rg prints the path it walked to.
function relabel(result, operands) {
  const strip = (text) => (operands.length ? text : text.replaceAll(/^\.\//gmu, ''))
  const out = { ...result, stdout: strip(result.stdout), stderr: strip(result.stderr).replaceAll(/^grep: /gmu, 'rg: ') }
  const note = unsupportedNote(result)
  return note ? Object.assign(out, { unsupported: undefined }) && renameGap(out, note) : out
}

function renameGap(result, note) {
  return unsupported(note.kind, 'rg', note.detail, result.stderr.trimEnd() || note.message, result.exitCode)
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
