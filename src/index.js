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
// `opts.commands` wires in commands this package does not ship —
// `sha256sum` and friends, whose implementation would mean bundling
// a crypto library into a package that otherwise has no runtime
// dependencies. The caller supplies the handler, the engine supplies
// the shell around it (expansion, pipes, redirects, `&&` chains,
// completion, `which`). See custom.js for the handler contract.
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
//
// `for NAME in WORDS; do …; done` loops parse to a stage whose `loop`
// carries the name, the unexpanded word list and the nested body.
// The body runs once per word with `$NAME` bound — the only variables
// this shell has; there is no environment, and a `$name` nothing
// binds is left as typed. See runLoop.

import { expandBraces } from './braces.js'
import { createFs, resolve } from './fs.js'
import { expandGlobs } from './glob.js'
import { parseLine } from './parse.js'
import { DEFAULT_REGISTRY, createRegistry } from './registry.js'
import { splitRefs } from './tokenize.js'
import { err, ok } from './util.js'
import { complete } from './complete.js'

export function createTerminal(sources, opts = {}) {
  const fs = createFs(sources)
  // Normalize+absolutize the caller's cwd so `'src'` and `'/src/'`
  // both land on `/src` — otherwise the isDir check below trips
  // on the trailing slash / missing leading slash even when the
  // directory exists.
  const cwd = opts.cwd === undefined ? '/' : resolve('/', opts.cwd)
  // `user` is whoami's source of truth; default mirrors the home-dir
  // convention (`/home/user/...`). Surfacing as a plain ctx property
  // (not a getter) keeps the value snapshotted at terminal creation
  // — runtime swaps would need a new createTerminal call anyway.
  //
  // `registry` rides on ctx so the engine's step/pipeline/stage
  // functions — which already thread ctx everywhere — reach the
  // command set without a second parameter on each of them.
  const registry = opts.commands === undefined ? DEFAULT_REGISTRY : createRegistry(opts.commands)
  // `vars` holds the `for` bindings in scope — empty outside a loop.
  const ctx = { cwd, fs, user: opts.user ?? 'user', registry, vars: new Map() }
  // Commands like `xargs` need to invoke other commands. Exposing
  // `dispatch` on ctx (rather than reaching for the registry at the
  // command site) keeps lookup in one place, and lets command
  // modules stay free of back-references into index.js.
  ctx.dispatch = (name, tokens, stdin) => dispatch(name, tokens, stdin, ctx)
  // `which` looks up names against the registries to print a fake
  // `/usr/bin/<name>` path. Exposing a predicate (rather than the
  // registry object) keeps the command set out of the command modules.
  ctx.hasCommand = registry.has
  if (!fs.isDir(ctx.cwd)) throw new Error(`createTerminal: cwd is not a directory: ${ctx.cwd}`)
  return {
    run: (line) => safeRun(line, ctx),
    cwd: () => ctx.cwd,
    complete: (line) => complete(line, ctx, registry),
  }
}

function dispatch(name, tokens, stdin, ctx) {
  const reg = ctx.registry
  const resolved = reg.resolveCommand(name)
  const cmd = reg.commands[resolved] ?? reg.hidden[resolved]
  if (!cmd) return unknownCommand(name, reg)
  try {
    return cmd(stdin, tokens, ctx)
  } catch (e) {
    return err(`${name}: ${reason(e)}`)
  }
}

