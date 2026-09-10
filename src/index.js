// In-memory shell over a { path: content } source tree; no host I/O.
// cwd and variables persist across run() calls. Unsupported constructs also
// reach a diagnostic feed that redirects and pipelines cannot suppress.
// Informational notes share that scope without changing the command's streams.
// Caller-provided command handlers use the contract in custom.js.

import { mountSources } from './mount.js'
import { parseUnits } from './shell/parse.js'
import { DEFAULT_REGISTRY, createRegistry, unknownCommand } from './registry.js'
import { BindingMap } from './shell/bindings.js'
import { createUnsupportedFeed, unsupported, unsupportedNote } from './unsupported.js'
import { err, missingPathNote, reason } from './util.js'
import { complete } from './complete.js'
import { commandSubstitution } from './shell/capture.js'
import { isolated, withState } from './shell/state.js'
import { commandWriteError, createIoGuard, routeExternalOutput, runSteps } from './shell/run.js'

export function createTerminal(sources, opts = {}) {
  const { fs, cwd, home, mount, writable } = mountSources(sources, opts)
  // stdinLeft tracks consumption within a command list; stdinOrigin allows
  // /dev/stdin to reopen a redirected file independently of that offset.
  const registry = opts.commands === undefined ? DEFAULT_REGISTRY : createRegistry(opts.commands)
  const ctx = {
    cwd, fs, io: createIoGuard(fs), user: opts.user ?? 'user', home, mount, writable, registry, outputFds: { 1: 'out', 2: 'err' },
    vars: new BindingMap(), lastExit: 0, loopDepth: 0, closed: { out: false, err: false }, stdinFile: false, stdinOrigin: null, stdinHandle: null, stdinLeft: '',
    unsupported: createUnsupportedFeed(), notes: new Set(),
  }
  // find -exec and xargs dispatch externally in isolated shell state.
  ctx.dispatch = (name, tokens, stdin) => withState(ctx, { stdinLeft: ctx.stdinLeft, stdinFile: false, stdinOrigin: null, stdinHandle: null },
    () => isolated(ctx, () => dispatch(name, tokens, stdin, ctx, true)))
  ctx.flushOutput = (result) => routeExternalOutput(result, ctx)
  ctx.hasCommand = (name) => registry.has(name) && !registry.shellOnly(name)
  ctx.invoke = (name, tokens, stdin) => dispatch(name, tokens, stdin, ctx)
  ctx.substitute = (command, backtick) => commandSubstitution(command, ctx, runSteps, backtick)
  if (!fs.isDir(ctx.cwd)) throw new Error(`createTerminal: cwd is not a directory: ${ctx.cwd}`)
  return {
    run: (line) => safeRun(line, ctx),
    cwd: () => ctx.cwd,
    complete: (line) => complete(line, ctx, registry),
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
  return withState(ctx, { unsupported: feed, notes: new Set(), stdinFile: false, stdinOrigin: null, stdinHandle: null, closed: { out: false, err: false }, outputFds: { 1: 'out', 2: 'err' } }, () => {
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
const finish = (r, ctx, feed) => ({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, cwd: ctx.cwd, unsupported: Object.freeze(feed.entries), notes: Object.freeze([...ctx.notes]) })
