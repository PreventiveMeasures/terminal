// In-memory shell over a { path: content } source tree; no host I/O.
// cwd and variables persist across run() calls. Unsupported constructs also
// reach a diagnostic feed that redirects and pipelines cannot suppress.
// Caller-provided command handlers use the contract in custom.js.

import { createFs, lookup, resolve } from './fs.js'
import { expandRedirect, expandScalar, expandWords } from './shell/expand.js'
import { backtickGap, readExpansion } from './shell/lex.js'
import { parseLine, refusedWrite } from './shell/parse.js'
import { DEFAULT_REGISTRY, createRegistry, unknownCommand } from './registry.js'
import { BindingMap } from './shell/bindings.js'
import { createUnsupportedFeed, unsupported, unsupportedNote } from './unsupported.js'
import { err } from './util.js'
import { complete } from './complete.js'
import { appendOutput, emptyOutput, eventsOf, routeOutput, unorderedOutput, writeError } from './shell/output.js'

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

// Custom handlers may throw primitives, null, or objects with throwing getters.
function reason(e) {
  try {
    const message = e?.message
    return typeof message === 'string' && message !== '' ? message : String(e)
  } catch {
    return 'threw a value with no message'
  }
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

// A list shares stdin across its steps: { cat; cat; } consumes it once.
// `exit` bypasses pipeline negation; break/continue still carry its status.
function runSteps(steps, ctx, stream) {
  const result = emptyOutput()
  for (const step of steps) {
    if (step.gate === 'and' && result.exitCode !== 0) continue
    if (step.gate === 'or' && result.exitCode === 0) continue
    const r = runPipeline(step.stages, ctx, stream)
    appendOutput(result, r)
    if (step.negate && !r.halt) result.exitCode = r.exitCode === 0 ? 1 : 0
    ctx.lastExit = result.exitCode
    if (r.halt || r.control) { Object.assign(result, { halt: r.halt, control: r.control }); break }
  }
  ctx.stdinLeft = stream.text
  return result
}

// Multi-stage pipelines isolate shell state and take the last stage's status.
// Only the first stage consumes the enclosing list's shared input stream.
function runPipeline(stages, ctx, stream) {
  const output = emptyOutput()
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]
    const first = i === 0
    const io = resolveRedirs(stage, ctx, first ? stream.text : output.stdout, first && ctx.stdinFile)
    const run = () => (io.error ? failedStage(stage, ctx, io.error) : stage.group ? runGroup(stage, ctx, io.stdin) : stage.loop ? runLoop(stage.loop, ctx, io.stdin) : runStage(stage, ctx, io.stdin))
    const result = withStreams(io, ctx, () => shellResult(ctx, () => stages.length > 1 ? isolated(ctx, run) : run()))
    if (first && io.inherited) stream.text = ctx.stdinLeft
    const routed = routeOutput(result, io, ctx)
    output.stdout = routed.stdout
    output.stderr += routed.stderr
    output.exitCode = routed.exitCode
    output.unordered ||= routed.unordered
    output.events.push(...(i === stages.length - 1 ? routed.events : routed.events.filter((e) => e.fd === 2)))
    if (stages.length === 1) { output.halt = result.halt; output.control = result.control }
  }
  return output
}

