// Caller-supplied commands — the `opts.commands` wiring point.
//
// The builtin set is deliberately self-contained: no dependencies,
// no I/O, nothing platform-specific. That rules out a whole class of
// commands an embedder still wants, and `sha256sum` / `shasum` are
// the motivating case — hashing needs a crypto implementation, and
// this package has no business bundling one (or picking which
// algorithms, and which runtime's API to speak). The embedder
// already has one. So they hand in the handler and we supply the
// shell around it: tokenizing, brace/glob expansion, pipes,
// redirects, `&&` chains, `xargs`, completion, `which`.
//
//   // `sha256hex` is the host's — a crypto module, a hash library,
//   // whatever the embedder already ships. This package stays
//   // crypto-free.
//   const term = createTerminal(sources, {
//     commands: {
//       sha256sum: {
//         pipe: true,
//         run: ({ args, readInputs }) => {
//           const r = readInputs(args)
//           const lines = r.inputs.map((i) => `${sha256hex(i.content)}  ${i.name ?? '-'}\n`)
//           return { stdout: lines.join(''), stderr: r.stderr, exitCode: r.failed ? 1 : 0 }
//         },
//       },
//     },
//   })
//
// A handler receives an `io` object rather than the internal
// `(stdin, tokens, ctx)` triple the builtins take. `ctx` carries
// engine internals — the raw path-indexed fs, `dispatch`, the
// registry itself — that are not a contract anyone outside `src/`
// should build on, and handing out a mutable `ctx.cwd` would let a
// wired command move the terminal underneath the caller. The io
// object is the part that IS a contract.
//
// Results are normalized on the way out for the same reason, and
// strictly. A handler one `.join('')` short of a string returns an
// array; a lenient destructure would read that as `stdout: ''` and
// report a successful command that printed nothing, with the cause
// nowhere near the symptom. So anything that isn't a result throws,
// and `dispatch` turns the throw into a `name: reason` stderr line —
// the same treatment a builtin's internal error gets.

import { resolve } from './fs.js'
import { ok, readInputs } from './util.js'

// A wired name has to survive the tokenizer and the dispatcher:
// whitespace or shell punctuation could never be typed as a command,
// `/` collides with the bin-prefix mapping, and a leading `-` would
// parse as a flag. Requiring a leading letter or digit also keeps
// `__proto__` and friends out of the registries, so the "dispatch
// can't reach Object.prototype members" property holds for wired
// commands exactly as it does for builtins.
const NAME_RE = /^[a-zA-Z0-9][\w.+-]*$/u

// Descriptor keys, checked strictly. `parseArgs` rejects unknown
// options for the same reason: a silently ignored `hide: true` (for
// `hidden`) looks like it worked, and the command shows up in
// completion anyway with nothing to explain why.
const SPEC_KEYS = ['run', 'pipe', 'hidden']

// The fields a handler's result object may carry, checked just as
// strictly and for the same reason.
const RESULT_KEYS = ['stdout', 'stderr', 'exitCode']

// Split `opts.commands` into the two registry halves registry.js
// merges with the builtins, plus the name lists that feed completion
// and the "Available: …" hint. `isBuiltin` is passed in rather than
// imported so the command set stays registry.js's business.
export function defineCommands(commands, isBuiltin) {
  const visible = { __proto__: null }
  const hidden = { __proto__: null }
  const names = []
  const pipeNames = []
  for (const [name, value] of commandEntries(commands)) {
    const { run, pipe, hidden: hide } = checkSpec(name, value, isBuiltin)
    const handler = (stdin, tokens, ctx) => invoke(name, run, stdin, tokens, ctx)
    if (hide) { hidden[name] = handler; continue }
    visible[name] = handler
    names.push(name)
    // `pipe` only drives completion, and hidden commands are absent
    // from completion entirely — so it's meaningless there, exactly
    // as it is for the builtin `od` / `xxd` (pipeable, unlisted).
    if (pipe) pipeNames.push(name)
  }
  return { visible, hidden, names, pipeNames }
}

