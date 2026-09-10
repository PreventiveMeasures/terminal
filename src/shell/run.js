import { expandRedirect, expandScalar, expandWords } from './expand.js'
import { backtickGap, readExpansion } from './lex.js'
import { refusedWrite } from './parse.js'
import { BindingMap } from './bindings.js'
import { lookup } from '../fs.js'
import { UnsupportedError, unsupportedNote } from '../unsupported.js'
import { err, reason } from '../util.js'
import { appendOutput, emptyOutput, routeOutput } from './output.js'
import { isolated, withState } from './state.js'
import { evaluateConditional } from './conditional.js'

export { createIoGuard } from './io.js'
export { commandWriteError } from './output.js'

// Commands flush files before a subsequent command reads them.
// Other streams stay in the enclosing handler's result for routing.
export function routeExternalOutput(result, ctx) {
  const fds = {
    1: ctx.outputFds[1]?.path ? ctx.outputFds[1] : 'out',
    2: ctx.outputFds[2]?.path ? ctx.outputFds[2] : 'err',
  }
  return routeOutput(result, { fds }, ctx)
}

// A list shares stdin across its steps: { cat; cat; } consumes it once.
// `exit` bypasses pipeline negation; break/continue still carry its status.
export function runSteps(steps, ctx, stream) {
  const result = emptyOutput()
  for (const step of steps) {
    if (step.warnings) appendOutput(result, routeOutput({ ...emptyOutput(step.warnings), exitCode: result.exitCode }, { fds: ctx.outputFds }, ctx))
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
  let input = stream.text
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]
    const first = i === 0
    let piped = ''
    const fds = { ...ctx.outputFds }
    if (i < stages.length - 1) fds[1] = { write(text) { piped += text } }
    const stageInput = input
    const run = () => pipelineStage(stage, ctx, stageInput, first && ctx.stdinFile, fds)
    const routed = stages.length > 1 ? isolated(ctx, run) : run()
    if (first) stream.text = routed.inputLeft
    appendOutput(output, routed)
    input = piped
    if (stages.length === 1) { output.halt = routed.halt; output.control = routed.control }
  }
  return output
}

// Simple-command arguments expand before redirects. All expansion diagnostics
// follow the descriptors active at their expansion site.
function pipelineStage(stage, ctx, stdin, stdinFile, fds) {
  const initial = { fds, stdin, stdinFile, stdinOrigin: stdinFile ? ctx.stdinOrigin : null, stdinHandle: stdinFile ? ctx.stdinHandle : null }
  return withState(ctx, { substitutionExit: null, expansionOutput: emptyOutput(), expansionFds: fds }, () => withStreams(initial, ctx, () => {
    const simple = !stage.group && !stage.loop && !stage.conditional && !stage.test
    let expanded, expansionError
    try {
      if (simple) {
        expanded = expandWords(stage.words, ctx)
        if (expanded.argv.length === 0) assignValues(stage.assigns, ctx)
        else expanded.temps = temporaryValues(stage.assigns, ctx)
      }
    } catch (e) {
      expansionError = shellFailure(ctx, e)
    }
    if (expansionError) {
      appendOutput(ctx.expansionOutput, routeStageOutput(expansionError, initial, ctx))
      return { ...ctx.expansionOutput, inputLeft: ctx.stdinLeft, halt: expansionError.halt }
    }
    const io = resolveRedirs(stage, ctx, ctx.stdinLeft, stdinFile, fds)
    ctx.expansionFds = io.fds
    let routed = false
    const result = withStreams(io, ctx, () => shellResult(ctx, () => {
      if (io.error) return io.error
      if (!simple) {
        const r = stage.test ? evaluateConditional(stage.test, ctx) : stage.group ? runGroup(stage, ctx, io.stdin) : stage.loop ? runLoop(stage.loop, ctx) : runConditional(stage.conditional, ctx, io.stdin)
        routed = true
        return r
      }
      return runStage(ctx, expanded)
    }))
    const inputLeft = io.inherited ? ctx.stdinLeft : io.parentLeft
    appendOutput(ctx.expansionOutput, routed ? result : routeStageOutput(result, io, ctx))
    return { ...ctx.expansionOutput, inputLeft, halt: result.halt, control: result.control }
  }))
}

