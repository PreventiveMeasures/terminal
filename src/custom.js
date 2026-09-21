// Caller-provided commands. Handlers receive a limited I/O view, not the
// mutable execution context; malformed descriptors/results fail explicitly
// rather than becoming a successful command with missing output. A handler
// may answer with a promise, which the line waits for as it waits for any
// other command that has to.

import { lookup, resolve } from './fs.js'
import { consumeStdin, ok, readBytesOf, readInputs } from './util.js'
import { lookupWithNote } from './notes.js'

// Slash paths are reserved for bin aliases.
const NAME_RE = /^[a-zA-Z0-9][\w.+-]*$/u

// Reject misspelled descriptor fields instead of silently ignoring metadata.
const SPEC_KEYS = ['run', 'pipe', 'hidden']

const RESULT_KEYS = ['stdout', 'stderr', 'exitCode']

export function defineCommands(commands, isBuiltin) {
  const handlers = { __proto__: null }
  const names = []
  const pipeNames = []
  for (const [name, value] of commandEntries(commands)) {
    const { run, pipe, hidden: hide } = checkSpec(name, value, isBuiltin)
    // A Map-like iterator may repeat a name; visible registrations take priority.
    if (hide && names.includes(name)) continue
    handlers[name] = (stdin, tokens, ctx) => invoke(name, run, stdin, tokens, ctx)
    if (hide) continue
    names.push(name)
    // Visibility and pipeability affect completion, not dispatch.
    if (pipe) pipeNames.push(name)
  }
  return { handlers, names, pipeNames }
}

function commandEntries(commands) {
  if (commands === undefined || commands === null) return []
  // Object.entries would turn array indices into unintended command names.
  if (Array.isArray(commands)) {
    throw new TypeError('createTerminal: opts.commands must be an object or a Map (got an array)')
  }
  if (typeof commands !== 'object') {
    throw new TypeError(`createTerminal: opts.commands must be an object or a Map (got ${typeof commands})`)
  }
  // Cross-realm Maps fail instanceof; Object.entries would lose their entries.
  if (typeof commands.entries === 'function') return [...commands.entries()]
  // Prototype-owned commands would be silently lost by Object.entries.
  const proto = Object.getPrototypeOf(commands)
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError('createTerminal: opts.commands must be a plain object or a Map (own enumerable properties only)')
  }
  return Object.entries(commands)
}

// Validate wiring at construction, before a user tries to run the command.
function checkSpec(name, value, isBuiltin) {
  // Non-string Map keys cannot participate in command-name completion.
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
    // Metadata belongs on a descriptor, not properties of a bare handler.
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
  // Read once so stateful accessors cannot change the validated handler.
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

// Snapshot cwd for io.cwd, io.fs, and io.readInputs together: saved I/O views
// and reentrant handlers must not resolve paths against a later cwd.
function invoke(name, run, stdin, tokens, ctx) {
  ctx.io?.bufferOutput()
  // A wired command is handed its stdin outright, so it is taken to
  // have read it: the next command in a group starts at its end.
  consumeStdin(ctx)
  // Retained I/O views report notes to the run performing the operation.
  const scope = { cwd: ctx.cwd, fs: ctx.fs, mount: ctx.mount, home: ctx.home, get notes() { return ctx.notes }, command: name, stdinFile: ctx.stdinFile, stdinOrigin: ctx.stdinOrigin }
  const io = {
    name,
    args: tokens,
    stdin,
    cwd: scope.cwd,
    fs: fsView(scope),
    // Preserve partial reads and their errors. A string would otherwise be
    // treated as an iterable of individual path characters.
    readInputs: (paths = []) => {
      if (typeof paths === 'string') throw new TypeError(`readInputs: expected an array of paths, got a string: ${paths}`)
      return readInputs(name, [...paths], stdin, scope)
    },
  }
  // A handler is the one place a line is run from inside a line: what it
  // calls `run` for is part of the line that reached it, so that call runs
  // where it stands rather than waiting for the turn this one is holding.
  // The mark is held for as long as the handler is, promise and all.
  const holding = hold(ctx)
  let waiting = false
  try {
    const answer = run(io)
    // What a handler promises is what it answers: a line waits for it where
    // it stands, and a promise that fails fails the command, as a throw does.
    if (typeof answer?.then !== 'function') return normalizeResult(answer)
    waiting = true
    return answer.then(normalizeResult).finally(holding)
  } finally { if (!waiting) holding() }
}

// One mark, taken back once: a handler that answers at once gives it up where
// it returned, and one that waits gives it up where it settled.
function hold(ctx) {
  const lock = ctx.lock
  if (!lock) return () => {}
  lock.depth++
  return () => { lock.depth-- }
}

// Resolve against the captured cwd; copy listings to protect shared indexes.
function fsView(scope) {
  const at = (path) => lookup(scope.cwd, path, scope.fs).path
  return {
    resolve: (path) => resolve(scope.cwd, path),
    isFile: (path) => scope.fs.isFile(at(path)),
    isDir: (path) => scope.fs.isDir(at(path)),
    // A link is what it names everywhere else here, so asking whether a path
    // is one is asking about the name itself: it is looked up unfollowed.
    isLink: (path) => scope.fs.isLink?.(lookup(scope.cwd, path, scope.fs, { follow: false }).path) === true,
    readLink: (path) => scope.fs.readLink?.(lookup(scope.cwd, path, scope.fs, { follow: false }).path),
    readFile: (path) => scope.fs.readFile(at(path)),
    // A file may hold bytes that spell no text at all, which `readFile`
    // refuses as this terminal's own output would: a handler with something
    // to say about such a file asks whether it is one and reads its bytes.
    // The bytes are copied, as a listing is: this view is read-only, and what
    // a handler does with what it reads cannot reach the tree behind it.
    isBytes: (path) => scope.fs.isBytes?.(at(path)) === true,
    readBytes: (path) => readBytesOf(scope.fs, at(path))?.slice(),
    listDir: (path) => {
      const { path: abs, error } = lookupWithNote(scope, scope.command, path)
      // Report the original operand, distinguishing missing files from files
      // passed where a directory is required.
      if (!scope.fs.isDir(abs)) {
        throw new Error(`${path}: ${error ?? 'Not a directory'}`)
      }
      const { dirs, files, links = [] } = scope.fs.listDir(abs)
      return { dirs: [...dirs], files: [...files], links: [...links] }
    },
    walkFiles: (path) => [...scope.fs.walkFiles(at(path))],
  }
}

// Accept stdout strings, partial result objects, and nullish silent success.
function normalizeResult(result) {
  if (result === undefined || result === null) return ok()
  if (typeof result === 'string') return ok(result)
  if (typeof result !== 'object') {
    throw new TypeError(`invalid result: expected a string or an object (got ${typeof result})`)
  }
  if (Array.isArray(result)) {
    throw new TypeError('invalid result: expected a string or an object, got an array (join the lines first)')
  }
  // Empty or misspelled result objects must not silently succeed.
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
  // Keep stdout byte-exact; terminate stderr so consecutive errors don't fuse.
  return { stdout, stderr: stderr === '' || stderr.endsWith('\n') ? stderr : stderr + '\n', exitCode }
}
