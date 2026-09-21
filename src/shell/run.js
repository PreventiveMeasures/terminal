import { expandRedirect, expandScalar, expandWords } from './expand.js'
import { readBacktickSubstitution, readExpansion } from './lex.js'
import { refusedWrite } from './parse.js'
import { BindingMap } from './bindings.js'
import { gateBlame, gateTracker, lookupWithNote, missingPathNote } from '../notes.js'
import { UnsupportedError, unsupported, unsupportedNote } from '../unsupported.js'
import { err, reason } from '../util.js'
import { appendOutput, emptyOutput, routeOutput } from './output.js'
import { isolated, withState } from './state.js'
import { runBlock } from './blocks.js'

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
export async function runSteps(steps, ctx, stream, condition = false) {
  // `&` hands the whole list it closes to the background, and nothing here
  // runs there. Running it in the foreground instead is a different answer —
  // a different order, and a status the shell would not have waited for — so
  // the list refuses before any of it runs.
  if (steps.some((step) => step.background)) throw new UnsupportedError('feature', '&', 'background processes (`&`) are not supported')
  const result = emptyOutput()
  // An `if` reads the whole chain for its status, which is what `&&` is for
  // there; only a chain run for its effects has anything to report.
  let blame = null, gate = null
  for (const [index, step] of steps.entries()) {
    if (step.warnings) appendOutput(result, routeOutput({ ...emptyOutput(step.warnings), exitCode: result.exitCode, ignored: result.ignored }, { fds: ctx.outputFds }, ctx))
    if (step.gate === 'and' && result.exitCode !== 0) { (gate ??= gateTracker()).skip(condition ? null : blame, result.exitCode); continue }
    if (step.gate === 'or' && result.exitCode === 0) continue
    gate?.flush(ctx.notes)
    // `set -e` reads the last command of a `&&`/`||` chain and nothing else in
    // it, nothing a condition asks, and nothing a `!` negates. The exemption
    // reaches whatever that command itself runs — a subshell, a group, a body
    // it calls — so it travels with the shell state rather than this call.
    const exempt = condition || step.negate || continues(steps, index)
    // A list is one command after another, which is what a list is: each step
    // waits for the one before it, whether or not that one had to wait itself.
    // oxlint-disable-next-line no-await-in-loop -- a step of a list runs after the one before it.
    const r = await (exempt
      ? withState(ctx, { errexitOff: true }, () => runPipeline(step.stages, ctx, stream))
      : runPipeline(step.stages, ctx, stream))
    appendOutput(result, r)
    if (step.negate && !r.halt) result.exitCode = r.exitCode === 0 ? 1 : 0
    // The status a list ends on is the list's, and so is what `set -e` makes
    // of it: a status it was told to ignore here is one it ignores out there,
    // which is how a compound command carries its indulgence to the caller.
    if (exempt) result.ignored = true
    // `!` inverts the status, so the command no longer explains a gate reading it.
    blame = step.negate ? null : r.blame
    ctx.lastExit = result.exitCode
    if (r.halt || r.control) { Object.assign(result, { halt: r.halt, control: r.control }); break }
    // The status is the failing command's, as the shell's own exit is.
    if (result.exitCode !== 0 && !result.ignored && ctx.errexit && !ctx.errexitOff) { result.halt = true; break }
  }
  gate?.flush(ctx.notes)
  ctx.stdinLeft = stream.text
  return Object.assign(result, { blame })
}

// Whether a `&&`/`||` chain carries on past this step: only the command it
// ends on is one `set -e` reads.
const continues = (steps, index) => ['and', 'or'].includes(steps[index + 1]?.gate)

// Multi-stage pipelines isolate shell state and take the last stage's status.
// Only the first stage consumes the enclosing list's shared input stream.
async function runPipeline(stages, ctx, stream) {
  const output = emptyOutput()
  let input = stream.text
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]
    const first = i === 0
    let piped = ''
    const fds = { ...ctx.outputFds }
    if (i < stages.length - 1) fds[1] = { write(text) { piped += text } }
    const stageInput = input
    const run = () => pipelineStage(stage, ctx, stageInput, first && ctx.stdinFile, fds, first ? ctx.stdinPiped : true)
    // Every stage of a real pipeline is its own process, and what `set -e`
    // ignored in there is as much its own business as the rest of its state.
    // oxlint-disable-next-line no-await-in-loop -- a stage reads what the one before it wrote, so it runs after it.
    const routed = stages.length > 1 ? { ...await isolated(ctx, run), ignored: false } : await run()
    if (first) stream.text = routed.inputLeft
    appendOutput(output, routed)
    input = piped
    // A pipeline's status is its last stage's, so its blame is too.
    output.blame = routed.blame
    if (stages.length === 1) { output.halt = routed.halt; output.control = routed.control }
  }
  return output
}

