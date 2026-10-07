// ripgrep over the same engine `grep -P` uses, with its patterns read as the
// Rust regex syntax they are and spelt for that engine (./rg-regex.js). The
// rest of the work is deciding what to refuse: rg's defaults filter the tree
// before searching it, and a filter this runtime does not model would silently
// shrink the answer.

import { basename, dirname, lookup, relativeTo, walkTree } from '../fs.js'
import { decodeUtf8Maybe, encodeUtf8, inputLabel, readTextOrBytes } from '../util.js'
import { parseArgs } from '../args.js'
import { markUnsupported, unsupported, unsupportedNote } from '../unsupported.js'
import { ARGS, rgOptions } from './rg-options.js'
import { rgPattern } from './rg-regex.js'
import { binaryStdin, cutFs, cutOutput, walkedBinaries } from './rg-binary.js'
import { RIPGREP, search } from './grep.js'
import { literalsMissing } from './grep-literal.js'

const gap = (detail, message) => unsupported('feature', 'rg', detail, `rg: ${message}`, 2)
const BINARY_GAPS = {
  'unreadable bytes': 'a binary file holds bytes that are not text before its first NUL, and searching them is not supported',
  'binary file search order': 'how much of a binary file ripgrep reads before its NUL turns on what its threads searched first, beside a line over 64 KiB long, and is not modelled',
}

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
  // ripgrep reads its patterns before it opens anything, and reports one Rust
  // rejects in Rust's words.
  let regex = null
  if (!options.literal) {
    const read = rgPattern(options.patterns)
    if (read.error) return read.error
    regex = read.pattern
  }
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
  // A file a walk found, and standard input, are read as ./rg-binary.js says
  // where they hold a NUL; a named file is searched another way, and refused.
  const binary = options.text ? null : namedBinary(operands, ctx)
  if (binary) return gap('named binary file', `${JSON.stringify(binary)} is binary, and reporting a binary match is not supported`)
  const refused = refusedFile(files, options, ctx) ?? (targets.stdin ? refusedStdin(options, ctx) : null)
  if (refused) return gap(refused.detail, refused.message)
  // `-` names standard input, which reads the same way alone; beside other
  // paths its place among them is not followed.
  const stdinOnly = targets.stdin || (operands.length === 1 && operands[0] === '-')
  const nul = (stdinOnly || operands.includes('-')) && !options.text ? stdinWithNul(stdin, options, ctx) : null
  if (nul && !stdinOnly) return gap('binary input among files', 'binary standard input searched beside other paths is not supported')
  if (nul) return binaryInput(nul, options, regex, ctx)
  const walked = options.text || !targets.recursive ? { cut: new Map() } : walkedBinaries(files.map((file) => ({ ...file, ...(file.named ? {} : readTextOrBytes(ctx.fs, file.path)) })), options.mode === 'c' || options.mode === 'L')
  if (walked.gap) return gap(walked.gap, BINARY_GAPS[walked.gap])
  const { cut } = walked
  if ((options.after || options.before || options.showName === 'h') && [...cut.values()].some((c) => c.text !== '')) {
    return gap('binary file read in part', 'context around, or unnamed lines from, a binary file ripgrep stops reading part way is not supported')
  }
  // ripgrep treats a run that opened nothing as a mistake rather than a miss,
  // since a filter it applied is the usual cause. Only when it chose the
  // starting point itself: name one, even `.`, and an empty walk is just a miss.
  const opened = targets.stdin || operands.length ? 1 : files.length
  if (opened === 0) {
    return { stdout: '', exitCode: 2, stderr: 'rg: No files were searched, which means ripgrep probably applied a filter you didn\'t expect.\nRunning with --debug will show why files are being skipped.\n' }
  }
  return runGrep(stdin, options, regex, operands, targets, ctx, cut)
}

// What a run would open: the paths it was given, and the files a walk finds
// below each starting point, unless a dot-prefixed component keeps them out —
// a hidden file is neither searched nor refused over unless `--hidden` asks
// for it.
function openedFiles(operands, targets, options, ctx) {
  const files = operands.map((operand) => lookup(ctx.cwd, operand, ctx.fs).path).filter(Boolean).map((path) => ({ path, named: true }))
  for (const root of targets.roots) {
    for (const entry of walkTree(ctx.fs, root)) {
      if (entry.kind !== 'file') continue
      const below = relativeTo(root === '/' ? '/' : root, entry.path).split('/')
      if (options.hidden || below.every((part) => !part.startsWith('.'))) files.push({ path: entry.path, named: false })
    }
  }
  return files
}

