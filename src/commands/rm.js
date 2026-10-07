import { parseArgs } from '../args.js'
import { compareNames, joinPath, lookup, nameTooLong, pathTooLong } from '../fs.js'
import { err, ok, reason, stdinIsTerminal } from '../util.js'
import { unsupportedFrom, unsupportedNote } from '../unsupported.js'
import { quoteName } from './quote-name.js'
import { missingPathNote } from '../notes.js'
import { inOverlay, writeRefusal } from '../writable.js'

export function rm(_stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['f', 'v', 'r', 'R'], long: ['force', 'verbose', 'recursive'] })
  const force = flags.has('f') || flags.has('force')
  const verbose = flags.has('v') || flags.has('verbose')
  const recursive = flags.has('r') || flags.has('R') || flags.has('recursive')
  if (positional.length === 0) return force ? ok('') : err("rm: missing operand\nTry 'rm --help' for more information.")
  // Where stdin is a terminal and -f was not given, GNU asks before it takes
  // anything away (see asked, below).
  const state = { ctx, force, verbose, recursive, asking: !force && stdinIsTerminal(ctx), events: [], stdout: '', stderr: '', failed: false }
  try {
    for (const name of positional) removeOperand(name, state)
  } catch (e) {
    missingPathNote(ctx, 'rm', e?.path, e?.fsError)
    const result = unsupportedFrom(e, 'rm', 'rm: ' + reason(e))
    result.events = [...state.events, { fd: 2, text: result.stderr }]
    result.stdout = state.stdout
    result.stderr = state.stderr + result.stderr
    return result
  }
  return { stdout: state.stdout, stderr: state.stderr, events: state.events, exitCode: state.failed ? 1 : 0 }
}

const MISSING = 'No such file or directory'

function removeOperand(name, state) {
  const { ctx } = state
  // `rm` unlinks the name it is given: a link is taken away itself, and never
  // resolved to the file it points at — unless a trailing slash asks for the
  // directory it leads to, as lstat reads that spelling too.
  const found = lookup(ctx.cwd, name, ctx.fs, { follow: false })
  if (found.error) {
    // What lstat could not find, GNU tries to unlink all the same, and says
    // what that failed with — unless it asked first, which it does with a
    // terminal on stdin, and says what lstat failed with instead; -f ignores
    // a name that is not there and one under something that is not a
    // directory, neither naming a file.
    const error = state.asking ? found.error : unlinkError(ctx, name, found.error)
    if (state.force && (error === MISSING || error === 'Not a directory')) return
    missingPathNote(ctx, 'rm', name, error)
    return report(state, `rm: cannot remove ${quoteName(name, ctx)}: ${error}\n`)
  }
  if (!ctx.fs.isDir(found.path)) return removeEntry(name, ctx.cwd, name, found.path, state, false)
  if (!state.recursive) return report(state, `rm: cannot remove ${quoteName(name, ctx)}: Is a directory\n`)
  // `rm -r .` would name the directory a caller is standing in by a name
  // that says nothing about which one it is, so GNU passes over it.
  if (['.', '..'].includes(name.replace(/\/+$/u, '').split('/').at(-1))) {
    return report(state, `rm: refusing to remove '.' or '..' directory: skipping ${quoteName(name, ctx)}\n`)
  }
  // --preserve-root, which is GNU's default: whatever spelling leads to `/`
  // is refused before anything below it is touched.
  if (found.path === '/') {
    const same = name === '/' ? '' : ` (same as ${quoteName('/', ctx)})`
    return report(state, `rm: it is dangerous to operate recursively on ${quoteName(name, ctx)}${same}\nrm: use --no-preserve-root to override this failsafe\n`)
  }
  // A trailing slash walks into what a link names and leaves the name the
  // link it is: GNU empties that directory and then cannot remove the name
  // it was given, which is not the directory the name led to.
  removeTree(name, ctx.cwd, name, found.path, state, crossedLink(ctx, name))
}

// What unlink(2) says of a name lstat could not find. The way to the
// directory it is in fails as it failed lstat; a read-only mount refuses
// before anything in it is looked up, where GNU asks lstat again and reports
// a name that is not there as missing rather than as read-only; and then the
// name is looked up, where a trailing slash asks a link, as anything else,
// to be a directory.
function unlinkError(ctx, name, error) {
  if (name === '' || pathTooLong(name)) return error
  const { parent, last } = parentOf(ctx, ctx.cwd, name)
  if (parent.error) return parent.error
  const at = joinPath(parent.path, last)
  if (!ctx.writable || !inOverlay(at)) {
    const refusal = writeRefusal(ctx, parent.path)
    if (refusal === 'Read-only file system') return error === MISSING ? MISSING : refusal
  }
  if (nameTooLong(last)) return 'File name too long'
  if (!ctx.fs.isDir(at) && !ctx.fs.isFile(at) && !ctx.fs.isLink?.(at)) return MISSING
  return ctx.fs.isDir(at) ? 'Is a directory' : 'Not a directory'
}

// The directory a name is in, as the kernel walks the way to it before it
// looks the last component up there, and that component.
function parentOf(ctx, from, name) {
  const bare = name.replace(/\/+$/u, '')
  const cut = bare.lastIndexOf('/') + 1
  const parent = cut === 0 ? { path: from, error: null } : lookup(from, bare.slice(0, cut), ctx.fs)
  return { parent, last: bare.slice(cut) }
}

