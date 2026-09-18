import { parseArgs } from '../args.js'
import { compareNames, creationError, lookup, resolve } from '../fs.js'
import { err, reason } from '../util.js'
import { appendOutput, emptyOutput } from '../shell/output.js'
import { UnsupportedError, unsupportedNote } from '../unsupported.js'
import { quoteName } from './quote-name.js'
import { lookupWithNote, missingPathNote } from '../notes.js'

const SPECIAL_FILES = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr'])

export function cp(_stdin, tokens, ctx) {
  const parsed = parseArgs(tokens, {
    short: ['f', 'n', 'v', 'T', 'r', 'R'], long: ['force', 'no-clobber', 'verbose', 'no-target-directory', 'recursive'],
    valueShort: ['t'], valueLong: ['target-directory'],
  })
  const operands = copyOperands(parsed, ctx)
  if (operands.error) return err('cp: ' + operands.error)
  const { sources, target, directory } = operands
  const { flags } = parsed
  const verbose = flags.has('v') || flags.has('verbose')
  const recursive = flags.has('r') || flags.has('R') || flags.has('recursive')
  const copies = sources.map((source) => [source, directory ? target.replace(/\/+$/u, '') + '/' + lastComponent(source) : target])
  const state = {
    ctx, result: emptyOutput(), failed: false, sources: new Set(), copied: new Set(),
    noClobber: flags.has('n') || flags.has('no-clobber'),
    force: flags.has('f') || flags.has('force'), verbose, recursive,
    outputOverlap: verbose && outputOverlaps(copies, ctx, recursive),
  }
  for (const [source, destination] of copies) {
    // Each copy finishes before the next operand is opened. Ancestor scopes
    // (such as xargs reading its arguments) still guard their own input.
    ctx.io.setReads([])
    try { copyFile(source, destination, state) } catch (e) {
      missingPathNote(ctx, 'cp', e?.path, e?.fsError)
      const note = unsupportedNote(e)
      const message = 'cp: ' + reason(e)
      if (note) {
        ctx.unsupported.add({ ...note, command: note.command ?? 'cp', message })
        appendOutput(state.result, err(message))
        return state.result
      }
      report(state, message + '\n', true)
    }
  }
  state.result.exitCode = state.failed ? 1 : 0
  return state.result
}

function copyOperands({ positional, flags, order }, ctx) {
  const targets = order.filter(({ name }) => name === 't' || name === 'target-directory')
  if (targets.length > 1) return { error: 'multiple target directories specified' }
  const explicit = targets[0]?.value
  const noDirectory = flags.has('T') || flags.has('no-target-directory')
  if (positional.length === 0) return { error: 'missing file operand' }
  if (explicit === undefined && positional.length === 1) return { error: 'missing destination file operand after ' + quoteName(positional[0], ctx) }
  if (explicit !== undefined && noDirectory) return { error: 'cannot combine --target-directory (-t) and --no-target-directory (-T)' }
  if (noDirectory && positional.length > 2) return { error: 'extra operand ' + quoteName(positional[2], ctx) }
  const target = explicit ?? positional.at(-1)
  const found = lookup(ctx.cwd, target, ctx.fs)
  const directory = !noDirectory && ctx.fs.isDir(found.path)
  if (!directory && (explicit !== undefined || positional.length > 2)) {
    missingPathNote(ctx, 'cp', target, found.error)
    return { error: `${explicit === undefined ? 'target' : 'target directory'} ${quoteName(target, ctx)}: ${found.error ?? 'Not a directory'}` }
  }
  return { target, directory, sources: explicit === undefined ? positional.slice(0, -1) : positional }
}

// GNU names a copy after the last component of the source as it was typed,
// rather than after the directory that spelling resolves to: `cp -r a/. d`
// copies what `a` holds into `d` itself, and says so as `'a/./x' -> 'd/./x'`.
// A source ending in `..` is named `.` for the reason cp.c gives: `d/..` would
// put the copy beside the directory it was asked to go in, or anywhere else a
// climb out of it reaches.
const lastComponent = (name) => {
  const last = name.replace(/\/+$/u, '').split('/').at(-1)
  return last === '..' ? '.' : last
}

