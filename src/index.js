// In-memory shell over a { path: content } source tree; no host I/O.
// cwd and variables persist across run() calls. Unsupported constructs also
// reach a diagnostic feed that redirects and pipelines cannot suppress.
// Caller-provided command handlers use the contract in custom.js.

import { createFs, resolve } from './fs.js'
import { parseLine } from './shell/parse.js'
import { DEFAULT_REGISTRY, createRegistry, unknownCommand } from './registry.js'
import { BindingMap } from './shell/bindings.js'
import { createUnsupportedFeed, unsupported, unsupportedNote } from './unsupported.js'
import { err, reason } from './util.js'
import { complete } from './complete.js'
import { commandSubstitution } from './shell/capture.js'
import { isolated, withState } from './shell/state.js'
import { runSteps } from './shell/run.js'

export function createTerminal(sources, opts = {}) {
  const fs = createFs(sources)
  const cwd = opts.cwd === undefined ? '/' : resolve('/', opts.cwd)
  // stdinLeft tracks consumption within a command list; stdinOrigin allows
  // /dev/stdin to reopen a redirected file independently of that offset.
  const registry = opts.commands === undefined ? DEFAULT_REGISTRY : createRegistry(opts.commands)
  const ctx = {
    cwd, fs, user: opts.user ?? 'user', home: '/', registry,
    vars: new BindingMap(), lastExit: 0, loopDepth: 0, closed: { out: false, err: false }, stdinFile: false, stdinOrigin: null, stdinLeft: '',
    unsupported: createUnsupportedFeed(),
  }
  // find -exec and xargs dispatch externally in isolated shell state.
  ctx.dispatch = (name, tokens, stdin) => withState(ctx, { stdinLeft: ctx.stdinLeft, stdinFile: false, stdinOrigin: null },
    () => isolated(ctx, () => dispatch(name, tokens, stdin, ctx, true)))
  ctx.hasCommand = (name) => registry.has(name) && !registry.shellOnly(name)
  ctx.invoke = (name, tokens, stdin) => dispatch(name, tokens, stdin, ctx)
  ctx.substitute = (command) => commandSubstitution(command, ctx, runSteps)
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
  if ((external || name !== resolved) && reg.shellOnly(resolved)) return record(ctx, unsupported('command', name, name, `${name}: shell builtin cannot be invoked as an external command`, 127), resolved)
  const cmd = reg.commands[resolved]
  if (!cmd) return record(ctx, unknownCommand(name, reg), resolved)
  try {
    return record(ctx, cmd(stdin, tokens, ctx), resolved)
  } catch (e) {
    const message = `${name}: ${reason(e)}`
    const note = unsupportedNote(e)
    // Shared parsers cannot name the command; complete their notes here.
    if (note) ctx.unsupported.add({ ...note, command: note.command ?? name, message }, resolved)
    return err(message)
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
  return withState(ctx, { unsupported: feed, stdinFile: false, stdinOrigin: null, closed: { out: false, err: false } }, () => {
    try {
      return finish(runSteps(parseLine(line), ctx, { text: '' }), ctx, feed)
    } catch (e) {
      const note = unsupportedNote(e)
      if (note) feed.add(note)
      ctx.lastExit = note ? 1 : 2
      return finish(err(`error: ${e.message}`, ctx.lastExit), ctx, feed)
    }
  })
}

// Do not expose internal halt/control fields or mutable diagnostic entries.
const finish = (r, ctx, feed) => ({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, cwd: ctx.cwd, unsupported: Object.freeze(feed.entries) })