// Apply redirects left to right. Track reopened file origins separately
// from pipe input; only inherited input advances the enclosing list's stream.
function resolveRedirs(stage, ctx, stdin, stdinFile) {
  const fds = { 1: 'out', 2: 'err' }
  const warnings = []
  let input = stdin
  let file = stdinFile
  let origin = file ? ctx.stdinOrigin : null
  let inherited = true
  const done = (error) => ({ error, fds, stdin: input, stdinFile: file, stdinOrigin: file ? origin : null, inherited, warnings: warnings.join('') })
  try {
    for (const r of stage.redirs) {
      if (r.op === 'dup') {
        if (fds[r.toFd] === 'closed') return done(err(`error: ${r.toFd}: Bad file descriptor`))
        fds[r.fd] = fds[r.toFd]
      } else if (r.op === 'close') fds[r.fd] = 'closed'
      else if (r.op === 'to') {
        const t = r.target === undefined ? expandRedirect(r.word, ctx, warnings) : { value: r.target }
        if (t.error) return done(err(`error: ${t.error}`))
        const dest = t.value === '/dev/null' ? 'null' : t.value === '/dev/stdout' ? fds[1] : t.value === '/dev/stderr' ? fds[2] : null
        if (dest === null) {
          const e = refusedWrite(r.label, t.value)
          ctx.unsupported.add(unsupportedNote(e))
          return done(err(`error: ${e.message}`))
        }
        if (dest === 'closed') return done(err(`error: ${t.value}: No such file or directory`))
        fds[r.fd] = dest
        if (r.both) fds[2] = dest
      } else if (r.op === 'text') { input = r.expand ? expandScalar(heredocWord(r.body), ctx, warnings) : r.body; file = false; inherited = false }
      // A here-string is expanded but neither split nor globbed (bash).
      else if (r.op === 'herestring') { input = expandScalar(r.word, ctx, warnings) + '\n'; file = false; inherited = false }
      else {
        const t = expandRedirect(r.word, ctx, warnings)
        const read = t.error ? { error: err(`error: ${t.error}`) } : readInput(t.value, ctx, file ? origin : input)
        if (read.error) return done(read.error)
        input = read.content
        // A pipe's /dev/stdin shares the current stream. A regular file
        // is reopened from its original start with an independent offset.
        if (t.value !== '/dev/stdin' || file) inherited = false
        if (t.value !== '/dev/stdin') { file = t.value !== '/dev/null'; origin = file ? input : null }
      }
    }
  } catch (e) { return done(shellFailure(ctx, e)) }
  return done()
}

// Expansion errors belong to the failing stage: earlier output and later
// pipeline stages survive, and redirections may silence only stderr.
function shellFailure(ctx, e) {
  const note = unsupportedNote(e)
  if (note) ctx.unsupported.add(note)
  return err(`error: ${reason(e)}`, 1)
}

function shellResult(ctx, fn) {
  try { return fn() } catch (e) { return shellFailure(ctx, e) }
}

// A nameless command still applies assignments when its redirect fails.
function failedStage(stage, ctx, error) {
  if (stage.group || stage.loop || stage.assigns.length === 0) return error
  const { argv, stderr } = expandWords(stage.words, ctx)
  if (argv.length > 0) return error
  const warnings = []
  assignValues(stage.assigns, ctx, warnings)
  return { ...error, stderr: error.stderr + stderr + warnings.join('') }
}

// Closed descriptors propagate from enclosing groups. Leave stdinLeft
// available to the enclosing list while restoring the other stream state.
function withStreams(io, ctx, fn) {
  const closedAt = (fd) => io.fds[fd] === 'closed' || ctx.closed[io.fds[fd]] === true
  const state = { closed: { out: closedAt(1), err: closedAt(2) }, stdinFile: Boolean(io.stdinFile), stdinOrigin: io.stdinOrigin }
  ctx.stdinLeft = io.stdin
  return withState(ctx, state, fn)
}

// Unquoted heredocs use double-quote expansion rules without quote removal.
// Only backslashes before $, backslash, or backtick escape a character.
function heredocWord(body) {
  let value = ''
  let mask = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    const n = body[i + 1]
    if (c === '\\' && (n === '$' || n === '\\' || n === '`')) { value += n; mask += '1'; i++; continue }
    if (c === '`') throw backtickGap()
    if (c === '$') readExpansion(body, i)
    value += c
    mask += '2'
  }
  return { value, mask }
}

