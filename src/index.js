// JS-API terminal that runs pipelined virtual shell commands
// against a `{ path: content }` source tree (the same shape stasis
// bundles ship; see ui/view/render-bundle.js). No I/O — purely
// in-memory; safe to use in either node or the browser. Caller
// hands in the source map; the returned terminal carries a mutable
// cwd (and the shell variables) across `run` calls.
//
//   import { createTerminal } from './terminal/index.js'
//   const term = createTerminal({ 'src/foo.js': '...', 'src/bar.js': '...' })
//   term.run('cd src')
//   term.run('cat foo.js | grep TODO | head -n 3')
//   term.run('ls /missing 2>/dev/null && echo ok || echo failed')
//   // → { stdout, stderr, exitCode, cwd, unsupported }
//
// `unsupported` is the diagnostic channel: the gaps in THIS
// implementation — an unavailable command, an option we don't have —
// hit anywhere in the line. They still go to stderr, which is what an
// interactive user should see; the list is for callers driving the
// terminal programmatically, because stderr belongs to the command and
// so a redirect, a pipe, or a gate is free to discard it. See
// unsupported.js for the case that made the difference matter.
//
// `opts.commands` wires in commands this package does not ship —
// `sha256sum` and friends, whose implementation would mean bundling
// a crypto library into a package that otherwise has no runtime
// dependencies. The caller supplies the handler, the engine supplies
// the shell around it (expansion, pipes, redirects, `&&` chains,
// completion, `which`). See custom.js for the handler contract.
//
// `run` parses the line into a sequence of steps separated by
// `&&` / `||` / `;` gates. Each step is a pipeline of stages (split
// on `|`) with its redirects. The final stage's exit code determines
// whether the next gated step runs. Words are expanded when a stage
// runs (expand.js): braces, `~`, `$NAME`, globs.
//
// `(...)` subshells parse to a stage whose `group` is a nested step
// list, run with an isolated cwd and variable set; `{ ...; }` groups
// share both. `for NAME in WORDS; do …; done` loops parse to a stage
// whose `loop` carries the name, the unexpanded word list and the
// body; the variable persists after the loop, as in bash.

import { createFs, resolve } from './fs.js'
import { expandRedirect, expandScalar, expandWords } from './expand.js'
import { parseLine, refusedWrite } from './parse.js'
import { DEFAULT_REGISTRY, createRegistry } from './registry.js'
import { SHELL_GAPS } from './shell-builtins.js'
import { createUnsupportedFeed, unsupported, unsupportedNote } from './unsupported.js'
import { err, ok } from './util.js'
import { complete } from './complete.js'

export function createTerminal(sources, opts = {}) {
  const fs = createFs(sources)
  // Normalize+absolutize the caller's cwd so `'src'` and `'/src/'`
  // both land on `/src` — otherwise the isDir check below trips
  // on the trailing slash / missing leading slash even when the
  // directory exists.
  const cwd = opts.cwd === undefined ? '/' : resolve('/', opts.cwd)
  // `user` is whoami's source of truth. `home` is what `~`, `$HOME` and
  // a bare `cd` resolve to: the tree root, the one directory guaranteed
  // to exist. `vars` holds `for` bindings and `NAME=value` assignments;
  // `lastExit` is `$?`; `cd` keeps `OLDPWD` in `vars`, as bash does.
  //
  // `registry` rides on ctx so the engine's step/pipeline/stage
  // functions — which already thread ctx everywhere — reach the
  // command set without a second parameter on each of them.
  // `unsupported` is the run's diagnostic feed (see unsupported.js);
  // safeRun swaps in a fresh feed for the duration of each call.
  const registry = opts.commands === undefined ? DEFAULT_REGISTRY : createRegistry(opts.commands)
  const ctx = {
    cwd, fs, user: opts.user ?? 'user', home: '/', registry,
    vars: new Map(), lastExit: 0, loopDepth: 0,
    unsupported: createUnsupportedFeed(),
  }
  // Commands like `xargs` need to invoke other commands. Exposing
  // `dispatch` on ctx (rather than reaching for the registry at the
  // command site) keeps lookup in one place, and lets command
  // modules stay free of back-references into index.js.
  ctx.dispatch = (name, tokens, stdin) => dispatch(name, tokens, stdin, ctx)
  // `which` looks up names against the registries to print a fake
  // `/usr/bin/<name>` path.
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
  if (!cmd) return record(ctx, unknownCommand(name, reg), resolved)
  try {
    return record(ctx, cmd(stdin, tokens, ctx), resolved)
  } catch (e) {
    const message = `${name}: ${reason(e)}`
    const note = unsupportedNote(e)
    // A gap thrown out of shared arg parsing arrives incomplete:
    // parseArgs is handed tokens, never told whose they are, so it
    // cannot name the command or predict the stderr line its throw
    // turns into. Both are known here, and only here.
    if (note) ctx.unsupported.add({ ...note, command: note.command ?? name, message }, resolved)
    return err(message)
  }
}

