// ripgrep over the same engine `grep -P` uses. The two dialects agree on every
// construct both accept, so the work here is deciding what to refuse: rg's
// defaults filter the tree before searching it, and a filter this runtime does
// not model would silently shrink the answer.

import { basename, dirname, lookup, relativeTo, walkTree } from '../fs.js'
import { readTextOrBytes } from '../util.js'
import { parseArgs } from '../args.js'
import { unsupported, unsupportedNote } from '../unsupported.js'
import { ARGS, checkPatterns, patternArgs, rgOptions } from './rg-options.js'
import { grep } from './grep.js'

const gap = (detail, message) => unsupported('feature', 'rg', detail, `rg: ${message}`, 2)

// A refusal always reaches the diagnostic feed. A plain Error carries no detail
// of its own, so the message stands in for one.
function labelled(e, message, kind) {
  const note = unsupportedNote(e) ?? e.note
  return note ? unsupported(note.kind, 'rg', note.detail, message, 2)
    : unsupported(kind, 'rg', e.detail ?? message.replace(/^rg: /u, ''), message, 2)
}

export function rg(stdin, tokens, ctx) {
  let options, parsed
  try {
    parsed = parseArgs(tokens, ARGS)
    options = rgOptions(parsed)
  } catch (e) { return labelled(e, e.message.startsWith('rg: ') ? e.message : `rg: ${e.message}`, 'option') }
  const operands = [...parsed.positional]
  if (!options.patterns.length) {
    if (!operands.length) return gap('usage', 'a pattern is required')
    options.patterns.push(operands.shift())
  }
  try { checkPatterns(options.patterns, options.literal) }
  catch (e) { return labelled(e, e.message, 'feature') }
  // With readable stdin and no path operand, ripgrep searches stdin rather than
  // the tree. A pipe or a `<` redirect counts as connected even when it carries
  // nothing, which is why this asks the shell rather than looking at content.
  const piped = !operands.length && Boolean(ctx.stdinPiped)
  const targets = piped ? { roots: [], recursive: false, stdin: true } : resolveTargets(operands, ctx, options.hidden)
  if (targets.error) return targets.error
  if (!parsed.flags.has('no-ignore') && !options.unrestricted && targets.recursive) {
    const found = ignoreFileIn(targets.roots, ctx)
    if (found) return gap('ignore rules', `${JSON.stringify(found)} would change which files are searched, and its rules are not implemented`)
  }
  // What this run would read, which is what it can be refused over: a file a
  // walk never opens is one ripgrep never answers for either.
  const files = openedFiles(operands, targets, options, ctx)
  // A walk skips binary files, which `grep -I` also does; a named one draws
  // ripgrep's "binary file matches" line, which this runtime cannot produce.
  const binary = options.text ? null : namedBinary(operands, ctx)
  if (binary) return gap('named binary file', `${JSON.stringify(binary)} is binary, and reporting a binary match is not supported`)
  // A file whose bytes spell no text is not binary to ripgrep — it looks for
  // a NUL, not for an encoding — so it searches one and prints the bytes of
  // any line that matches. This terminal can neither search nor print them,
  // named or walked alike, and `--text` asks for the same bytes.
  const unreadable = firstFile(files, ctx, (path) => readTextOrBytes(ctx.fs, path).text === undefined)
  if (unreadable) return gap('unreadable bytes', `${JSON.stringify(unreadable)} holds bytes that are not text, and searching them is not supported`)
  // ripgrep drops a leading byte-order mark before matching, so `^` sits after
  // it; grep matches through it, which would answer differently on both counts.
  const marked = firstFile(files, ctx, (path) => ctx.fs.readFile(path)?.startsWith('\uFEFF') === true)
  if (marked) return gap('byte-order mark', `${JSON.stringify(marked)} begins with a byte-order mark, which ripgrep strips before matching`)
  // ripgrep treats a run that opened nothing as a mistake rather than a miss,
  // since a filter it applied is the usual cause. Only when it chose the
  // starting point itself: name one, even `.`, and an empty walk is just a miss.
  const opened = targets.stdin || operands.length ? 1 : files.length
  if (opened === 0) {
    return { stdout: '', exitCode: 2, stderr: 'rg: No files were searched, which means ripgrep probably applied a filter you didn\'t expect.\nRunning with --debug will show why files are being skipped.\n' }
  }
  return runGrep(stdin, options, operands, targets, ctx)
}

// What a run would open: the paths it was given, and the files a walk finds
// below each starting point, unless a dot-prefixed component keeps them out —
// a hidden file is neither searched nor refused over unless `--hidden` asks
// for it.
function openedFiles(operands, targets, options, ctx) {
  const named = operands.map((operand) => lookup(ctx.cwd, operand, ctx.fs).path).filter(Boolean)
  const walked = []
  for (const root of targets.roots) {
    for (const entry of walkTree(ctx.fs, root)) {
      if (entry.kind !== 'file') continue
      const below = relativeTo(root === '/' ? '/' : root, entry.path).split('/')
      if (options.hidden || below.every((part) => !part.startsWith('.'))) walked.push(entry.path)
    }
  }
  return [...named, ...walked]
}

// The first of them a refusal answers for, named as the caller spelled it.
function firstFile(files, ctx, refuses) {
  for (const path of files) {
    if (!ctx.fs.isDir(path) && refuses(path)) return relativeTo(ctx.cwd === '/' ? '/' : ctx.cwd, path) || path
  }
  return null
}

