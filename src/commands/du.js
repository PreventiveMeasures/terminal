import { compareNames, joinPath } from '../fs.js'
import { lookupWithNote } from '../notes.js'
import { appendOutput, emptyOutput } from '../shell/output.js'
import { err, reason } from '../util.js'
import { UnsupportedError, unsupported, unsupportedNote } from '../unsupported.js'
import { quoteName } from './quote-name.js'
import { duOptions, duSize } from './du-options.js'

export function du(_stdin, tokens, ctx) {
  const options = duOptions(tokens, ctx)
  if (!options.flags.has('A') && !options.flags.has('inodes')) {
    return unsupported('feature', 'du', 'allocated disk size', 'du: allocated disk sizes are not available')
  }
  const state = { ctx, options, seen: new Set(), result: emptyOutput(), total: 0n, failed: false }
  if (options.stderr) appendOutput(state.result, ctx.flushOutput(emptyOutput(options.stderr)))
  for (const operand of options.operands) {
    const name = operand.length > 2 ? operand.replace(/\/+$/u, '/') : operand
    // du measures the names it is given, as `-P` has it by default; `-D` (or
    // `-H`) and `-L` each ask about what an operand points at instead.
    const found = lookupWithNote(ctx, 'du', name, { follow: options.links !== 'none' })
    if (found.error) {
      appendOutput(state.result, ctx.flushOutput(err(`du: cannot access ${quoteName(name, ctx)}: ${found.error}`)))
      state.failed = true
      continue
    }
    try { measure(found.path, name, state) } catch (e) {
      const note = unsupportedNote(e)
      const message = 'du: ' + reason(e)
      if (note) ctx.unsupported.add({ ...note, command: note.command ?? 'du', message })
      appendOutput(state.result, ctx.flushOutput(err(message)))
      state.failed = true
      if (note) return state.result
    }
  }
  if (options.flags.has('c')) printSize(state.total, 'total', state)
  state.result.exitCode = state.failed ? 1 : 0
  return state.result
}

function measure(path, name, state) {
  const { ctx, options } = state
  // Output inside the measured tree makes totals depend on traversal order
  // and on when a directory walker collects each file's metadata.
  if (!options.flags.has('inodes') && ctx.fs.isDir(path) && Object.values(ctx.outputFds ?? {}).some((fd) =>
    typeof fd === 'object' && fd.path?.startsWith(path === '/' ? '/' : path + '/'))) {
    throw new UnsupportedError('feature', 'recursive metadata output overlap', 'output within a measured directory is not supported')
  }
  const stack = [{ path, name, depth: 0 }]
  while (stack.length) {
    const item = stack.pop()
    if (item.total !== undefined) {
      if (item.depth <= options.depth) printSize(item.total, item.name, state)
      if (item.parent && !options.flags.has('S')) item.parent.total += item.total
      continue
    }
    const isDir = ctx.fs.isDir(item.path)
    if (isDir && ctx.fs.isFile(item.path)) throw new UnsupportedError('feature', 'ambiguous file type', `path is both a file and a directory: ${item.name}`)
    // A walk measures the links it finds, which is what du does without `-L`.
    // What `-L` would measure instead — the tree each one leads to, and the
    // cycle a link above itself makes of that walk — is not modelled.
    if (!isDir && options.links === 'all' && ctx.fs.isLink?.(item.path)) {
      throw new UnsupportedError('option', 'dereference', `following symbolic links is not supported: ${item.name}`)
    }
    const identity = isDir ? item.path : ctx.fs.fileIdentity?.(item.path) ?? item.path
    if (!options.flags.has('l') && state.seen.has(identity)) continue
    state.seen.add(identity)
    const own = options.flags.has('inodes') ? 1n : isDir ? 0n : BigInt(ctx.fs.fileSize(item.path))
    state.total += own
    if (isDir) {
      item.total = own
      stack.push(item)
      const entries = ctx.fs.listDir(item.path)
      const children = [...new Set([...entries.dirs, ...entries.files, ...entries.links])].sort(compareNames)
      const prefix = item.name.endsWith('/') ? item.name : item.name + '/'
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ path: joinPath(item.path, children[i]), name: prefix + children[i], depth: item.depth + 1, parent: item })
      }
    } else {
      if (item.parent) item.parent.total += own
      if (item.depth === 0 || options.flags.has('a') && item.depth <= options.depth) printSize(own, item.name, state)
    }
  }
}

function printSize(size, name, state) {
  const stdout = `${duSize(size, state.options.scale)}\t${name}${state.options.flags.has('0') ? '\0' : '\n'}`
  appendOutput(state.result, state.ctx.flushOutput({ ...emptyOutput(), stdout, events: [{ fd: 1, text: stdout }] }))
}
