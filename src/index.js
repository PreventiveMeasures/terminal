// In-memory shell over a { path: content } source tree; no host I/O.
// cwd and variables persist across run() calls. Unsupported constructs also
// reach a diagnostic feed that redirects and pipelines cannot suppress.
// Informational notes share that scope without changing the command's streams.
// Caller-provided command handlers use the contract in custom.js.

import { forkSettings, mountSources } from './mount.js'
import { parseUnits } from './shell/parse.js'
import { DEFAULT_REGISTRY, createRegistry, unknownCommand } from './registry.js'
import { createUnsupportedFeed, unsupported, unsupportedNote } from './unsupported.js'
import { discardedNotes, err, missingPathNote, reason } from './util.js'
import { complete } from './complete.js'
import { reading } from './reading.js'
import { commandSubstitution } from './shell/capture.js'
import { BindingMap, isolated, withState } from './shell/state.js'
import { commandWriteError, createIoGuard, routeExternalOutput, runSteps } from './shell/run.js'

export function createTerminal(sources, opts = {}) {
  const { fs, cwd, home, mount, writable } = mountSources(sources, opts)
  const registry = opts.commands === undefined ? DEFAULT_REGISTRY : createRegistry(opts.commands)
  // The I/O guard watches one filesystem's reads and writes, and the writable
  // overlay it observes holds a single observer, so the guard belongs to the
  // filesystem rather than to a terminal: a fork over the same tree shares it.
  const shared = { fs, io: createIoGuard(fs), mount, writable, registry }
  return terminal(context(shared, { cwd, home, user: opts.user ?? 'user', vars: new BindingMap(), functions: new Map(), lastExit: 0 }), 'createTerminal')
}

// A fork is the process fork rather than a second terminal over the same
// sources: the filesystem, the /tmp/ overlay, and the wired commands stay the
// parent's, while the working directory, the variables, the functions, and the
// last exit status are copies taken now. Afterwards neither side's cd,
// assignment, or unset is visible to the other, and only what they write in
// /tmp/ passes between them — as it does between two processes sharing a disk.
function fork(parent, opts = {}) {
  const { cwd, home, user } = forkSettings(parent, opts)
  const state = { cwd, home, user, vars: new BindingMap(parent.vars), functions: new Map(parent.functions), lastExit: parent.lastExit }
  return terminal(context(parent, state), 'fork')
}

// Stdin position, open descriptors and the two diagnostic feeds belong to
// whoever is running a line, so every terminal starts with a set of its own.
// stdinLeft tracks consumption within a command list; stdinOrigin allows
// /dev/stdin to reopen a redirected file independently of that offset.
function context({ fs, io, mount, writable, registry }, session) {
  const ctx = {
    fs, io, mount, writable, registry, ...session, calling: new Set(), outputFds: { 1: 'out', 2: 'err' },
    loopDepth: 0, closed: { out: false, err: false }, stdinFile: false, stdinPiped: false, stdinOrigin: null, stdinHandle: null, stdinLeft: '',
    unsupported: createUnsupportedFeed(), notes: new Set(),
  }
  // find -exec and xargs dispatch externally in isolated shell state.
  ctx.dispatch = (name, tokens, stdin) => withState(ctx, { stdinLeft: ctx.stdinLeft, stdinFile: false, stdinPiped: false, stdinOrigin: null, stdinHandle: null },
    () => isolated(ctx, () => dispatch(name, tokens, stdin, ctx, true)))
  ctx.flushOutput = (result) => routeExternalOutput(result, ctx)
  ctx.hasCommand = (name) => registry.has(name) && !registry.shellOnly(name)
  ctx.invoke = (name, tokens, stdin) => dispatch(name, tokens, stdin, ctx)
  ctx.substitute = (command, backtick) => commandSubstitution(command, ctx, runSteps, backtick)
  return ctx
}

// The public surface, and the check both entry points share: a working
// directory that does not exist is the caller's mistake either way, so the
// error names the call that made it.
function terminal(ctx, label) {
  if (!ctx.fs.isDir(ctx.cwd)) throw new Error(`${label}: cwd is not a directory: ${ctx.cwd}`)
  return {
    run: (line) => safeRun(line, ctx),
    cwd: () => ctx.cwd,
    complete: (line) => complete(line, ctx, ctx.registry),
    fork: (opts) => fork(ctx, opts),
    ...reading(ctx),
  }
}

function dispatch(name, tokens, stdin, ctx, external = false) {
  const reg = ctx.registry
  const resolved = reg.resolveCommand(name)
  const run = () => {
    if ((external || name !== resolved) && reg.shellOnly(resolved)) return unsupported('command', name, name, `${name}: shell builtin cannot be invoked as an external command`, 127)
    const cmd = reg.commands[resolved]
    return cmd ? cmd(stdin, tokens, ctx) : unknownCommand(name, reg)
  }
  const route = (r) => routeExternalOutput(record(ctx, commandWriteError(name, r, ctx), resolved), ctx)
  try {
    return ctx.io.run(resolved, () => route(run()))
  } catch (e) {
    missingPathNote(ctx, name, e?.path, e?.fsError)
    const message = `${name}: ${reason(e)}`
    const note = unsupportedNote(e)
    // Shared parsers cannot name the command; complete their notes here.
    if (note) ctx.unsupported.add({ ...note, command: note.command ?? name, message }, note.command ?? resolved)
    return route(err(message))
  }
}

// All dispatch paths, including nested commands, contribute to the same feed.
// Resolve bin aliases for deduplication without changing the reported name.
function record(ctx, result, resolved) {
  const note = unsupportedNote(result)
  if (note) ctx.unsupported.add(note, resolved)
  return result
}

// Reentrant run() calls need separate feeds and stream state.
// Syntax errors exit 2; unsupported constructs exit 1.
function safeRun(line, ctx) {
  const feed = createUnsupportedFeed()
  return withState(ctx, { unsupported: feed, notes: new Set(), discarded: new Set(), stdinFile: false, stdinPiped: false, stdinOrigin: null, stdinHandle: null, closed: { out: false, err: false }, outputFds: { 1: 'out', 2: 'err' } }, () => {
    const result = { stdout: '', stderr: '', exitCode: 0 }
    const stream = { text: '' }
    try {
      for (const steps of parseUnits(line, ctx.writable, ctx.registry.has)) {
        const r = runSteps(steps, ctx, stream)
        result.stdout += r.stdout
        result.stderr += r.stderr
        result.exitCode = r.exitCode
        if (r.halt || r.control) break
      }
    } catch (e) {
      const note = unsupportedNote(e)
      if (note) feed.add(note)
      ctx.lastExit = e.exitCode ?? (note ? 1 : 2)
      result.stderr += `error: ${e.message}\n`
      result.exitCode = ctx.lastExit
    }
    return finish(result, ctx, feed)
  })
}

// Do not expose internal halt/control fields or mutable diagnostic entries.
const finish = (r, ctx, feed) => ({
  stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, cwd: ctx.cwd,
  unsupported: Object.freeze(feed.entries),
  notes: Object.freeze([...ctx.notes, ...discardedNotes(ctx.discarded, r.stderr, ctx.notes)]),
})