// The first of those files this terminal cannot answer for, named as the
// caller spelled it. A file holding a NUL is binary to ripgrep, which a walk
// passes over and never reads — so what its bytes spell is never asked there,
// while `--text` asks it of every file and a named one was answered for
// above. What is read is refused on two counts: bytes that spell no text,
// which ripgrep searches and prints as the bytes they are, and neither of
// which this terminal can do; and a leading byte-order mark, which ripgrep
// drops before matching, so `^` sits after it where grep matches through it.
function refusedFile(files, options, ctx) {
  for (const { path, named } of files) {
    if (ctx.fs.isDir(path)) continue
    const { text, bytes } = readTextOrBytes(ctx.fs, path)
    // Text with nothing in front of it is text ripgrep reads as this terminal
    // does, and there is nothing to ask of it.
    if (text !== undefined && !text.startsWith('\uFEFF')) continue
    const binary = bytes === undefined ? text.includes('\0') : bytes.includes(0)
    if (binary && !named && !options.text) continue
    const name = JSON.stringify(relativeTo(ctx.cwd === '/' ? '/' : ctx.cwd, path) || path)
    if (text === undefined) {
      const unreadable = unreadableBytes(bytes, name, options, ctx)
      if (unreadable) return unreadable
      continue
    }
    if (text.startsWith('\uFEFF')) return { detail: 'byte-order mark', message: `${name} begins with a byte-order mark, which ripgrep strips before matching` }
  }
  return null
}

// Bytes that spell no text are refused unless a literal that is nowhere in
// them is all that was asked for: ripgrep matches the bytes as they are rather
// than the text they fail to spell, so it prints nothing for them and there is
// nothing to refuse. Only a literal read as written answers — `-i` folds by
// ripgrep's own tables — and `-v` selects the lines a pattern does not, which
// is every line there is.
function unreadableBytes(bytes, name, options, ctx) {
  if (!options.invert && !options.ignoreCase && literalsMissing(bytes, options.patterns, options.literal, ctx.locale)) return null
  return { detail: 'unreadable bytes', message: `${name} holds bytes that are not text, and searching them is not supported` }
}

// Standard input holding a NUL, read as ripgrep reads it, or null.
function stdinWithNul(stdin, options, ctx) {
  const bytes = ctx.stdinBytes ?? (stdin.includes('\0') ? encodeUtf8(stdin) : null)
  return bytes?.includes(0) ? binaryStdin(bytes, options.showName === 'H') : null
}

