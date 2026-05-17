// JS-API terminal that runs pipelined virtual shell commands
// against a `{ path: content }` source tree (the same shape stasis
// bundles ship; see ui/view/render-bundle.js). No I/O — purely
// in-memory; safe to use in either node or the browser. Caller
// hands in the source map; the returned terminal carries a mutable
// cwd across `run` calls.
//
//   import { createTerminal } from './terminal/index.js'
//   const term = createTerminal({ 'src/foo.js': '...', 'src/bar.js': '...' })
//   term.run('cd src')
//   term.run('cat foo.js | grep TODO | head -n 3')
//   term.run('ls /missing 2>/dev/null && echo ok || echo failed')
//   // → { stdout, stderr, exitCode, cwd }
//
// `run` parses the line into a sequence of steps separated by
// `&&` / `||` gates. Each step is a pipeline of stages (split on
// `|`) that may suppress stdout/stderr via `>/dev/null` and
// `2>/dev/null`. The final stage's exit code determines whether
// the next gated step runs.
//
// `(...)` subshells parse to a stage whose `group` is a nested
// step list. They run with an isolated cwd (snapshot/restore
// around the inner runSteps) so `(cd src; pwd)` reports `/src`
// without changing the outer terminal's cwd.

import { expandBraces } from './braces.js'
import { createFs, resolve } from './fs.js'
import { expandGlobs } from './glob.js'
import { NAV_COMMANDS } from './nav-commands.js'
import { parseLine } from './parse.js'
import { sed } from './sed.js'
import { TEXT_COMMANDS } from './text-commands.js'
import { err } from './util.js'

// `__proto__: null` so a user typing e.g. `toString` doesn't reach
// `Object.prototype.toString` through the prototype chain and have
// `dispatch()` accidentally call it. Spreading copies own enumerable
// properties only, so the registries contain exactly the names we
// registered — nothing inherited.
const COMMANDS = { __proto__: null, ...TEXT_COMMANDS, ...NAV_COMMANDS }
// Hidden registry — dispatchable by name (and via ctx.dispatch from
// xargs), but excluded from the "Available: …" hint so the
// commands here don't read as part of the documented surface.
// Anything in here is intentionally narrow / single-purpose.
const HIDDEN = { __proto__: null, sed }

const KNOWN = Object.keys(COMMANDS).sort().join(', ')

export function createTerminal(sources, opts = {}) {
  const fs = createFs(sources)
  // Normalize+absolutize the caller's cwd so `'src'` and `'/src/'`
  // both land on `/src` — otherwise the isDir check below trips
  // on the trailing slash / missing leading slash even when the
  // directory exists.
  const cwd = opts.cwd === undefined ? '/' : resolve('/', opts.cwd)
  const ctx = { cwd, fs }
  // Commands like `xargs` need to invoke other commands. Exposing
  // `dispatch` on ctx (rather than importing COMMANDS at the
  // command site) keeps the registry as the only place that knows
  // the full command set, and lets command modules stay free of
  // back-references into index.js.
  ctx.dispatch = (name, tokens, stdin) => dispatch(name, tokens, stdin, ctx)
  if (!fs.isDir(ctx.cwd)) throw new Error(`createTerminal: cwd is not a directory: ${ctx.cwd}`)
  return {
    run: (line) => safeRun(line, ctx),
    cwd: () => ctx.cwd,
  }
}

// Strip a leading `/bin/`, `/sbin/`, `/usr/bin/`, or `/usr/local/bin/`
// from `name` when the bare name resolves to a registered command.
// Matches what users with shell muscle memory tend to type —
// `/bin/ls`, `/usr/bin/grep`, `/usr/local/bin/node` — without
// exposing the virtual FS as a real PATH. If the stripped name
// isn't registered, fall through with the original so the
// not-found error reflects what was typed.
const BIN_PREFIXES = ['/usr/local/bin/', '/usr/bin/', '/bin/', '/sbin/']
function resolveCommand(name) {
  for (const prefix of BIN_PREFIXES) {
    if (name.startsWith(prefix)) {
      const stripped = name.slice(prefix.length)
      if (COMMANDS[stripped] || HIDDEN[stripped]) return stripped
    }
  }
  return name
}

function dispatch(name, tokens, stdin, ctx) {
  const resolved = resolveCommand(name)
  const cmd = COMMANDS[resolved] ?? HIDDEN[resolved]
  if (!cmd) return unknownCommand(name)
  try {
    return cmd(stdin, tokens, ctx)
  } catch (e) {
    return err(`${name}: ${e.message}`)
  }
}