// Simple-command arguments expand before redirects. All expansion diagnostics
// follow the descriptors active at their expansion site.
function pipelineStage(stage, ctx, stdin, stdinFile, fds, stdinPiped) {
  const initial = { fds, stdin, stdinFile, stdinPiped, stdinOrigin: stdinFile ? ctx.stdinOrigin : null, stdinHandle: stdinFile ? ctx.stdinHandle : null }
  return withState(ctx, { substitutionExit: null, expansionOutput: emptyOutput(), expansionFds: fds }, () => withStreams(initial, ctx, async () => {
    const simple = !stage.group && !stage.loop && !stage.conditional && !stage.test && !stage.define
    let expanded, expansionError
    try {
      if (simple) {
        expanded = await expandWords(stage.words, ctx)
        if (expanded.argv.length === 0) await assignValues(stage.assigns, ctx)
        else expanded.temps = await temporaryValues(stage.assigns, ctx)
      }
    } catch (e) {
      expansionError = shellFailure(ctx, e)
    }
    if (expansionError) {
      appendOutput(ctx.expansionOutput, routeStageOutput(expansionError, initial, ctx))
      return { ...ctx.expansionOutput, inputLeft: ctx.stdinLeft, halt: expansionError.halt }
    }
    const io = await resolveRedirs(stage, ctx, ctx.stdinLeft, stdinFile, fds)
    ctx.expansionFds = io.fds
    let routed = false
    // Blame for an `&&` gate reading this stage's status. A stage that failed
    // before reaching a command — a bad redirect, an expansion error — leaves
    // it unset, and the gate then has nothing to name.
    let blame = null
    const result = await withStreams(io, ctx, () => shellResult(ctx, async () => {
      if (io.error) return io.error
      if (!simple) {
        const r = await runBlock(stage, ctx, io.stdin, runSteps)
        routed = true
        blame = r.blame ?? null
        return r
      }
      // A function is its body run here, which is all one can be while its
      // body reads nothing of the call: the words a caller added are no more
      // readable from inside it than the line it was defined on.
      const name = expanded.argv.length > 0 ? expanded.argv[0] : null
      const body = name === null ? undefined : ctx.functions.get(name)
      if (body) {
        routed = true
        // A body standing where it is called cannot stand inside itself.
        if (ctx.calling.has(name)) {
          const gap = unsupported('feature', name, 'function recursion', `${name}: a function calling itself is not supported`)
          ctx.unsupported.add(unsupportedNote(gap))
          return gap
        }
        ctx.calling.add(name)
        // A `break` inside the body is no more in the caller's loop than the
        // line the body was defined on was.
        // A call reports the body's status as its own, and no more: bash
        // exits on it even where the body ended on a `!` it was ignoring.
        try { return await withState(ctx, { loopDepth: 0 }, async () => ({ ...await withTemporaries(expanded.temps, ctx, () => runSteps(body, ctx, { text: io.stdin })), ignored: false })) } finally { ctx.calling.delete(name) }
      }
      const r = await runStage(ctx, expanded)
      if (expanded.argv.length) blame = gateBlame(ctx.registry.chainRole(expanded.argv), expanded.argv[0])
      return r
    }))
    const inputLeft = io.inherited ? ctx.stdinLeft : io.parentLeft
    appendOutput(ctx.expansionOutput, routed ? result : routeStageOutput(result, io, ctx))
    return { ...ctx.expansionOutput, inputLeft, halt: result.halt, control: result.control, blame }
  }))
}

function routeStageOutput(result, io, ctx) {
  try { return routeOutput(result, io, ctx) } catch (e) { return routeOutput(shellFailure(ctx, e), io, ctx) }
}