// Piped bytes are asked the same; what a NUL in them does is answered for
// apart (stdinWithNul).
function refusedStdin(options, ctx) {
  const bytes = ctx.stdinBytes
  if (!bytes || decodeUtf8Maybe(bytes) !== undefined) return null
  return unreadableBytes(bytes, inputLabel(null, ctx), options, ctx)
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

// grep's command line for a run of rg's: the options it has, and the one
// pattern rg's own read to (`regex`, from ./rg-regex.js) or the literals.
function grepArgv(options, regex, targets, operands) {
  const argv = options.literal ? ['-F'] : ['-P']
  if (options.ignoreCase) argv.push('-i')
  if (options.lineNumbers) argv.push('-n')
  if (options.word) argv.push('-w')
  if (options.line) argv.push('-x')
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
  argv.push(...(options.literal ? options.patterns.flatMap((p) => ['-e', p]) : ['-e', regex]))
  if (!targets.stdin) argv.push('--', ...(operands.length ? operands : ['.']))
  return argv
}

// The walked files holding a NUL are read cut where ripgrep stops reading them
// (./rg-binary.js), and what grep printed of them is put the way ripgrep
// prints it.
function runGrep(stdin, options, regex, operands, targets, ctx, cut) {
  const before = new Set(ctx.notes)
  const fs = ctx.fs
  if (cut.size) ctx.fs = cutFs(fs, cut)
  // grep's ordered output is its own wording, which rg rewrites below; the
  // rewritten streams are what rg writes.
  let result
  try { result = search(stdin, grepArgv(options, regex, targets, operands), ctx, RIPGREP) } finally { ctx.fs = fs }
  delete result.events
  relabelNotes(ctx.notes, before, targets)
  if (cut.size && !unsupportedNote(result)) result.stdout = cutOutput(result.stdout, cut, options.mode, (path) => shownName(path, operands, ctx))
  return relabel(listed(countOnly(result, options), options, cut.size > 0), operands, targets)
}

// What grep calls a file a walk found under one of the operands, or `.`.
function shownName(path, operands, ctx) {
  for (const operand of operands.length ? operands : ['.']) {
    const root = lookup(ctx.cwd, operand, ctx.fs).path
    if (root === null || !ctx.fs.isDir(root) || !(root === '/' || path.startsWith(root + '/'))) continue
    const rel = relativeTo(root, path)
    return operand.endsWith('/') ? operand + rel : operand + '/' + rel
  }
  return path
}

// Standard input holding a NUL, which ripgrep reads as ./rg-binary.js says:
// a count, a listing or a status over all of it with every NUL a line end,
// and otherwise the lines selected before the read that brought the first
// NUL, and the line saying the input is binary where anything was selected.
// What context would print around that is not followed. A count and a
// --files-without-match read all of it; anything else stops at a selected
// line — -q and -l at the first, a search printing lines at the first in or
// past the read that brought the NUL — and what it leaves after that is
// uncertain (consumeStdin), however little of it there is, which is no more
// than what the first selected line leaves.
function binaryInput(read, options, regex, ctx) {
  if (options.after || options.before) return gap('binary input with context', 'context around binary standard input is not supported')
  const grep = (text, mode) => {
    const bytes = ctx.stdinBytes
    ctx.stdinBytes = null
    const showName = mode === 'c' ? null : options.showName
    try { return search(text, grepArgv({ ...options, mode, showName, quiet: false }, regex, { stdin: true }, []), ctx, RIPGREP) } finally { ctx.stdinBytes = bytes }
  }
  const counted = grep(read.all, 'c')
  if (unsupportedNote(counted) || counted.exitCode === 2) return relabel(counted, [], { stdin: true })
  const count = Number(counted.stdout)
  const result = { stdout: '', stderr: '', exitCode: count > 0 ? 0 : 1 }
  const label = options.showName === 'H' ? '<stdin>' : null
  // -q answers with the status alone.
  if (!options.quiet && options.mode === 'c') result.stdout = count > 0 ? `${label ? label + ':' : ''}${count}\n` : ''
  else if (!options.quiet && (options.mode === 'l' || options.mode === 'L')) {
    const named = (count > 0) === (options.mode === 'l')
    Object.assign(result, { stdout: named ? '<stdin>\n' : '', exitCode: named ? 0 : 1 })
  } else if (!options.quiet) {
    const printed = read.before ? grep(read.before, null) : { stdout: '', stderr: '', exitCode: 1 }
    if (unsupportedNote(printed)) return relabel(printed, [], { stdin: true })
    result.stdout = relabel(printed, [], { stdin: true }).stdout + (count > 0 ? read.closing : '')
  }
  // Last, since every search above takes standard input again.
  if (count > 0 && (options.quiet || (options.mode !== 'c' && options.mode !== 'L'))) grep(read.all, 'l')
  return result
}

// grep -c reports every file it opened; ripgrep lists only the ones that matched.
function countOnly(result, options) {
  if (options.mode !== 'c') return result
  const kept = result.stdout.split('\n').filter((line) => line !== '' && line !== '0' && !line.endsWith(':0'))
  return rewritten(result, { stdout: kept.length ? kept.join('\n') + '\n' : '' })
}

// ripgrep's status for a count or a --files-without-match is whether it
// printed anything, where grep's is whether it selected a line anywhere; an
// error is an error either way. A binary file a --files-without-match stopped
// in counts as one it answered for, printed or not.
function listed(result, options, binaries) {
  if ((options.mode !== 'c' && options.mode !== 'L') || result.exitCode === 2 || options.quiet) return result
  return rewritten(result, { exitCode: result.stdout === '' && !(options.mode === 'L' && binaries) ? 1 : 0 })
}

// A result with some of its streams replaced, keeping the unsupported note an
// object spread would drop.
function rewritten(result, changes) {
  const out = { ...result, ...changes }
  const note = unsupportedNote(result)
  return note ? markUnsupported(out, note.kind, note.command, note.detail, note.message) : out
}

// ripgrep prints the operating system's error number beside the text.
const ERRNO = new Map([['No such file or directory', 2], ['Not a directory', 20], ['Is a directory', 21]])
const osError = (text) => text.replaceAll(/^(rg: .*: )([A-Z][a-z].*)$/gmu,
  (line, head, reason) => (ERRNO.has(reason) ? `${head}${reason} (os error ${ERRNO.get(reason)})` : line))

// grep names the operand it was given; rg prints the path it walked to, and
// calls standard input `<stdin>`.
function relabel(result, operands, targets) {
  const strip = (text) => (operands.length ? text : text.replaceAll(/^\.\//gmu, ''))
  const stdinLabel = (text) => (targets.stdin || operands.includes('-') ? text.replaceAll(/^\(standard input\)(?=[:-]|$)/gmu, '<stdin>') : text)
  const out = rewritten(result, { stdout: stdinLabel(strip(result.stdout)), stderr: osError(strip(result.stderr).replaceAll(/^grep: /gmu, 'rg: ')) })
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