// rg filters only what it discovers by walking; an operand named on the command
// line is always searched. Mixing the two would need two different filters in
// one run, so a named hidden path alongside a directory is refused instead.
function resolveTargets(operands, ctx, hidden) {
  const roots = []
  let hiddenNamed = false
  for (const operand of operands) {
    const found = lookup(ctx.cwd, operand, ctx.fs)
    if (found.path !== null && ctx.fs.isDir(found.path)) roots.push(found.path)
    if (operand.split('/').some((part) => part.startsWith('.') && part !== '.' && part !== '..')) hiddenNamed = true
  }
  if (!operands.length) roots.push(ctx.cwd)
  const recursive = roots.length > 0
  // With --hidden nothing is filtered out of the walk, so naming a hidden path
  // alongside a directory asks for nothing contradictory.
  if (!hidden && recursive && hiddenNamed && operands.length) {
    return { error: gap('named hidden path', 'a hidden path named beside a directory is searched by ripgrep but skipped while walking, and both cannot apply at once') }
  }
  return { roots, recursive }
}

// ripgrep reads ignore files from every directory above the starting point as
// well as below it, so looking only downward would miss the rules and answer
// with files ripgrep leaves out. `.ignore` and `.rgignore` always apply; a
// `.gitignore` needs a `.git` at or above it to mean anything, and that same
// repository may carry rules in `.git/info/exclude`.
function ignoreFileIn(roots, ctx) {
  const shown = (path) => relativeTo(ctx.cwd === '/' ? '/' : ctx.cwd, path) || path
  const find = (name, mustBite = true) => {
    for (const root of roots) {
      for (const entry of walkTree(ctx.fs, root)) if (basename(entry.path) === name && bites(entry.path, mustBite, ctx)) return entry.path
      for (let at = root; at !== '/'; at = dirname(at)) {
        const found = lookup(dirname(at), name, ctx.fs)
        if (found.path !== null && bites(found.path, mustBite, ctx)) return found.path
      }
    }
    return null
  }
  const always = find('.ignore') ?? find('.rgignore')
  if (always) return shown(always)
  const git = find('.git', false)
  if (!git) return null
  const exclude = lookup(git, 'info/exclude', ctx.fs).path
  const excluding = exclude !== null && bites(exclude, true, ctx) ? exclude : null
  const rules = find('.gitignore') ?? excluding
  return rules ? shown(rules) : null
}

// An ignore file with nothing but blank lines and comments changes no answer,
// so it is not worth turning a run away for. Whether a real rule matches
// anything is a question this runtime does not try to answer.
function bites(path, mustBite, ctx) {
  if (!mustBite || ctx.fs.isDir(path)) return true
  // An ignore file reached through a link is the file that link names, which
  // is what ripgrep opens and reads its rules from.
  const found = lookup('/', path, ctx.fs).path
  // Rules this terminal cannot read are rules it cannot say change nothing.
  const { text } = readTextOrBytes(ctx.fs, found ?? path)
  return (text ?? ' ').split('\n').some((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
}

function namedBinary(operands, ctx) {
  for (const operand of operands) {
    const found = lookup(ctx.cwd, operand, ctx.fs)
    if (found.path === null || ctx.fs.isDir(found.path)) continue
    const { text, bytes } = readTextOrBytes(ctx.fs, found.path)
    if (bytes === undefined ? text?.includes('\0') : bytes.includes(0)) return operand
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
  // grep prints a `--` separator even at zero context; ripgrep prints none, so
  // a zero side is left off rather than passed as zero.
  if (options.after) argv.push('-A', String(options.after))
  if (options.before) argv.push('-B', String(options.before))
  if (targets.recursive) argv.push('-r')
  // Dot-prefixed names are what rg leaves out of a walk. The two directory
  // globs spell that without catching `.` or `..`, either of which can be the
  // starting point: the first takes `.hidden`, the second `..odd`.
  if (targets.recursive && !options.hidden) argv.push('--exclude=.*', '--exclude-dir=.[!.]*', '--exclude-dir=..?*')
  argv.push(...patternArgs(options.patterns, options.literal))
  if (!targets.stdin) argv.push('--', ...(operands.length ? operands : ['.']))
  const before = new Set(ctx.notes)
  const result = grep(stdin, argv, ctx)
  relabelNotes(ctx.notes, before, targets)
  return relabel(countOnly(result, options), operands, options.patterns)
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

const PATTERN_ERROR = /^rg: (?:invalid pattern[^\n]*|trailing backslash)$/mu

// grep names the operand it was given; rg prints the path it walked to.
function relabel(result, operands, patterns) {
  const strip = (text) => (operands.length ? text : text.replaceAll(/^\.\//gmu, ''))
  const out = { ...result, stdout: strip(result.stdout), stderr: osError(strip(result.stderr).replaceAll(/^grep: /gmu, 'rg: ')) }
  const note = unsupportedNote(result)
  // grep blames the locale, because its own answer depends on one. ripgrep has
  // no locale to blame: it matches Unicode the same way everywhere, which is
  // what this runtime cannot follow -- case folding across scripts, and `.`,
  // `\w` and `\b` over codepoints rather than bytes.
  if (note?.detail === 'non-ASCII regex semantics') {
    return unsupported('feature', 'rg', 'non-ASCII matching',
      'rg: Unicode-aware matching on non-ASCII input is not supported', 2)
  }
  if (note) return unsupported(note.kind, 'rg', note.detail, out.stderr.trimEnd() || note.message, result.exitCode)
  if (PATTERN_ERROR.test(out.stderr)) {
    return unsupported('feature', 'rg', 'regex parse error',
      `rg: regex parse error in ${JSON.stringify(patterns.join(' '))}; the reason ripgrep gives is not reproduced here`, 2)
  }
  return out
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
