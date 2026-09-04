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
// Results are normalized on the way out for the same reason: a
// handler that forgets `stdout` would otherwise feed `undefined`
// into the next pipeline stage and surface as corrupt output far
// from its cause. Everything that can't be normalized throws, and
// `dispatch` turns the throw into a `name: message` stderr line —
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

// Nothing wired in — the common case, and the one shape every field
// below has to be safe to spread and iterate.
const EMPTY = {
  visible: { __proto__: null },
  hidden: { __proto__: null },
  names: [],
  pipeNames: [],
}

// Split `opts.commands` into the two registry halves registry.js
// merges with the builtins, plus the name lists that feed completion
// and the "Available: …" hint. `isBuiltin` is passed in rather than
// imported so the command set stays registry.js's business.
export function defineCommands(commands, isBuiltin) {
  if (commands === undefined || commands === null) return EMPTY
  if (typeof commands !== 'object') {
    throw new TypeError(`createTerminal: opts.commands must be an object or a Map (got ${typeof commands})`)
  }
  const entries = commands instanceof Map ? [...commands.entries()] : Object.entries(commands)
  const visible = { __proto__: null }
  const hidden = { __proto__: null }
  const names = []
  const pipeNames = []
  for (const [name, value] of entries) {
    const spec = checkSpec(name, value, isBuiltin)
    // Close over `spec.run` (not `value`) so a later mutation of the
    // caller's descriptor object can't swap the handler mid-session.
    const run = spec.run
    const handler = (stdin, tokens, ctx) => invoke(name, run, stdin, tokens, ctx)
    if (spec.hidden) { hidden[name] = handler; continue }
    visible[name] = handler
    names.push(name)
    // `pipe` only drives completion, and hidden commands are absent
    // from completion entirely — so it's meaningless there, exactly
    // as it is for the builtin `od` / `xxd` (pipeable, unlisted).
    if (spec.pipe) pipeNames.push(name)
  }
  return { visible, hidden, names, pipeNames }
}

// Validate one entry and normalize it to `{ run, pipe, hidden }`.
// Every failure throws from `createTerminal` rather than degrading
// at dispatch time: a typo'd descriptor is a wiring bug in the
// embedder's own code, and the useful moment to hear about it is
// when the terminal is built, not when a user happens to type the
// name.
function checkSpec(name, value, isBuiltin) {
  if (!NAME_RE.test(name)) {
    throw new Error(`createTerminal: invalid command name: ${JSON.stringify(name)}`)
  }
  if (isBuiltin(name)) {
    throw new Error(`createTerminal: ${name}: cannot redefine a built-in command`)
  }
  const spec = typeof value === 'function' ? { run: value } : value
  if (spec === null || typeof spec !== 'object') {
    throw new TypeError(`createTerminal: ${name}: expected a function or a { run } object`)
  }
  if (typeof spec.run !== 'function') {
    throw new TypeError(`createTerminal: ${name}: \`run\` must be a function`)
  }
  for (const key of Object.keys(spec)) {
    if (!SPEC_KEYS.includes(key)) {
      throw new Error(`createTerminal: ${name}: unknown option \`${key}\` (known: ${SPEC_KEYS.join(', ')})`)
    }
  }
  return { run: spec.run, pipe: Boolean(spec.pipe), hidden: Boolean(spec.hidden) }
}

// The per-invocation io object. `args` is post-expansion (braces and
// globs already applied, argv[0] stripped), so a wired command sees
// exactly what a builtin would. `cwd` is a snapshot: read-only by
// construction, since a wired command that could `cd` would move the
// terminal under the embedder without going through `run`.
function invoke(name, run, stdin, tokens, ctx) {
  const io = {
    name,
    args: tokens,
    stdin,
    cwd: ctx.cwd,
    fs: fsView(ctx),
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
      return readInputs(name, [...paths], stdin, ctx)
    },
  }
  return normalizeResult(run(io))
}

// Read-only, cwd-relative view of the virtual filesystem. The
// internal fs speaks absolute normalized paths only; resolving here
// means a handler can use the operands it was handed (`./a.txt`,
// `../b`) without knowing that. Directory listings and walks are
// copied out so a handler can't mutate the shared child index.
function fsView(ctx) {
  const at = (path) => resolve(ctx.cwd, path)
  return {
    resolve: at,
    isFile: (path) => ctx.fs.isFile(at(path)),
    isDir: (path) => ctx.fs.isDir(at(path)),
    readFile: (path) => ctx.fs.readFile(at(path)),
    listDir: (path) => {
      const { dirs, files } = ctx.fs.listDir(at(path))
      return { dirs: [...dirs], files: [...files] }
    },
    walkFiles: (path) => [...ctx.fs.walkFiles(at(path))],
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
  const { stdout = '', stderr = '', exitCode = 0 } = result
  if (typeof stdout !== 'string') throw new TypeError(`invalid result: stdout must be a string (got ${typeof stdout})`)
  if (typeof stderr !== 'string') throw new TypeError(`invalid result: stderr must be a string (got ${typeof stderr})`)
  if (!Number.isInteger(exitCode) || exitCode < 0) {
    throw new TypeError(`invalid result: exitCode must be a non-negative integer (got ${exitCode})`)
  }
  return { stdout, stderr, exitCode }
}