// Apply redirects left to right. Track reopened file origins separately
// from pipe input; only inherited input advances the enclosing list's stream.
async function resolveRedirs(stage, ctx, stdin, stdinFile, initialFds) {
  const fds = { ...initialFds }
  let input = stdin
  let file = stdinFile
  let origin = file ? ctx.stdinOrigin : null
  let handle = file ? ctx.stdinHandle : null
  let inherited = true
  let parentLeft = stdin
  let redirected = false
  const done = (error) => ({ error, fds, stdin: input, stdinFile: file, stdinPiped: redirected || ctx.stdinPiped, stdinOrigin: file ? origin : null, stdinHandle: file ? handle : null, inherited, parentLeft })
  const expand = async (fn) => {
    const value = await withState(ctx, { expansionFds: fds }, () => withStreams({ fds, stdin: input, stdinFile: file, stdinOrigin: origin, stdinHandle: handle }, ctx, fn))
    input = ctx.stdinLeft
    if (inherited) parentLeft = input
    return value
  }
  try {
    // Redirects are applied left to right and a word is expanded where its
    // redirect stands, so each of these waits for the one to its left.
    // oxlint-disable no-await-in-loop -- a redirect is applied after the one to its left.
    for (const r of stage.redirs) {
      if (r.op === 'dup') {
        if (fds[r.toFd] === undefined || fds[r.toFd] === 'closed') return done(err(`error: ${r.toFd}: Bad file descriptor`))
        fds[r.fd] = fds[r.toFd]
      } else if (r.op === 'close') fds[r.fd] = 'closed'
      else if (r.op === 'to') {
        const t = r.target === undefined ? await expand(() => expandRedirect(r.word, ctx)) : { value: r.target }
        if (t.error) return done(err(`error: ${t.error}`))
        const dest = t.value === '/dev/null' ? 'null' : t.value === '/dev/stdout' ? fds[1] : t.value === '/dev/stderr' ? fds[2] : ctx.writable ? ctx.fs.openWritable(ctx.cwd, t.value, r.append) : null
        if (dest === null) {
          const e = refusedWrite(r.label, t.value, ctx.writable)
          ctx.unsupported.add(unsupportedNote(e))
          return done(err(`error: ${e.message}`))
        }
        if (dest === 'closed') return done(err(`error: ${t.value}: No such file or directory`))
        fds[r.fd] = dest
        if (r.both) fds[2] = dest
      } else if (r.op === 'text') { input = r.expand ? await expand(() => expandScalar(heredocWord(r.body), ctx)) : r.body; file = false; inherited = false }
      // A here-string is expanded but neither split nor globbed (bash).
      else if (r.op === 'herestring') { input = await expand(() => expandScalar(r.word, ctx)) + '\n'; file = false; inherited = false }
      else {
        const t = await expand(() => expandRedirect(r.word, ctx))
        const read = t.error ? { error: err(`error: ${t.error}`) } : readInput(t.value, ctx, file ? origin : input)
        if (read.error) return done(read.error)
        input = read.content
        // A pipe's /dev/stdin shares the current stream. A regular file
        // is reopened from its original start with an independent offset.
        if (t.value !== '/dev/stdin' || file) inherited = false
        if (t.value !== '/dev/stdin') { file = t.value !== '/dev/null'; origin = file ? input : null; handle = read.handle; redirected = file }
      }
    }
    // oxlint-enable no-await-in-loop
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
  missingPathNote(ctx, 'shell', e?.path, e?.fsError)
  const note = unsupportedNote(e)
  if (note) ctx.unsupported.add(note)
  return { ...err(`error: ${reason(e)}`, 1), ...(e?.halt ? { halt: true } : {}) }
}

async function shellResult(ctx, fn) {
  try { return await fn() } catch (e) { return shellFailure(ctx, e) }
}

// Closed descriptors propagate from enclosing groups. Leave stdinLeft
// available to the enclosing list while restoring the other stream state.
function withStreams(io, ctx, fn) {
  const state = { outputFds: io.fds, closed: { out: io.fds[1] === 'closed', err: io.fds[2] === 'closed' }, stdinFile: Boolean(io.stdinFile), stdinPiped: io.stdinPiped ?? ctx.stdinPiped, stdinOrigin: io.stdinOrigin, stdinHandle: io.stdinHandle }
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
    if (c === '`') {
      const backtick = readBacktickSubstitution(body, i)
      value += backtick.raw
      mask += '2' + '1'.repeat(backtick.raw.length - 1)
      i += backtick.raw.length - 1
      continue
    }
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
  const { path: abs, error } = lookupWithNote(ctx, 'shell', path)
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
async function assignValues(assigns, ctx) {
  // oxlint-disable-next-line no-await-in-loop -- prefix values expand left to right, each reading what the last assigned.
  for (const a of assigns) ctx.vars.set(a.name, await expandScalar(a.word, ctx, true))
}

async function temporaryValues(assigns, ctx) {
  if (assigns.length === 0) return null
  const outer = ctx.vars, vars = new BindingMap(outer)
  const names = new Set(assigns.map((a) => a.name))
  vars.bound = new Set()
  try {
    await withState(ctx, { vars }, async () => {
      for (const a of assigns) {
        vars.expansionTargets = names
        // oxlint-disable-next-line no-await-in-loop -- prefix values expand left to right, each reading what the last assigned.
        const value = await expandScalar(a.word, ctx, true)
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

async function withTemporaries(prepared, ctx, fn) {
  if (!prepared) return fn()
  const outer = ctx.vars
  const inner = new BindingMap(outer), temps = prepared.names
  for (const name of temps) inner.set(name, prepared.vars.get(name))
  ctx.vars = inner
  try {
    inner.bound = new Set()
    return await fn()
  } finally {
    ctx.vars = outer
    for (const [name, value] of inner) if (!temps.has(name) || inner.bound?.has(name)) outer.set(name, value)
    for (const name of inner.unsetNames) if (!temps.has(name)) outer.delete(name)
  }
}
