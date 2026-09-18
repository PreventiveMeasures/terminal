import { parseArgs } from '../args.js'
import { creationError, lookup } from '../fs.js'
import { err, reason } from '../util.js'
import { unsupportedFrom, unsupportedNote } from '../unsupported.js'
import { quoteName } from './quote-name.js'
import { missingPathNote } from '../notes.js'

// Directories in the writable overlay, which `cp -r` made the first of. There
// are no permissions here, so `-m` and the modes it takes are refused like any
// other option this terminal has nothing to answer with.
export function mkdir(_stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['p', 'v'], long: ['parents', 'verbose'] })
  if (positional.length === 0) return err('mkdir: missing operand')
  const state = {
    ctx, events: [], stdout: '', stderr: '',
    parents: flags.has('p') || flags.has('parents'),
    verbose: flags.has('v') || flags.has('verbose'),
  }
  try {
    for (const name of positional) {
      if (state.parents) makeParents(name, state)
      else makeDirectory(name, state, true)
    }
  } catch (e) {
    missingPathNote(ctx, 'mkdir', e?.path, e?.fsError)
    const result = unsupportedFrom(e, 'mkdir', 'mkdir: ' + reason(e))
    result.events = [...state.events, { fd: 2, text: result.stderr }]
    result.stdout = state.stdout
    result.stderr = state.stderr + result.stderr
    return result
  }
  return { stdout: state.stdout, stderr: state.stderr, events: state.events, exitCode: state.stderr ? 1 : 0 }
}

// `-p` makes each component of the name in turn, passing over the ones already
// there and stopping at the first it cannot make. GNU announces each one as the
// prefix it is, and the last one as the operand was typed.
function makeParents(name, state) {
  const parts = name.split('/')
  const prefixes = []
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== '') prefixes.push(parts.slice(0, i + 1).join('/'))
  }
  // Slashes alone name the root, which is there already; an empty operand
  // names nothing at all, and GNU says so rather than passing over it — a
  // silent success would let `mkdir -p "$dir" && …` run on a name it never got.
  if (prefixes.length === 0) {
    if (name === '') makeDirectory(name, state, true)
    return
  }
  prefixes[prefixes.length - 1] = name
  for (const [index, prefix] of prefixes.entries()) {
    if (!makeDirectory(prefix, state, index === prefixes.length - 1)) return
  }
}

function makeDirectory(name, state, last) {
  const { ctx } = state
  const shown = quoteName(name, ctx)
  const fail = (message) => {
    report(state, `mkdir: cannot create directory ${shown}: ${message}\n`)
    return false
  }
  // A trailing slash says the name is a directory, which is what this makes.
  const target = name.replace(/\/+$/u, '') || name
  const found = lookup(ctx.cwd, target, ctx.fs)
  if (found.error === null) {
    // An existing directory is what `-p` was asking for; anything else in the
    // way of the name is not, and a component that is not a directory cannot
    // hold the one below it.
    if (!state.parents) return fail('File exists')
    return ctx.fs.isDir(found.path) ? true : fail(last ? 'File exists' : 'Not a directory')
  }
  const invalid = creationError(ctx.cwd, target, ctx.fs, found)
  if (invalid) {
    missingPathNote(ctx, 'mkdir', target, invalid)
    return fail(invalid)
  }
  try {
    if (!ctx.fs.makeWritableDir?.(ctx.cwd, target)) return fail('Read-only file system')
  } catch (e) {
    if (unsupportedNote(e)) throw e
    missingPathNote(ctx, 'mkdir', e?.path, e?.fsError)
    const message = reason(e)
    return fail(message.startsWith(target + ': ') ? message.slice(target.length + 2) : message)
  }
  if (state.verbose) report(state, `mkdir: created directory ${shown}\n`, 1)
  return true
}

function report(state, text, fd = 2) {
  if (fd === 1) state.stdout += text
  else state.stderr += text
  state.events.push({ fd, text })
}