// `top` names the operands a nested copy came from, which is what GNU's
// into-itself diagnostic reports however deep the loop is found.
function copyFile(source, destination, state, top = null) {
  const { ctx } = state
  if (isSpecialFile(source, ctx.cwd) || isSpecialFile(destination, ctx.cwd)) throw new UnsupportedError('feature', 'special file', 'copying special files is not supported')
  const shownSource = quoteName(source, ctx)
  const shownTarget = quoteName(destination, ctx)
  const found = lookupWithNote(ctx, 'cp', source)
  const fail = (message) => report(state, 'cp: ' + message + '\n', true)
  if (found.error) return fail(`cannot stat ${shownSource}: ${found.error}`)
  if (ctx.fs.isDir(found.path)) {
    if (!state.recursive) return fail(`-r not specified; omitting directory ${shownSource}`)
    return copyDirectory(source, found.path, destination, state, top ?? { source: shownSource, target: shownTarget })
  }
  if (state.sources.has(found.path)) return report(state, `cp: warning: source file ${shownSource} specified more than once\n`, false, true)
  state.sources.add(found.path)
  const dest = lookup(ctx.cwd, destination, ctx.fs)
  if (dest.error && dest.error !== 'No such file or directory') return fail(`cannot stat ${shownTarget}: ${dest.error}`)
  if (state.noClobber && dest.path !== null) return
  if (sameFile(found.path, dest.path, ctx.fs)) return fail(`${shownSource} and ${shownTarget} are the same file`)
  if (ctx.fs.isDir(dest.path)) return fail(`cannot overwrite directory ${shownTarget} with non-directory ${shownSource}`)
  const absolute = resolve(ctx.cwd, destination)
  // Two operands landing on one name is the mistake GNU refuses; two trees
  // merging onto one is what a recursive copy is for, and the second source
  // wins there, so only operands answer to this.
  if (top === null && state.copied.has(absolute)) return fail(`will not overwrite just-created ${shownTarget} with ${shownSource}`)
  const invalid = creationError(ctx.cwd, destination, ctx.fs, dest)
  announce(shownSource, shownTarget, state)
  if (invalid) {
    missingPathNote(ctx, 'cp', destination, invalid)
    return fail(`cannot create regular file ${shownTarget}: ${invalid}`)
  }
  try {
    if (!ctx.fs.copyWritable?.(ctx.cwd, found.path, destination)) {
      return fail(`${state.force && dest.path !== null ? 'cannot remove' : 'cannot create regular file'} ${shownTarget}: Read-only file system`)
    }
  } catch (e) {
    if (unsupportedNote(e)) throw e
    missingPathNote(ctx, 'cp', e?.path, e?.fsError)
    const message = reason(e)
    return fail(`cannot create regular file ${shownTarget}: ${message.startsWith(destination + ': ') ? message.slice(destination.length + 2) : message}`)
  }
  if (top === null) state.copied.add(absolute)
}

// A directory is copied by making the destination and then copying what the
// source held when it was read. An entry that is the destination itself is the
// loop GNU refuses to follow, and refusing it leaves the rest of the tree
// copied, as GNU leaves it.
function copyDirectory(source, absolute, destination, state, top) {
  const { ctx } = state
  // Before a directory is made rather than after, so a copy that cannot be
  // announced leaves nothing of itself behind.
  refuseBufferedOutput(state)
  const shownSource = quoteName(source, ctx)
  const shownTarget = quoteName(destination, ctx)
  const fail = (message) => report(state, 'cp: ' + message + '\n', true)
  const dest = lookup(ctx.cwd, destination, ctx.fs)
  if (dest.error && dest.error !== 'No such file or directory') return fail(`cannot stat ${shownTarget}: ${dest.error}`)
  // A trailing slash says the destination is a directory, which is what this
  // makes: that spelling refuses a file destination, not this one.
  const named = destination.replace(/\/+$/u, '') || destination
  // Whether the destination can be made at all is settled before where it
  // falls: `..` collapses lexically, so a name reaching through a directory
  // that is not there would otherwise read as a loop rather than as the
  // missing component it is.
  if (dest.path === null) {
    const invalid = creationError(ctx.cwd, named, ctx.fs)
    if (invalid) {
      missingPathNote(ctx, 'cp', named, invalid)
      return fail(`cannot create directory ${shownTarget}: ${invalid}`)
    }
  }
  const target = resolve(ctx.cwd, named)
  if (target === absolute) return fail(`${shownSource} and ${shownTarget} are the same file`)
  // A destination under the source is the loop GNU names. GNU makes the
  // directory, copies what it read before reaching it, and only then refuses;
  // what that leaves behind follows the order the host read the directory in,
  // which a tree sorted for determinism cannot reproduce. So the refusal comes
  // first here, rather than a half-made copy that is neither GNU's nor asked
  // for. The diagnostic and the status are GNU's.
  if (target.startsWith(absolute === '/' ? '/' : absolute + '/')) {
    return fail(`cannot copy a directory, ${top.source}, into itself, ${top.target}`)
  }
  if (dest.path !== null && !ctx.fs.isDir(dest.path)) return fail(`cannot overwrite non-directory ${shownTarget} with directory ${shownSource}`)
  // GNU keeps the sources it has copied, and names a directory as a directory.
  if (state.sources.has(absolute)) return report(state, `cp: warning: source directory ${shownSource} specified more than once\n`, false, true)
  state.sources.add(absolute)
  const { dirs, files } = ctx.fs.listDir(absolute)
  if (dest.path === null && !makeDirectory(source, destination, named, state)) return
  const from = source.replace(/\/+$/u, ''), into = destination.replace(/\/+$/u, '')
  for (const name of [...dirs, ...files].sort(compareNames)) {
    // Each entry finishes before the next is opened, as each operand does.
    ctx.io.setReads([])
    copyFile(`${from}/${name}`, `${into}/${name}`, state, top)
  }
}

