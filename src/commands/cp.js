import { parseArgs } from '../args.js'
import { basename, lookup, resolve } from '../fs.js'
import { err, reason } from '../util.js'
import { appendOutput, emptyOutput } from '../shell/output.js'
import { UnsupportedError, unsupportedNote } from '../unsupported.js'
import { quoteName } from './quote-name.js'

const SPECIAL_FILES = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr'])

export function cp(_stdin, tokens, ctx) {
  const parsed = parseArgs(tokens, {
    short: ['f', 'n', 'v', 'T'], long: ['force', 'no-clobber', 'verbose', 'no-target-directory'],
    valueShort: ['t'], valueLong: ['target-directory'],
  })
  const operands = copyOperands(parsed, ctx)
  if (operands.error) return err('cp: ' + operands.error)
  const { sources, target, directory } = operands
  const { flags } = parsed
  const verbose = flags.has('v') || flags.has('verbose')
  const copies = sources.map((source) => [source, directory ? target.replace(/\/+$/u, '') + '/' + basename(source) : target])
  const state = {
    ctx, result: emptyOutput(), failed: false, sources: new Set(), copied: new Set(),
    noClobber: flags.has('n') || flags.has('no-clobber'),
    force: flags.has('f') || flags.has('force'), verbose,
    outputOverlap: verbose && outputOverlaps(copies, ctx),
  }
  for (const [source, destination] of copies) {
    // Each copy finishes before the next operand is opened. Ancestor scopes
    // (such as xargs reading its arguments) still guard their own input.
    ctx.io.setReads([])
    try { copyFile(source, destination, state) } catch (e) {
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
  if (explicit !== undefined && !directory) return { error: `target directory ${quoteName(target, ctx)}: ${found.error ?? 'Not a directory'}` }
  if (explicit === undefined && positional.length > 2 && !directory) return { error: `target ${quoteName(target, ctx)}: ${found.error ?? 'Not a directory'}` }
  return { target, directory, sources: explicit === undefined ? positional.slice(0, -1) : positional }
}

function copyFile(source, destination, state) {
  const { ctx } = state
  if (isSpecialFile(source, ctx.cwd) || isSpecialFile(destination, ctx.cwd)) throw new UnsupportedError('feature', 'special file', 'copying special files is not supported')
  const shownSource = quoteName(source, ctx)
  const shownTarget = quoteName(destination, ctx)
  const found = lookup(ctx.cwd, source, ctx.fs)
  const fail = (message) => report(state, 'cp: ' + message + '\n', true)
  if (found.error) return fail(`cannot stat ${shownSource}: ${found.error}`)
  if (ctx.fs.isDir(found.path)) return fail(`-r not specified; omitting directory ${shownSource}`)
  if (state.sources.has(found.path)) return report(state, `cp: warning: source file ${shownSource} specified more than once\n`, false, true)
  state.sources.add(found.path)
  const dest = lookup(ctx.cwd, destination, ctx.fs)
  if (dest.error && dest.error !== 'No such file or directory') return fail(`cannot stat ${shownTarget}: ${dest.error}`)
  if (state.noClobber && dest.path !== null) return
  if (sameFile(found.path, dest.path, ctx.fs)) return fail(`${shownSource} and ${shownTarget} are the same file`)
  if (ctx.fs.isDir(dest.path)) return fail(`cannot overwrite directory ${shownTarget} with non-directory ${shownSource}`)
  const absolute = resolve(ctx.cwd, destination)
  if (state.copied.has(absolute)) return fail(`will not overwrite just-created ${shownTarget} with ${shownSource}`)
  const invalid = targetError(destination, dest, ctx)
  if (state.verbose) {
    if (state.outputOverlap) throw new UnsupportedError('feature', 'copy output buffering', 'buffered verbose output sharing a copied file is not supported')
    report(state, `${shownSource} -> ${shownTarget}\n`)
  }
  if (invalid) return fail(`cannot create regular file ${shownTarget}: ${invalid}`)
  try {
    if (!ctx.fs.copyWritable?.(ctx.cwd, found.path, destination)) {
      return fail(`${state.force && dest.path !== null ? 'cannot remove' : 'cannot create regular file'} ${shownTarget}: Read-only file system`)
    }
  } catch (e) {
    if (unsupportedNote(e)) throw e
    const message = reason(e)
    return fail(`cannot create regular file ${shownTarget}: ${message.startsWith(destination + ': ') ? message.slice(destination.length + 2) : message}`)
  }
  state.copied.add(absolute)
}

function sameFile(source, destination, fs) {
  if (source === destination) return true
  const identity = fs.fileIdentity?.(source)
  return identity !== undefined && identity === fs.fileIdentity(destination)
}

// GNU buffers verbose stdout; buffer fills and error() flushes can change
// a later copy when that descriptor points to a source or destination.
function outputOverlaps(copies, ctx) {
  const output = ctx.outputFds[1]
  if (typeof output !== 'object') return false
  return copies.some((paths) => paths.some((name) => {
    const found = lookup(ctx.cwd, name, ctx.fs)
    if (found.error || ctx.fs.isDir(found.path)) return false
    return output.identity === undefined ? output.path === found.path : output.identity === ctx.fs.fileIdentity?.(found.path)
  }))
}

function isSpecialFile(name, cwd) {
  const path = name.startsWith('/') ? name : cwd + '/' + name
  return SPECIAL_FILES.has(path.replace(/\/\.(?=\/)/gu, '').replace(/\/+/gu, '/'))
}

function targetError(name, found, ctx) {
  if (found.path !== null) return null
  if (name === '' || name.includes('\0') || name.endsWith('/') || found.error !== 'No such file or directory') return found.error
  const slash = name.lastIndexOf('/')
  const parent = lookup(ctx.cwd, slash < 0 ? '.' : name.slice(0, slash) || '/', ctx.fs)
  return parent.error ?? (ctx.fs.isDir(parent.path) ? null : 'Not a directory')
}

function report(state, text, failed = false, warning = false) {
  const event = failed || warning ? emptyOutput(text) : { ...emptyOutput(), stdout: text, events: [{ fd: 1, text }] }
  appendOutput(state.result, state.ctx.flushOutput(event))
  state.failed ||= failed
}