// Copy a command's "not implemented here" note onto the run's feed.
// Every command lands here, including the ones reached through
// `ctx.dispatch` from `find -exec` and `xargs`, so a gap hit two levels
// down still reaches the caller. `resolved` is the bin-prefix-stripped
// name, used only to deduplicate.
function record(ctx, result, resolved) {
  const note = unsupportedNote(result)
  if (note) ctx.unsupported.add(note, resolved)
  return result
}

// The stderr text for a thrown value. Builtins only ever throw
// `Error`s, but `opts.commands` puts embedder code behind the same
// catch, where anything can come out: a bare `e.message` turns
// `throw 'oops'` into `name: undefined`, and on `throw null` the
// catch clause ITSELF throws.
function reason(e) {
  try {
    const message = e?.message
    return typeof message === 'string' && message !== '' ? message : String(e)
  } catch {
    return 'threw a value with no message'
  }
}

// The feed is swapped in and restored rather than reset, for the same
// reason runGroup save/restores the cwd: an embedder holding the
// terminal handle can call `run` again from inside a wired command.
// Syntax errors exit 2, as bash's do; a refused construct exits 1.
function safeRun(line, ctx) {
  const saved = ctx.unsupported
  const feed = createUnsupportedFeed()
  ctx.unsupported = feed
  try {
    const trimmed = line.trim()
    const r = trimmed === '' ? ok() : runSteps(parseLine(trimmed), ctx, '')
    return finish(r, ctx, feed)
  } catch (e) {
    const note = unsupportedNote(e)
    if (note) feed.add(note)
    ctx.lastExit = note ? 1 : 2
    return finish(err(`error: ${e.message}`, ctx.lastExit), ctx, feed)
  } finally {
    ctx.unsupported = saved
  }
}

// The RunResult, built field by field so the engine's own passengers
// (`halt`, `control`) never reach the caller. Freezing the list — and,
// in createUnsupportedFeed, each entry — keeps a run's report from being
// rewritten under a caller that passes it on.
const finish = (r, ctx, feed) => ({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, cwd: ctx.cwd, unsupported: Object.freeze(feed.entries) })

// Loop the gated steps. The previous step's exit code controls
// whether the next runs (bash semantics: `&&` runs on 0, `||` runs
// on non-zero; `;` always runs, like `first`). Stdout/stderr from
// steps that DO run are concatenated; skipped steps contribute
// nothing. The overall exit code is from the LAST step that
// actually ran, and `$?` tracks it step by step. An `exit`, or a
// `break` / `continue` bound for an enclosing loop, ends the list. `!`
// negates a status, but not the one an `exit` asked for: `! exit 3`
// exits 3, as in bash (a negated `break` does report 1, also as in
// bash).
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
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (step.gate === 'and' && exitCode !== 0) continue
    if (step.gate === 'or' && exitCode === 0) continue
    const r = runPipeline(step.stages, ctx, i === 0 ? initialStdin : '')
    stdout += r.stdout
    stderr += r.stderr
    exitCode = step.negate && !r.halt ? (r.exitCode === 0 ? 1 : 0) : r.exitCode
    ctx.lastExit = exitCode
    if (r.halt || r.control) return { stdout, stderr, exitCode, halt: r.halt, control: r.control }
  }
  return { stdout, stderr, exitCode }
}