// Whether the walk reached a directory only by the operand's trailing slash,
// where the name itself is a link — which is what `rm` would have to unlink.
function crossedLink(ctx, name) {
  const bare = name.replace(/\/+$/u, '')
  if (bare === name || bare === '') return false
  return ctx.fs.isLink?.(lookup(ctx.cwd, bare, ctx.fs, { follow: false }).path) === true
}

// Depth first, as `rm` empties a directory before removing it, and in sorted
// order, which is the order everything else here walks a tree in. Each entry
// is removed from the directory it is in, as GNU's unlinkat removes it, and
// is named as the operand spelled the way to it. An entry that cannot be
// removed is reported on its own, and leaves every directory above it in
// place without a word: GNU does not try to remove a directory it has
// already failed to empty. Whether this one could be emptied is the answer.
function removeTree(shown, from, name, absolute, state, crossed = false) {
  const { ctx } = state
  const { dirs, files, links = [] } = ctx.fs.listDir(absolute)
  // GNU asks before it goes into a directory, and about an empty one where it
  // would take it away.
  if (dirs.length + files.length + links.length > 0 && !asked(shown, absolute, 'descend into', state)) return false
  const base = shown.replace(/\/+$/u, '')
  let emptied = true
  for (const child of [...dirs, ...files, ...links].sort(compareNames)) {
    const path = joinPath(absolute, child)
    const removed = ctx.fs.isDir(path)
      ? removeTree(`${base}/${child}`, absolute, child, path, state)
      : removeEntry(`${base}/${child}`, absolute, child, path, state, false)
    emptied &&= removed
  }
  if (!emptied) return false
  return removeEntry(shown, from, name, absolute, state, true, crossed)
}

// Removes `name` from the directory `from`, reporting it as `shown`, once
// `path`, where it is, has been asked about; whether it is gone is the
// answer. Outside the overlay the directory it is in says why not: a
// read-only mount, or the root filesystem's own. A directory reached only
// through a link the operand spelled with a trailing slash is not what that
// name is, and rmdir says so.
function removeEntry(shown, from, name, path, state, directory, crossed = false) {
  const { ctx } = state
  // The name is quoted only where it is printed, and before anything is
  // removed where it will be: a name `-v` cannot announce stays where it is.
  const quoted = state.verbose ? quoteName(shown, ctx) : null
  if (!asked(shown, path, 'remove', state)) return false
  let error = null
  try {
    const { parent, last } = parentOf(ctx, from, name)
    const where = parent.path
    const remove = directory ? ctx.fs.removeWritableDir : ctx.fs.removeWritable
    if (parent.error) error = parent.error
    else if (!ctx.writable || !inOverlay(joinPath(where, last))) error = writeRefusal(ctx, where)
    else if (crossed) error = 'Not a directory'
    else if (!remove?.(from, name)) error = writeRefusal(ctx, where)
  } catch (e) {
    // A name is looked up again when it is removed, and a walk can take the
    // components of its own name away first: `rm -r b/sub/../../b` empties
    // `sub` before it reaches `b`, and GNU cannot find `b` either by then.
    // That is this operand's failure to report, not the whole command's.
    if (unsupportedNote(e)) throw e
    missingPathNote(ctx, 'rm', e?.path, e?.fsError)
    const message = reason(e)
    error = e?.fsError ?? (message.startsWith(name + ': ') ? message.slice(name.length + 2) : message)
  }
  if (error) {
    report(state, `rm: cannot remove ${quoted ?? quoteName(shown, ctx)}: ${error}\n`)
    return false
  }
  if (state.verbose) report(state, `removed ${directory ? 'directory ' : ''}${quoted}\n`, 1)
  return true
}

function report(state, text, fd = 2, failed = fd === 2) {
  if (fd === 1) state.stdout += text
  else state.stderr += text
  state.events.push({ fd, text })
  state.failed ||= failed
}

// GNU's prompt(), where stdin is a terminal and -f was not given: before it
// goes into a directory or takes a name away, it asks whether its owner may
// write it. A name the owner may not write it asks the user about — which a
// terminal with nothing typed on it answers no, so the name is left where it
// is, and that is no failure — and a name access(2) cannot answer for, which
// a read-only mount answers with EROFS, is the failure to remove it, said
// there and then: a directory is not gone into at all. A link is never asked
// about. Whether to go on is the answer.
function asked(shown, path, doing, state) {
  if (!state.asking) return true
  const { ctx } = state
  const answer = writeProtected(ctx, path)
  if (answer === false) return true
  if (answer !== true) {
    report(state, `rm: cannot remove ${quoteName(shown, ctx)}: ${answer}\n`)
    return false
  }
  const what = doing === 'descend into' || ctx.fs.isDir(path) ? 'directory' : ctx.fs.fileSize(path) === 0 ? 'regular empty file' : 'regular file'
  report(state, `rm: ${doing} write-protected ${what} ${quoteName(shown, ctx)}? `, 2, false)
  return false
}

// GNU's write_protected_non_symlink: whether the owner may not write `path`
// — true where a mode it keeps says so, or where it is the root
// filesystem's, which is root's own (EACCES) — or why access(2) cannot say,
// which is EROFS on the read-only mount.
function writeProtected(ctx, path) {
  if (ctx.fs.isLink?.(path)) return false
  if (ctx.writable && inOverlay(path)) {
    const mode = ctx.fs.metadataOf?.(path)?.mode
    return mode !== undefined && (mode & 0o200) === 0
  }
  const refusal = writeRefusal(ctx, path)
  return refusal === 'Permission denied' || refusal
}