function safeRun(line, ctx) {
  try {
    const trimmed = line.trim()
    if (trimmed === '') return { stdout: '', stderr: '', exitCode: 0, cwd: ctx.cwd }
    const steps = parseLine(trimmed)
    const r = runSteps(steps, ctx, '')
    return { ...r, cwd: ctx.cwd }
  } catch (e) {
    return { ...err(`error: ${e.message}`), cwd: ctx.cwd }
  }
}

// Loop the gated steps. The previous step's exit code controls
// whether the next runs (bash semantics: `&&` runs on 0, `||` runs
// on non-zero; `;` always runs, like `first`). Stdout/stderr from
// steps that DO run are concatenated; skipped steps contribute
// nothing. The overall exit code is from the LAST step that
// actually ran.
//
// `initialStdin` is only meaningful for subshell groups: when a
// `(...)` appears in a pipeline (`echo hi | (cat)`), the upstream
// output becomes the group's stdin and is delivered to the first
// step's pipeline. Later steps inside the group start with empty
// stdin, same as at top level.
function runSteps(steps, ctx, initialStdin) {
  let stdout = ''
  let stderr = ''
  let exitCode = 0
  let ran = false
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (step.gate === 'and' && exitCode !== 0) continue
    if (step.gate === 'or' && exitCode === 0) continue
    const r = runPipeline(step.stages, ctx, i === 0 ? initialStdin : '')
    stdout += r.stdout
    stderr += r.stderr
    exitCode = r.exitCode
    ran = true
  }
  // If no step ran (only possible from chains that start with a
  // skipped gate, which parseLine doesn't currently produce), keep
  // exitCode at 0 — same as bash's empty-list status.
  if (!ran) exitCode = 0
  return { stdout, stderr, exitCode }
}

function runPipeline(stages, ctx, initialStdin) {
  let stdin = initialStdin
  let stderr = ''
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]
    const result = stage.group ? runGroup(stage.group, ctx, stdin) : runStage(stage, ctx, stdin)
    // Apply redirects in a fixed order: fd-to-fd merges first, then
    // null sinks. This is bash's behavior for the common idioms
    // (`>/dev/null 2>&1` silences both, `2>&1 | grep` sees both
    // streams). Edge cases like `2>foo 2>&1` or `2>&1 >file` — where
    // bash's left-to-right fd semantics produce different results
    // depending on order — aren't modeled; the flag set is treated
    // as commutative.
    let stageOut = result.stdout
    let stageErr = result.stderr
    if (stage.mergeStderrToStdout) { stageOut += stageErr; stageErr = '' }
    if (stage.mergeStdoutToStderr) { stageErr += stageOut; stageOut = '' }
    if (stage.stdoutToNull) stageOut = ''
    if (stage.stderrToNull) stageErr = ''
    stderr += stageErr
    if (i === stages.length - 1) {
      return { stdout: stageOut, stderr, exitCode: result.exitCode }
    }
    // Mid-pipeline failure isn't fatal — real shells keep going and
    // surface the last stage's exit code. We do the same: feed
    // whatever stdout (often empty) into the next stage.
    stdin = stageOut
  }
  // Unreachable: stages is non-empty (parseLine guarantees it).
  return { stdout: '', stderr, exitCode: 0 }
}

function runStage(stage, ctx, stdin) {
  // Brace expansion FIRST (`{foo,bar}*.js` → `foo*.js bar*.js`),
  // then glob expansion against the FS. Quoted tokens and
  // argv[0] (the command name) pass through verbatim through
  // both phases — matching bash.
  const braced = expandBraces(stage.argv, stage.quoted ?? new Set())
  const expanded = expandGlobs(braced.argv, braced.quoted, ctx)
  return dispatch(expanded[0], expanded.slice(1), stdin, ctx)
}

// Subshell: snapshot the cwd, run the nested step list, restore.
// The try/finally keeps the restore safe across thrown errors
// (parse errors are caught earlier in safeRun, but a future
// command that throws raw would otherwise leak its cwd change).
function runGroup(steps, ctx, stdin) {
  const savedCwd = ctx.cwd
  try {
    return runSteps(steps, ctx, stdin)
  } finally {
    ctx.cwd = savedCwd
  }
}

function unknownCommand(name) {
  return err(`${name}: command not found. Available: ${KNOWN}`, 127)
}
