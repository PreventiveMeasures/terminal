// The command registry: the built-in command set, the orderings that
// drive tab completion and the "not found" hint, and the fold of the
// caller's wired-in commands over the top. Split out of index.js (the
// execution engine) because it is a different concern with a
// different lifetime — the built-in half is fixed at module load, the
// wired half is per-terminal — and because it is the one place that
// needs to know the full command set. index.js reaches it only
// through the object `createRegistry` returns.

import { defineCommands } from './custom.js'
import { EXTRA_COMMANDS, HIDDEN_EXTRAS } from './extra-commands.js'
import { NAV_COMMANDS } from './nav-commands.js'
import { sed } from './sed.js'
import { TEXT_COMMANDS, TRIVIAL_COMMANDS } from './text-commands.js'

// `__proto__: null` so a user typing e.g. `toString` doesn't reach
// `Object.prototype.toString` through the prototype chain and have
// `dispatch()` accidentally call it. Spreading copies own enumerable
// properties only, so the registries contain exactly the names we
// registered — nothing inherited.
const BUILTIN_COMMANDS = { __proto__: null, ...TEXT_COMMANDS, ...NAV_COMMANDS, ...EXTRA_COMMANDS }
// Hidden registry — dispatchable by name (and via ctx.dispatch from
// xargs), but excluded from the "Available: …" hint so the
// commands here don't read as part of the documented surface.
// `sed` is narrow/single-purpose; the TRIVIAL_COMMANDS (`true` /
// `false` / `:`) are dispatchable for pipeline-testing but too
// uninteresting to mention.
const BUILTIN_HIDDEN = { __proto__: null, sed, ...HIDDEN_EXTRAS, ...TRIVIAL_COMMANDS }
const isBuiltin = (name) => Boolean(BUILTIN_COMMANDS[name] || BUILTIN_HIDDEN[name])

// Command priority for tab completion and the "not found" hint —
// ordered for a code auditor: list & navigate, read, search, then
// downstream pipelines. `pwd` lands near the end because the prompt
// already tells you where you are; `seq` / `which` / `basename` /
// `dirname` rarely earn their slot in an audit session. Commands
// present in BUILTIN_COMMANDS but missing from this list fall through
// at the end alphabetically — a new command never silently drops out
// of completion if someone forgets to update the priority list.
const COMMAND_ORDER = [
  'ls', 'cd', 'cat', 'grep', 'find',
  'head', 'tail', 'wc', 'tree',
  'sort', 'uniq', 'cut', 'tr', 'nl', 'tac', 'hexdump',
  'xargs', 'echo',
  'pwd', 'seq', 'which', 'basename', 'dirname',
]
const BUILTIN_NAMES = orderedCommandNames()

// Pipe-target priority. After `|` the next command receives the
// previous stage's stdout as stdin — completing `... | ls` would
// be misleading since ls ignores its stdin. PIPE_NAMES is the
// hand-curated subset of BUILTIN_NAMES whose handlers actually
// read `stdin` (no `_stdin` underscore on their first param). No
// alphabetical fallback here: adding a pipeable command should be
// a deliberate decision, not a silent default.
const PIPE_NAMES = [
  'grep', 'head', 'tail', 'wc',
  'sort', 'uniq', 'cut', 'xargs',
  'tr', 'nl', 'tac', 'hexdump', 'cat',
]

function orderedCommandNames() {
  const remaining = new Set(Object.keys(BUILTIN_COMMANDS))
  const out = []
  for (const name of COMMAND_ORDER) {
    if (remaining.delete(name)) out.push(name)
  }
  out.push(...[...remaining].sort())
  return out
}

// Strip a leading `/bin/`, `/sbin/`, `/usr/bin/`, or `/usr/local/bin/`
// from `name` when the bare name resolves to a registered command.
// Matches what users with shell muscle memory tend to type —
// `/bin/ls`, `/usr/bin/grep`, `/usr/local/bin/node` — without
// exposing the virtual FS as a real PATH. If the stripped name
// isn't registered, fall through with the original so the
// not-found error reflects what was typed.
const BIN_PREFIXES = ['/usr/local/bin/', '/usr/bin/', '/bin/', '/sbin/']
function resolveCommand(name, reg) {
  for (const prefix of BIN_PREFIXES) {
    if (name.startsWith(prefix)) {
      const stripped = name.slice(prefix.length)
      if (reg.has(stripped)) return stripped
    }
  }
  return name
}

// Fold the caller's `opts.commands` into the builtins, producing the
// one object every lookup goes through: the two registry halves plus
// the derived views (`names` / `pipeNames` for completion, `known`
// for the not-found hint). It is per-TERMINAL rather than per-module
// because wired commands belong to the terminal they were passed to
// — two terminals in the same page must not see each other's.
//
// Wired names land AFTER the builtins, in registration order: the
// builtin ordering is hand-tuned for an auditor reading the hint,
// and interleaving someone's `sha256sum` into it alphabetically
// would scramble that for no gain. Registration order is also the
// one order the embedder actually chose.
export function createRegistry(commands) {
  const custom = defineCommands(commands, isBuiltin)
  const reg = {
    commands: { __proto__: null, ...BUILTIN_COMMANDS, ...custom.visible },
    hidden: { __proto__: null, ...BUILTIN_HIDDEN, ...custom.hidden },
    names: [...BUILTIN_NAMES, ...custom.names],
    pipeNames: [...PIPE_NAMES, ...custom.pipeNames],
    binPrefixes: BIN_PREFIXES,
  }
  reg.has = (name) => Boolean(reg.commands[name] || reg.hidden[name])
  reg.resolveCommand = (name) => resolveCommand(name, reg)
  reg.known = reg.names.join(', ')
  return reg
}

// The no-wired-commands case is the common one and its registry is
// immutable, so build it once and share it across terminals.
export const DEFAULT_REGISTRY = createRegistry()