// Resolve input before dispatch: failed reads prevent command execution.
function readInput(path, ctx, stdin) {
  if (path === '/dev/null') return { content: '' }
  if (path === '/dev/stdin') return { content: stdin }
  const { path: abs, error } = lookup(ctx.cwd, path, ctx.fs)
  if (error) return { error: err(`error: ${path}: ${error}`) }
  if (ctx.fs.isFile(abs)) return { content: ctx.fs.readFile(abs) }
  return { error: err(`error: ${path}: Is a directory`) }
}

// Expand argv before applying prefix assignments. A nameless assignment
// persists; a command's prefix assignments use temporary bindings.
function runStage(stage, ctx, stdin) {
  const { argv, stderr } = expandWords(stage.words, ctx)
  const warnings = []
  if (argv.length === 0) {
    assignValues(stage.assigns, ctx, warnings)
    return { stdout: '', stderr: stderr + warnings.join(''), exitCode: 0 }
  }
  let r = withTemporaries(stage.assigns, ctx, warnings, () => dispatch(argv[0], argv.slice(1), stdin, ctx))
  if (ctx.closed.out && r.stdout !== '') r = writeError(argv[0], r, ctx)
  const prefix = stderr + warnings.join('')
  return prefix === '' ? r : { ...r, stderr: prefix + r.stderr, events: [{ fd: 2, text: prefix }, ...eventsOf(r)], unordered: unorderedOutput(r) }
}

// Prefix values expand left to right. After dispatch, keep changes to other
// variables and explicit assignments to temporary names, but not their unsets.
function assignValues(assigns, ctx, warnings) {
  for (const a of assigns) ctx.vars.set(a.name, expandScalar(a.word, ctx, warnings, true))
}

function withTemporaries(assigns, ctx, warnings, fn) {
  if (assigns.length === 0) return fn()
  const outer = ctx.vars
  const temps = new Set(assigns.map((a) => a.name))
  const inner = new BindingMap(outer)
  ctx.vars = inner
  try {
    assignValues(assigns, ctx, warnings)
    inner.bound = new Set()
    return fn()
  } finally {
    ctx.vars = outer
    for (const [name, value] of inner) if (!temps.has(name) || inner.bound?.has(name)) outer.set(name, value)
    for (const name of inner.unsetNames) if (!temps.has(name)) outer.delete(name)
  }
}

// Expand the word list once. The loop variable persists after completion,
// and nested break/continue signals propagate one level per enclosing loop.
function runLoop(loop, ctx, stdin) {
  const expanded = expandWords(loop.words, ctx)
  const result = emptyOutput(expanded.stderr)
  const stream = { text: stdin }
  ctx.loopDepth++
  try {
    for (const value of expanded.argv.slice(1)) {
      ctx.vars.set(loop.name, value)
      const r = runSteps(loop.body, ctx, stream)
      appendOutput(result, r)
      if (r.halt) return { ...result, halt: true }
      if (r.control?.levels > 1) return { ...result, control: { ...r.control, levels: r.control.levels - 1 } }
      if (r.control?.type === 'break') break
    }
  } finally {
    ctx.loopDepth--
  }
  return result
}

function runGroup(stage, ctx, stdin) {
  const stream = { text: stdin }
  if (!stage.isolate) return runSteps(stage.group, ctx, stream)
  const r = isolated(ctx, () => runSteps(stage.group, ctx, stream))
  return { ...r, halt: false, control: undefined }
}

// Shell state is private to subshells; stdin consumption and diagnostics
// still belong to the enclosing execution.
function isolated(ctx, fn) {
  return withState(ctx, { cwd: ctx.cwd, lastExit: ctx.lastExit, vars: new BindingMap(ctx.vars), loopDepth: 0 }, fn)
}

// Restore exactly the scoped fields, including when nested execution throws.
function withState(ctx, state, fn) {
  const saved = Object.fromEntries(Object.keys(state).map((key) => [key, ctx[key]]))
  Object.assign(ctx, state)
  try { return fn() } finally { Object.assign(ctx, saved) }
}