// Each stage's output is routed by the redirects it carries: its
// stdout goes wherever fd 1 points after applying them left to right,
// its stderr wherever fd 2 points — the pipe / caller's stdout (`out`),
// the caller's stderr (`err`), or nowhere. The warnings raised while
// expanding its redirect operands are stderr text like any other (the
// diagnostic feed keeps its entry either way). Mid-pipeline failure isn't
// fatal — real shells keep going and surface the last stage's exit
// code. Every stage of a multi-stage pipeline runs in a subshell, as in
// bash: a `cd`, an assignment or an `exit` there reaches nothing
// outside it, and its `break` binds no enclosing loop.
function runPipeline(stages, ctx, initialStdin) {
  let stdin = initialStdin
  let stderr = ''
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]
    const io = resolveRedirs(stage, ctx, stdin)
    const run = () => (stage.group ? runGroup(stage, ctx, io.stdin) : stage.loop ? runLoop(stage.loop, ctx, io.stdin) : runStage(stage, ctx, io.stdin))
    const result = io.error ? io.error : stages.length > 1 ? isolated(ctx, run) : run()
    const errText = io.warnings + result.stderr
    let stageOut = ''
    let stageErr = ''
    if (io.fds[1] === 'out') stageOut += result.stdout
    else if (io.fds[1] === 'err') stageErr += result.stdout
    if (io.fds[2] === 'out') stageOut += errText
    else if (io.fds[2] === 'err') stageErr += errText
    stderr += stageErr
    if (i === stages.length - 1) {
      const r = { stdout: stageOut, stderr, exitCode: result.exitCode }
      if (stages.length === 1) { r.halt = result.halt; r.control = result.control }
      return r
    }
    stdin = stageOut
  }
  // Unreachable: stages is non-empty (parseLine guarantees it).
  return { stdout: '', stderr, exitCode: 0 }
}

// Apply a stage's redirects in order. `fds` maps fd 1 and 2 to where
// their text ends up; `stdin` is replaced by `<`, `<<` and `<<<`.
// Targets that needed expansion are checked here with the same rule
// parse.js applied to literal ones.
function resolveRedirs(stage, ctx, stdin) {
  const fds = { 1: 'out', 2: 'err' }
  const warnings = []
  let input = stdin
  for (const r of stage.redirs) {
    if (r.op === 'dup') fds[r.fd] = fds[r.toFd]
    else if (r.op === 'close') fds[r.fd] = 'null'
    else if (r.op === 'to') {
      const t = r.target === undefined ? expandRedirect(r.word, ctx, warnings) : { value: r.target }
      if (t.error) return { error: err(`error: ${t.error}`), fds, warnings: warnings.join('') }
      const dest = t.value === '/dev/null' ? 'null' : t.value === '/dev/stdout' ? fds[1] : t.value === '/dev/stderr' ? fds[2] : null
      if (dest === null) {
        const e = refusedWrite(r.label, t.value)
        ctx.unsupported.add(unsupportedNote(e))
        return { error: err(`error: ${e.message}`), fds, warnings: warnings.join('') }
      }
      fds[r.fd] = dest
      if (r.both) fds[2] = dest
    } else if (r.op === 'text') input = r.expand ? expandScalar(heredocWord(r.body), ctx, warnings) : r.body
    // A here-string is expanded but neither split nor globbed (bash).
    else if (r.op === 'herestring') input = expandScalar(r.word, ctx, warnings) + '\n'
    else {
      const t = expandRedirect(r.word, ctx, warnings)
      const read = t.error ? { error: err(`error: ${t.error}`) } : readInput(t.value, ctx, stdin)
      if (read.error) return { error: read.error, fds, warnings: warnings.join('') }
      input = read.content
    }
  }
  return { fds, stdin: input, warnings: warnings.join('') }
}

// An unquoted here-document body: `$NAME` expands, `\$` `\\` and
// `` \` `` are escapes, `\<newline>` joins two lines, nothing else is
// special — the double-quote rules, minus the quotes.
function heredocWord(body) {
  let value = ''
  let mask = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    const n = body[i + 1]
    if (c === '\\' && n === '\n') { i++; continue }
    if (c === '\\' && (n === '$' || n === '\\' || n === '`')) { value += n; mask += '1'; i++; continue }
    value += c
    mask += '2'
  }
  return { value, mask }
}