function routeStageOutput(result, io, ctx) {
  try { return routeOutput(result, io, ctx) } catch (e) { return routeOutput(shellFailure(ctx, e), io, ctx) }
}

// Apply redirects left to right. Track reopened file origins separately
// from pipe input; only inherited input advances the enclosing list's stream.
function resolveRedirs(stage, ctx, stdin, stdinFile, initialFds) {
  const fds = { ...initialFds }
  let input = stdin
  let file = stdinFile
  let origin = file ? ctx.stdinOrigin : null
  let handle = file ? ctx.stdinHandle : null
  let inherited = true
  let parentLeft = stdin
  const done = (error) => ({ error, fds, stdin: input, stdinFile: file, stdinOrigin: file ? origin : null, stdinHandle: file ? handle : null, inherited, parentLeft })
  const expand = (fn) => {
    const value = withState(ctx, { expansionFds: fds }, () => withStreams({ fds, stdin: input, stdinFile: file, stdinOrigin: origin, stdinHandle: handle }, ctx, fn))
    input = ctx.stdinLeft
    if (inherited) parentLeft = input
    return value
  }
  try {
    for (const r of stage.redirs) {
      if (r.op === 'dup') {
        if (fds[r.toFd] === undefined || fds[r.toFd] === 'closed') return done(err(`error: ${r.toFd}: Bad file descriptor`))
        fds[r.fd] = fds[r.toFd]
      } else if (r.op === 'close') fds[r.fd] = 'closed'
      else if (r.op === 'to') {
        const t = r.target === undefined ? expand(() => expandRedirect(r.word, ctx)) : { value: r.target }
        if (t.error) return done(err(`error: ${t.error}`))
        const dest = t.value === '/dev/null' ? 'null' : t.value === '/dev/stdout' ? fds[1] : t.value === '/dev/stderr' ? fds[2] : ctx.writable ? ctx.fs.openWritable(ctx.cwd, t.value, r.append) : null
        if (dest === null) {
          const e = refusedWrite(r.label, t.value)
          ctx.unsupported.add(unsupportedNote(e))
          return done(err(`error: ${e.message}`))
        }
        if (dest === 'closed') return done(err(`error: ${t.value}: No such file or directory`))
        fds[r.fd] = dest
        if (r.both) fds[2] = dest
      } else if (r.op === 'text') { input = r.expand ? expand(() => expandScalar(heredocWord(r.body), ctx)) : r.body; file = false; inherited = false }
      // A here-string is expanded but neither split nor globbed (bash).
      else if (r.op === 'herestring') { input = expand(() => expandScalar(r.word, ctx)) + '\n'; file = false; inherited = false }
      else {
        const t = expand(() => expandRedirect(r.word, ctx))
        const read = t.error ? { error: err(`error: ${t.error}`) } : readInput(t.value, ctx, file ? origin : input)
        if (read.error) return done(read.error)
        input = read.content
        // A pipe's /dev/stdin shares the current stream. A regular file
        // is reopened from its original start with an independent offset.
        if (t.value !== '/dev/stdin' || file) inherited = false
        if (t.value !== '/dev/stdin') { file = t.value !== '/dev/null'; origin = file ? input : null; handle = read.handle }
      }
    }
    if (file && handle) {
      const current = ctx.io.bufferReads(() => ctx.fs.readIdentity(handle.identity))
      if (current !== handle.content) {
        if (inherited || input !== handle.content) throw new UnsupportedError('feature', 'modified redirected input', 'reading an inherited input file after it changes is not supported')
        // A later output redirect may truncate a newly opened input file.
        input = origin = current
        handle = { ...handle, content: current }
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
  return { ...err(`error: ${reason(e)}`, 1), ...(e?.halt ? { halt: true } : {}) }
}

function shellResult(ctx, fn) {
  try { return fn() } catch (e) { return shellFailure(ctx, e) }
}

// Closed descriptors propagate from enclosing groups. Leave stdinLeft
// available to the enclosing list while restoring the other stream state.
function withStreams(io, ctx, fn) {
  const state = { outputFds: io.fds, closed: { out: io.fds[1] === 'closed', err: io.fds[2] === 'closed' }, stdinFile: Boolean(io.stdinFile), stdinOrigin: io.stdinOrigin, stdinHandle: io.stdinHandle }
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
    if (c === '$') {
      const ref = readExpansion(body, i, 0, true)
      if (ref?.command !== undefined || ref?.parameter !== undefined || ref?.arithmetic !== undefined) {
        value += ref.raw
        mask += '2' + '1'.repeat(ref.raw.length - 1)
        i += ref.raw.length - 1
        continue
      }
    }
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
  if (ctx.fs.isFile(abs)) {
    const content = ctx.fs.readFile(abs)
    return { content, handle: ctx.writable && abs.startsWith('/tmp/') ? { path: abs, content, identity: ctx.fs.fileIdentity(abs) } : null }
  }
  return { error: err(`error: ${path}: Is a directory`) }
}

// Expand argv before applying prefix assignments. A nameless assignment
// persists; a command's prefix assignments use temporary bindings.
function runStage(ctx, expanded) {
  const { argv } = expanded
  if (argv.length === 0) {
    return { stdout: '', stderr: '', exitCode: ctx.substitutionExit ?? 0 }
  }
  return withTemporaries(expanded.temps, ctx, () => ctx.invoke(argv[0], argv.slice(1), ctx.stdinLeft))
}

// Prefix values expand left to right. After dispatch, keep changes to other
// variables and explicit assignments to temporary names, but not their unsets.
function assignValues(assigns, ctx) {
  for (const a of assigns) ctx.vars.set(a.name, expandScalar(a.word, ctx, true))
}

function temporaryValues(assigns, ctx) {
  if (assigns.length === 0) return null
  const outer = ctx.vars, vars = new BindingMap(outer)
  const names = new Set(assigns.map((a) => a.name))
  vars.bound = new Set()
  try {
    withState(ctx, { vars }, () => {
      for (const a of assigns) {
        vars.expansionTargets = names
        const value = expandScalar(a.word, ctx, true)
        vars.expansionTargets = null
        vars.set(a.name, value)
      }
    })
  } finally {
    // RHS mutations of ordinary variables survive failed redirects or later
    // expansion errors; the command's temporary names remain scoped.
    vars.expansionTargets = null
    for (const name of vars.bound) if (!names.has(name)) outer.set(name, vars.get(name))
  }
  return { vars, names }
}

function withTemporaries(prepared, ctx, fn) {
  if (!prepared) return fn()
  const outer = ctx.vars
  const inner = new BindingMap(outer), temps = prepared.names
  for (const name of temps) inner.set(name, prepared.vars.get(name))
  ctx.vars = inner
  try {
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
function runLoop(loop, ctx) {
  const expanded = expandWords(loop.words, ctx)
  const result = emptyOutput()
  const stream = { text: ctx.stdinLeft }
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

function runConditional(conditional, ctx, stdin) {
  const result = emptyOutput()
  const stream = { text: stdin }
  for (const branch of conditional.branches) {
    const test = runSteps(branch.condition, ctx, stream)
    appendOutput(result, test)
    if (test.halt || test.control) return { ...result, halt: test.halt, control: test.control }
    if (test.exitCode !== 0) continue
    const body = runSteps(branch.body, ctx, stream)
    appendOutput(result, body)
    return { ...result, halt: body.halt, control: body.control }
  }
  if (conditional.otherwise) {
    const body = runSteps(conditional.otherwise, ctx, stream)
    appendOutput(result, body)
    return { ...result, halt: body.halt, control: body.control }
  }
  result.exitCode = 0
  return result
}


function runGroup(stage, ctx, stdin) {
  const stream = { text: stdin }
  if (!stage.isolate) return runSteps(stage.group, ctx, stream)
  const r = isolated(ctx, () => runSteps(stage.group, ctx, stream))
  return { ...r, halt: false, control: undefined }
}