// The stderr text for a thrown value. Builtins only ever throw
// `Error`s, but `opts.commands` puts embedder code behind the same
// catch, where anything can come out: a bare `e.message` turns
// `throw 'oops'` into `name: undefined`, and on `throw null` the
// catch clause ITSELF throws — unwinding past the pipeline into
// safeRun, which discards stdout earlier steps already produced,
// skips the `||` gate that should have caught the failure, and
// reports an internal message with no command name in it.
function reason(e) {
  try {
    const message = e?.message
    return typeof message === 'string' && message !== '' ? message : String(e)
  } catch {
    return 'threw a value with no message'
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
// `initialStdin` is only meaningful for subshell groups and loop
// bodies: when a `(...)` or a `for` appears in a pipeline (`echo hi |
// (cat)`), the upstream output becomes the block's stdin and is
// delivered to the first step's pipeline (the first iteration's, for
// a loop). Later steps inside the block start with empty stdin, same
// as at top level.
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
    const result = stage.group ? runGroup(stage.group, ctx, stdin)
      : stage.loop ? runLoop(stage.loop, ctx, stdin)
      : runStage(stage, ctx, stdin)
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
  const expanded = expandWords(stage, ctx)
  // Every word expanded to nothing (`$c` with an empty binding): no
  // command at all, status 0, as in bash.
  if (expanded.length === 0) return ok()
  return dispatch(expanded[0], expanded.slice(1), stdin, ctx)
}

// Word expansion for a stage — or a loop's word list, which parse.js
// stores in the same shape — in bash's order: brace expansion on the
// text as typed (`{foo,bar}*.js` → `foo*.js bar*.js`), then variable
// substitution (`$f` → its binding, or left as typed when no enclosing
// `for` binds it), then globs against the FS. Braces first means a
// bound VALUE is never read as brace syntax (a file named `a{1,2}.txt`
// stays one word) while `src/$f.{h,c}` still multiplies. Quoted tokens
// and argv[0] (the command name) pass through the brace and glob
// phases verbatim, matching bash; a reference in argv[0] does
// substitute, so `for c in cat wc; do $c f; done` works. A bound value
// is substituted as ONE word, never split on whitespace (zsh's rule,
// not bash's).
function expandWords(stage, ctx) {
  const braced = expandBraces(stage.argv, stage.quoted)
  const substituted = substituteVars(braced, stage, ctx.vars)
  return expandGlobs(substituted.argv, substituted.quoted, ctx)
}

// Replace each `$NAME` reference with its binding. A word that brace
// expansion left untouched still matches the tokenizer's split for it
// (which also knows which `$` sat inside single quotes); a word it
// multiplied is re-split — `$f{a,b}` names `fa` and `fb`, as in bash.
// An unquoted word that comes out empty is dropped, as bash drops it:
// `$c` with an empty binding is no command at all, while `"$c"` stays
// an (empty) word. Dropping shifts positions, so `quoted` is rebuilt.
function substituteVars(braced, stage, vars) {
  if (stage.refs.size === 0 || vars.size === 0) return braced
  const argv = []
  const quoted = new Set()
  for (let j = 0; j < braced.argv.length; j++) {
    const i = braced.origin[j]
    const isQuoted = braced.quoted.has(j)
    let word = braced.argv[j]
    if (stage.refs.has(i)) {
      const parts = word === stage.argv[i] ? stage.refs.get(i) : splitRefs(word)
      word = parts.map((p) => typeof p === 'string' ? p : vars.get(p.name) ?? p.raw).join('')
      if (word === '' && !isQuoted) continue
    }
    if (isQuoted) quoted.add(argv.length)
    argv.push(word)
  }
  return { argv, quoted }
}

// `for NAME in WORDS; do BODY; done`. The word list expands when the
// loop runs — so `*.h` globs against the cwd at that moment, and an
// outer loop's variable is visible in an inner list — then the body
// runs once per word with NAME bound. Bindings are scoped to the body:
// the name means nothing after `done`, and an inner loop's binding
// never overwrites an outer one. Like bash, and unlike a subshell, the
// body shares the terminal's cwd, so a `cd` inside the loop is visible
// after it. Exit status is the last iteration's, or 0 when the list is
// empty; stdin, as for a group, reaches only the first step of the
// first iteration.
function runLoop(loop, ctx, stdin) {
  // Slot 0 is the `for` keyword parse.js parks in the command position.
  const values = expandWords(loop.words, ctx).slice(1)
  const saved = ctx.vars
  ctx.vars = new Map(saved)
  let stdout = ''
  let stderr = ''
  let exitCode = 0
  try {
    for (const [i, value] of values.entries()) {
      ctx.vars.set(loop.name, value)
      const r = runSteps(loop.body, ctx, i === 0 ? stdin : '')
      stdout += r.stdout
      stderr += r.stderr
      exitCode = r.exitCode
    }
  } finally {
    ctx.vars = saved
  }
  return { stdout, stderr, exitCode }
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

function unknownCommand(name, reg) {
  return err(`${name}: command not found. Available: ${reg.known}`, 127)
}