// `[name, descriptor]` pairs out of whatever the caller passed. Every
// rejected shape here is one that would otherwise construct a working
// terminal with the commands silently missing or misnamed, and the
// embedder's first symptom would be `sha256sum: command not found`
// long after the wiring bug.
function commandEntries(commands) {
  if (commands === undefined || commands === null) return []
  // An array reaches `Object.entries` as index keys, and `0` is a
  // legal command name (`7z` is why names may start with a digit), so
  // `commands: [spec]` would quietly register a command called `0`.
  if (Array.isArray(commands)) {
    throw new TypeError('createTerminal: opts.commands must be an object or a Map (got an array)')
  }
  if (typeof commands !== 'object') {
    throw new TypeError(`createTerminal: opts.commands must be an object or a Map (got ${typeof commands})`)
  }
  // Duck-typed rather than `instanceof Map`: a Map built in another
  // realm — an iframe, a worker, a second copy of the bundle — fails
  // `instanceof`, and `Object.entries` of a Map is `[]`, so the strict
  // test would hand back a terminal with nothing wired into it.
  if (typeof commands.entries === 'function') return [...commands.entries()]
  // Anything else has to be a plain data object: a class instance or
  // an `Object.create(handlers)` keeps its commands on the prototype,
  // where `Object.entries` cannot see them.
  const proto = Object.getPrototypeOf(commands)
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError('createTerminal: opts.commands must be a plain object or a Map (own enumerable properties only)')
  }
  return Object.entries(commands)
}

// Validate one entry and normalize it to `{ run, pipe, hidden }`.
// Every failure throws from `createTerminal` rather than degrading
// at dispatch time: a typo'd descriptor is a wiring bug in the
// embedder's own code, and the useful moment to hear about it is
// when the terminal is built, not when a user happens to type the
// name.
function checkSpec(name, value, isBuiltin) {
  // A Map takes any key. A non-string one string-coerces through
  // NAME_RE and then reaches `reg.names`, where completion — which
  // has no error boundary, unlike `run()` — would call `.startsWith`
  // on it and throw into the embedder's keystroke handler.
  if (typeof name !== 'string') {
    throw new TypeError(`createTerminal: command names must be strings (got ${typeof name})`)
  }
  if (!NAME_RE.test(name)) {
    throw new Error(`createTerminal: invalid command name: ${JSON.stringify(name)}`)
  }
  if (isBuiltin(name)) {
    throw new Error(`createTerminal: ${name}: cannot redefine a built-in command`)
  }
  if (typeof value === 'function') {
    // The bare-function form carries no metadata, so `pipe`/`hidden`
    // hung on the function itself (`Object.assign(fn, { pipe: true })`)
    // would be dropped in silence — the command missing from
    // completion with nothing to explain why.
    for (const key of Object.keys(value)) {
      if (SPEC_KEYS.includes(key)) {
        throw new Error(`createTerminal: ${name}: \`${key}\` belongs on a { run } descriptor, not on the handler function`)
      }
    }
    return { run: value, pipe: false, hidden: false }
  }
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`createTerminal: ${name}: expected a function or a { run } object`)
  }
  // Read `run` ONCE. An accessor (or a Proxy) that answers differently
  // on a second read would otherwise pass this check with a function
  // and have something else stored — deferring the failure to dispatch
  // time, which is what this function exists to prevent.
  const run = value.run
  if (typeof run !== 'function') {
    throw new TypeError(`createTerminal: ${name}: \`run\` must be a function`)
  }
  for (const key of Object.keys(value)) {
    if (!SPEC_KEYS.includes(key)) {
      throw new Error(`createTerminal: ${name}: unknown option \`${key}\` (known: ${SPEC_KEYS.join(', ')})`)
    }
  }
  return { run, pipe: Boolean(value.pipe), hidden: Boolean(value.hidden) }
}

// The per-invocation io object. `args` is post-expansion (braces and
// globs already applied, argv[0] stripped), so a wired command sees
// exactly what a builtin would. `cwd` is a snapshot: read-only by
// construction, since a wired command that could `cd` would move the
// terminal under the embedder without going through `run`.
//
// That snapshot is taken ONCE and `io.fs` / `io.readInputs` resolve
// against it rather than against the live `ctx.cwd`, so the three can
// never disagree — a handler that keeps its `io` past a later `cd`,
// or that re-enters `run()` through the terminal handle the embedder
// holds, would otherwise read `io.cwd` as one directory while
// resolving its operands in another.
function invoke(name, run, stdin, tokens, ctx) {
  const scope = { cwd: ctx.cwd, fs: ctx.fs }
  const io = {
    name,
    args: tokens,
    stdin,
    cwd: scope.cwd,
    fs: fsView(scope),
    // The coreutils partial-failure model, shared with cat/head/wc:
    // read every path you can, collect one stderr line per failure,
    // and report `failed` so the caller can exit non-zero while
    // still emitting the files that did read. An empty list means
    // "no file operands" and yields a single nameless input carrying
    // stdin — the convention every filter in this registry follows.
    // A bare string is rejected rather than spread into one input per
    // CHARACTER, which would otherwise surface as five bogus "no such
    // file" lines for `readInputs(args[0])`.
    readInputs: (paths = []) => {
      if (typeof paths === 'string') throw new TypeError(`readInputs: expected an array of paths, got a string: ${paths}`)
      return readInputs(name, [...paths], stdin, scope)
    },
  }
  return normalizeResult(run(io))
}