function makeDirectory(source, destination, named, state) {
  const { ctx } = state
  const shownTarget = quoteName(destination, ctx)
  const fail = (message) => {
    report(state, 'cp: cannot create directory ' + shownTarget + ': ' + message + '\n', true)
    return false
  }
  try {
    if (!ctx.fs.makeWritableDir?.(ctx.cwd, named)) return fail('Read-only file system')
  } catch (e) {
    if (unsupportedNote(e)) throw e
    missingPathNote(ctx, 'cp', e?.path, e?.fsError)
    const message = reason(e)
    return fail(message.startsWith(named + ': ') ? message.slice(named.length + 2) : message)
  }
  // GNU announces a directory it makes, and says nothing of one already there.
  announce(quoteName(source, ctx), shownTarget, state)
  return true
}

// Verbose output is GNU's to buffer, so where its descriptor is a file this
// copy also reads or writes, what a caller reads back depends on when that
// buffer was flushed. Nothing is said before the refusal, since the line would
// be the very thing in question.
function announce(source, target, state) {
  if (!state.verbose) return
  refuseBufferedOutput(state)
  report(state, `${source} -> ${target}\n`)
}

function refuseBufferedOutput(state) {
  if (state.outputOverlap) throw new UnsupportedError('feature', 'copy output buffering', 'buffered verbose output sharing a copied file is not supported')
}

function sameFile(source, destination, fs) {
  if (source === destination) return true
  const identity = fs.fileIdentity?.(source)
  return identity !== undefined && identity === fs.fileIdentity(destination)
}

// GNU buffers verbose stdout; buffer fills and error() flushes can change
// a later copy when that descriptor points to a source or destination.
function outputOverlaps(copies, ctx, recursive) {
  const output = ctx.outputFds[1]
  if (typeof output !== 'object') return false
  return copies.some((paths) => paths.some((name) => {
    const found = lookup(ctx.cwd, name, ctx.fs)
    if (found.error) return false
    // A recursive copy reads and writes every name below these two, so a
    // descriptor anywhere under one of them is the same overlap a named file is.
    if (ctx.fs.isDir(found.path)) {
      return recursive && typeof output.path === 'string' && output.path.startsWith(found.path === '/' ? '/' : found.path + '/')
    }
    return output.identity === undefined ? output.path === found.path : output.identity === ctx.fs.fileIdentity?.(found.path)
  }))
}

function isSpecialFile(name, cwd) {
  const path = name.startsWith('/') ? name : cwd + '/' + name
  return SPECIAL_FILES.has(path.replace(/\/\.(?=\/)/gu, '').replace(/\/+/gu, '/'))
}

function report(state, text, failed = false, warning = false) {
  const event = failed || warning ? emptyOutput(text) : { ...emptyOutput(), stdout: text, events: [{ fd: 1, text }] }
  appendOutput(state.result, state.ctx.flushOutput(event))
  state.failed ||= failed
}
