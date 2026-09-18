import { parseArgs } from '../args.js'
import { compareNames, joinPath, lookup } from '../fs.js'
import { err, ok, reason } from '../util.js'
import { unsupportedFrom, unsupportedNote } from '../unsupported.js'
import { quoteName } from './quote-name.js'
import { missingPathNote } from '../notes.js'

export function rm(_stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['f', 'v', 'r', 'R'], long: ['force', 'verbose', 'recursive'] })
  const force = flags.has('f') || flags.has('force')
  const verbose = flags.has('v') || flags.has('verbose')
  const recursive = flags.has('r') || flags.has('R') || flags.has('recursive')
  if (positional.length === 0) return force ? ok('') : err('rm: missing operand')
  const state = { ctx, force, verbose, recursive, events: [], stdout: '', stderr: '' }
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
  return { stdout: state.stdout, stderr: state.stderr, events: state.events, exitCode: state.stderr ? 1 : 0 }
}

function removeOperand(name, state) {
  const { ctx } = state
  const found = lookup(ctx.cwd, name, ctx.fs)
  let error = found.error
  // GNU -f ignores ENOTDIR as well as ENOENT: neither names an existing file.
  if (state.force && (error === 'No such file or directory' || error === 'Not a directory')) return
  missingPathNote(ctx, 'rm', name, error)
  if (error === null && ctx.fs.isDir(found.path)) {
    if (!state.recursive) error = 'Is a directory'
    // `rm -r .` would name the directory a caller is standing in by a name
    // that says nothing about which one it is, so GNU passes over it.
    else if (['.', '..'].includes(name.replace(/\/+$/u, '').split('/').at(-1))) {
      return report(state, `rm: refusing to remove '.' or '..' directory: skipping ${quoteName(name, ctx)}\n`)
    }
    // Everything a removal touches has to be the overlay's, and the overlay's
    // own root is not the tree below it: refuse before walking, rather than
    // empty a directory and then fail to remove it.
    else if (found.path === '/tmp') error = 'Device or resource busy'
    else if (!ctx.writable || !found.path.startsWith('/tmp/')) error = 'Read-only file system'
    else return removeTree(name, found.path, state)
  }
  removeEntry(name, found.path, state, false, error)
}

// Depth first, as `rm` empties a directory before removing it, and in sorted
// order, which is the order everything else here walks a tree in.
function removeTree(name, absolute, state) {
  const { ctx } = state
  const { dirs, files } = ctx.fs.listDir(absolute)
  const base = name.replace(/\/+$/u, '')
  for (const child of [...dirs, ...files].sort(compareNames)) {
    const path = joinPath(absolute, child)
    if (ctx.fs.isDir(path)) removeTree(`${base}/${child}`, path, state)
    else removeEntry(`${base}/${child}`, path, state, false, null)
  }
  removeEntry(name, absolute, state, true, null)
}

function removeEntry(name, path, state, directory, error) {
  const { ctx } = state
  const shown = state.verbose || error !== null || !ctx.writable || !path?.startsWith('/tmp/') ? quoteName(name, ctx) : ''
  const remove = () => directory ? ctx.fs.removeWritableDir?.(ctx.cwd, name) : ctx.fs.removeWritable?.(ctx.cwd, name)
  try {
    if (error === null && !remove()) error = 'Read-only file system'
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
  if (error) return report(state, `rm: cannot remove ${shown}: ${error}\n`)
  if (state.verbose) report(state, `removed ${directory ? 'directory ' : ''}${shown}\n`, 1)
}

function report(state, text, fd = 2) {
  if (fd === 1) state.stdout += text
  else state.stderr += text
  state.events.push({ fd, text })
}