// Read-only, cwd-relative view of the virtual filesystem. The
// internal fs speaks absolute normalized paths only; resolving here
// means a handler can use the operands it was handed (`./a.txt`,
// `../b`) without knowing that. Directory listings and walks are
// copied out so a handler can't mutate the shared child index.
function fsView(scope) {
  const at = (path) => resolve(scope.cwd, path)
  return {
    resolve: at,
    isFile: (path) => scope.fs.isFile(at(path)),
    isDir: (path) => scope.fs.isDir(at(path)),
    readFile: (path) => scope.fs.readFile(at(path)),
    listDir: (path) => {
      const abs = at(path)
      // The one view method that can fail, so it fails in the shape
      // every builtin uses — `operand: reason`, naming the operand as
      // typed. createFs's own throw says "not a directory" even for a
      // path that isn't there, and quotes the resolved absolute form
      // of an operand the user wrote relatively.
      if (!scope.fs.isDir(abs)) {
        throw new Error(`${path}: ${scope.fs.isFile(abs) ? 'not a directory' : 'no such file or directory'}`)
      }
      const { dirs, files } = scope.fs.listDir(abs)
      return { dirs: [...dirs], files: [...files] }
    },
    walkFiles: (path) => [...scope.fs.walkFiles(at(path))],
  }
}

// Accepted shapes: a string (stdout, exit 0), a partial
// `{ stdout, stderr, exitCode }`, or nothing at all (a silent
// success, so `run() {}` is a working no-op). Anything else is a
// wiring bug worth an error rather than a coerced value.
function normalizeResult(result) {
  if (result === undefined || result === null) return ok()
  if (typeof result === 'string') return ok(result)
  if (typeof result !== 'object') {
    throw new TypeError(`invalid result: expected a string or an object (got ${typeof result})`)
  }
  // A promise is the one wrong shape worth naming: the whole engine
  // is synchronous — a pipeline stage's stdout is the next stage's
  // stdin, immediately — so an `async run` (or a WebCrypto-style
  // digest returning a promise) has no join point. Without this the
  // promise would stringify into the stream as `[object Promise]`.
  if (typeof result.then === 'function') {
    throw new TypeError('invalid result: commands are synchronous, a promise cannot be awaited')
  }
  if (Array.isArray(result)) {
    throw new TypeError('invalid result: expected a string or an object, got an array (join the lines first)')
  }
  // The descriptor rule, applied to results: an object carrying none
  // of these fields is a mistake, not an empty success. Without the
  // check, one forgotten `.join('')` — an array of output lines, a
  // hash digest still in binary form, a `{ out: … }` typo — reads as
  // exit 0 with no output and nothing on stderr to explain it.
  const keys = Object.keys(result)
  for (const key of keys) {
    if (!RESULT_KEYS.includes(key)) {
      throw new TypeError(`invalid result: unknown field \`${key}\` (known: ${RESULT_KEYS.join(', ')})`)
    }
  }
  if (keys.length === 0) {
    throw new TypeError(`invalid result: an object with none of ${RESULT_KEYS.join(', ')} — return a string for plain output`)
  }
  const { stdout = '', stderr = '', exitCode = 0 } = result
  if (typeof stdout !== 'string') throw new TypeError(`invalid result: stdout must be a string (got ${typeof stdout})`)
  if (typeof stderr !== 'string') throw new TypeError(`invalid result: stderr must be a string (got ${typeof stderr})`)
  if (!Number.isInteger(exitCode) || exitCode < 0) {
    throw new TypeError(`invalid result: exitCode must be a non-negative integer (got ${exitCode})`)
  }
  // The trailing-newline rule util.js's `err` applies to every builtin
  // holds for wired stderr too, or the next error line fuses onto the
  // end of this one. stdout is left exactly as returned — `head -c`
  // shows that a command may legitimately end mid-line.
  return { stdout, stderr: stderr === '' || stderr.endsWith('\n') ? stderr : stderr + '\n', exitCode }
}