// `< path`: the file's content as stdin. The two device names bash
// scripts reach for are honored; a directory or a missing path is the
// error bash gives, and the command does not run.
function readInput(path, ctx, stdin) {
  if (path === '/dev/null') return { content: '' }
  if (path === '/dev/stdin') return { content: stdin }
  const abs = resolve(ctx.cwd, path)
  if (ctx.fs.isFile(abs)) return { content: ctx.fs.readFile(abs) }
  return { error: err(`error: ${path}: ${ctx.fs.isDir(abs) ? 'Is a directory' : 'No such file or directory'}`) }
}

// A simple command: expand the words, then either dispatch argv[0] or,
// when nothing but assignments remains, perform them. Assignments in
// front of a command would scope to that command's environment, which
// no command here reads, so they are dropped — exactly what a user
// sees from `x=1 echo $x` in bash, where `$x` expands before `x` is
// set. Every word expanding to nothing (`$c` with an empty binding) is
// no command at all, status 0, as in bash.
function runStage(stage, ctx, stdin) {
  const { argv, stderr } = expandWords(stage.words, ctx)
  if (argv.length === 0) {
    const warnings = []
    for (const a of stage.assigns) ctx.vars.set(a.name, expandScalar(a.word, ctx, warnings, true))
    return { stdout: '', stderr: stderr + warnings.join(''), exitCode: 0 }
  }
  const r = dispatch(argv[0], argv.slice(1), stdin, ctx)
  return stderr === '' ? r : { ...r, stderr: stderr + r.stderr }
}

// `for NAME in WORDS; do BODY; done`. The word list expands when the
// loop runs — so `*.h` globs against the cwd at that moment, and an
// outer loop's variable is visible in an inner list — then the body
// runs once per word with NAME bound. The binding outlives the loop
// (`echo $f` after `done` prints the last value) and the body shares
// the terminal's cwd, both as in bash. Exit status is the last
// iteration's, or 0 when the list is empty; stdin, as for a group,
// reaches only the first step of the first iteration. `break` ends the
// loop, `continue` the iteration, `exit` everything.
function runLoop(loop, ctx, stdin) {
  // Slot 0 is the `for` keyword parse.js parks in the command position.
  const expanded = expandWords(loop.words, ctx)
  const values = expanded.argv.slice(1)
  let stdout = ''
  let stderr = expanded.stderr
  let exitCode = 0
  ctx.loopDepth++
  try {
    for (const [i, value] of values.entries()) {
      ctx.vars.set(loop.name, value)
      const r = runSteps(loop.body, ctx, i === 0 ? stdin : '')
      stdout += r.stdout
      stderr += r.stderr
      exitCode = r.exitCode
      if (r.halt) return { stdout, stderr, exitCode, halt: true }
      if (r.control === 'break') break
    }
  } finally {
    ctx.loopDepth--
  }
  return { stdout, stderr, exitCode }
}

// A subshell: an `exit` or a `break` inside it ends the subshell alone.
// A `{ … }` group shares everything, so its signals travel on.
function runGroup(stage, ctx, stdin) {
  if (!stage.isolate) return runSteps(stage.group, ctx, stdin)
  const r = isolated(ctx, () => runSteps(stage.group, ctx, stdin))
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }
}

// Run `fn` as a subshell would: on a copy of the variables (`OLDPWD`
// among them), with the working directory and `$?` put back afterwards
// — every stage of `false; { true; } | echo $?` sees the status from
// before the pipeline, as in bash; the caller records the pipeline's
// own status once it returns. The try/finally keeps the restore safe
// across thrown errors.
function isolated(ctx, fn) {
  const saved = { cwd: ctx.cwd, lastExit: ctx.lastExit, vars: ctx.vars }
  ctx.vars = new Map(saved.vars)
  try {
    return fn()
  } finally {
    ctx.cwd = saved.cwd
    ctx.lastExit = saved.lastExit
    ctx.vars = saved.vars
  }
}

// `command` and `detail` coincide here — the name as typed is both who
// failed and what was missing — which keeps the entry shape uniform
// across all three kinds rather than leaving a hole for this one.
function unknownCommand(name, reg) {
  const gap = SHELL_GAPS.get(name)
  if (gap !== undefined) return unsupported('feature', name, name, `${name}: ${gap}`, 127)
  return unsupported('command', name, name, `${name}: command not found. Available: ${reg.known}`, 127)
}
