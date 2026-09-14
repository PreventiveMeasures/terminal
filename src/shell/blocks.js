// The compound commands: a list run more than once, or run somewhere other
// than where it stands. Each is a list in the end, so each is handed the one
// thing it needs from the runner — how to run one.

import { expandWords } from './expand.js'
import { err } from '../util.js'
import { appendOutput, emptyOutput } from './output.js'
import { isolated } from './state.js'
import { evaluateConditional } from './conditional.js'

export function runBlock(stage, ctx, stdin, runSteps) {
  // A definition runs nothing and leaves the body where a call can reach it.
  if (stage.define) { ctx.functions.set(stage.define.name, stage.define.body); return emptyOutput() }
  if (stage.test) return evaluateConditional(stage.test, ctx)
  if (stage.group) return runGroup(stage, ctx, stdin, runSteps)
  if (stage.loop) return stage.loop.words ? runLoop(stage.loop, ctx, runSteps) : runWhile(stage.loop, ctx, runSteps)
  return runConditional(stage.conditional, ctx, stdin, runSteps)
}

// `while LIST; do LIST; done` runs its body for as long as the condition
// succeeds, and `until` for as long as it fails. The condition's own output
// is the loop's, and its status is not: a loop that never runs its body
// reports 0, as bash does. Nothing runs beside a line here, so a loop that
// never ends is one that never returns — past a bound no line means to cross
// it refuses, rather than take the terminal with it.
const TURN_LIMIT = 10_000
const TURN_GAP = { kind: 'feature', command: null, detail: 'loop limit', message: `a loop running more than ${TURN_LIMIT} times is not supported` }
function runWhile(loop, ctx, runSteps) {
  const result = emptyOutput()
  const stream = { text: ctx.stdinLeft }
  ctx.loopDepth++
  try {
    for (let turn = 0; ; turn++) {
      // What the loop has already run, it has run: its output stands, and the
      // feed carries the gap that the rest of it never will.
      if (turn === TURN_LIMIT) {
        ctx.unsupported.add(TURN_GAP)
        appendOutput(result, err(`error: ${TURN_GAP.message}`, 1))
        break
      }
      const status = result.exitCode
      const test = runSteps(loop.condition, ctx, stream, true)
      appendOutput(result, test)
      result.exitCode = status
      if (test.halt || test.control) return { ...result, halt: test.halt, control: test.control, blame: test.blame }
      if ((test.exitCode === 0) === Boolean(loop.until)) break
      const r = runSteps(loop.body, ctx, stream)
      appendOutput(result, r)
      result.blame = r.blame
      if (r.halt) return { ...result, halt: true }
      if (r.control?.levels > 1) return { ...result, control: { ...r.control, levels: r.control.levels - 1 } }
      if (r.control?.type === 'break') break
    }
  } finally {
    ctx.loopDepth--
  }
  return result
}

// Expand the word list once, behind the keyword: expansion reads argv[0] as
// the command name, and a list whose first word is `export` would otherwise be
// taken for a declaration. The loop variable persists after completion, and
// nested break/continue signals propagate one level per enclosing loop.
const FOR_KEYWORD = { value: 'for', mask: null }
function runLoop(loop, ctx, runSteps) {
  const expanded = expandWords([FOR_KEYWORD, ...loop.words], ctx)
  const result = emptyOutput()
  const stream = { text: ctx.stdinLeft }
  ctx.loopDepth++
  try {
    for (const value of expanded.argv.slice(1)) {
      ctx.vars.set(loop.name, value)
      const r = runSteps(loop.body, ctx, stream)
      appendOutput(result, r)
      result.blame = r.blame
      if (r.halt) return { ...result, halt: true }
      if (r.control?.levels > 1) return { ...result, control: { ...r.control, levels: r.control.levels - 1 } }
      if (r.control?.type === 'break') break
    }
  } finally {
    ctx.loopDepth--
  }
  return result
}

function runConditional(conditional, ctx, stdin, runSteps) {
  const result = emptyOutput()
  const stream = { text: stdin }
  for (const branch of conditional.branches) {
    const test = runSteps(branch.condition, ctx, stream, true)
    appendOutput(result, test)
    if (test.halt || test.control) return { ...result, halt: test.halt, control: test.control, blame: test.blame }
    if (test.exitCode !== 0) continue
    const body = runSteps(branch.body, ctx, stream)
    appendOutput(result, body)
    return { ...result, halt: body.halt, control: body.control, blame: body.blame }
  }
  if (!conditional.otherwise) { result.exitCode = 0; return result }
  const last = runSteps(conditional.otherwise, ctx, stream)
  appendOutput(result, last)
  return { ...result, halt: last.halt, control: last.control, blame: last.blame }
}


function runGroup(stage, ctx, stdin, runSteps) {
  const stream = { text: stdin }
  if (!stage.isolate) return runSteps(stage.group, ctx, stream)
  const r = isolated(ctx, () => runSteps(stage.group, ctx, stream))
  return { ...r, halt: false, control: undefined }
}
