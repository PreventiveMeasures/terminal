// Builtins are shared; custom commands and completion order are per terminal.

import { defineCommands } from './custom.js'
import { EXTRA_COMMANDS, HIDDEN_EXTRAS } from './commands/extra.js'
import { NAV_COMMANDS } from './commands/nav.js'
import { cat } from './commands/cat.js'
import { sed } from './commands/sed.js'
import { bracket, test } from './commands/test.js'
import { markUnsupported, unsupported, unsupportedNote } from './unsupported.js'
import { SHELL_BUILTINS, SHELL_GAPS } from './shell/builtins.js'
import { TEXT_COMMANDS, TRIVIAL_COMMANDS } from './commands/text.js'

const VISIBLE_COMMANDS = { test, cat, ...TEXT_COMMANDS, ...NAV_COMMANDS, ...EXTRA_COMMANDS }
const grepAlias = (name, flag) => (stdin, tokens, ctx) => {
  const result = TEXT_COMMANDS.grep(stdin, [flag, ...tokens], ctx)
  const note = unsupportedNote(result)
  return note ? markUnsupported(result, note.kind, name, note.detail, note.message) : result
}
// Visibility affects completion and help; all commands share one lookup table.
// A null prototype prevents inherited names from becoming commands.
const BUILTIN_COMMANDS = { __proto__: null, sed, egrep: grepAlias('egrep', '-E'), fgrep: grepAlias('fgrep', '-F'), '[': bracket, ...HIDDEN_EXTRAS, ...TRIVIAL_COMMANDS, ...SHELL_BUILTINS, ...VISIBLE_COMMANDS }
const SHELL_ONLY = new Set(['cd', ':', ...Object.keys(SHELL_BUILTINS)])
const isBuiltin = (name) => Boolean(BUILTIN_COMMANDS[name])

// Priority for completion/help; unlisted builtins follow in sorted order.
const COMMAND_ORDER = [
  'ls', 'cd', 'cat', 'grep', 'find',
  'head', 'tail', 'wc', 'tree',
  'sort', 'uniq', 'cut', 'tr', 'awk', 'nl', 'tac', 'hexdump', 'base64',
  'xargs', 'echo', 'printf', 'test', 'cp', 'rm',
  'pwd', 'seq', 'which', 'basename', 'dirname',
]
const BUILTIN_NAMES = orderedCommandNames()

// Only commands that consume stdin are offered after a pipe.
const PIPE_NAMES = [
  'grep', 'head', 'tail', 'wc',
  'sort', 'uniq', 'cut', 'xargs', 'awk',
  'tr', 'nl', 'tac', 'hexdump', 'cat', 'base64',
]

function orderedCommandNames() {
  const remaining = new Set(Object.keys(VISIBLE_COMMANDS))
  const out = []
  for (const name of COMMAND_ORDER) {
    if (remaining.delete(name)) out.push(name)
  }
  out.push(...[...remaining].sort())
  return out
}

// Bin aliases resolve only registered names; missing commands retain the
// original path in their diagnostic.
const BIN_PREFIXES = Object.freeze(['/usr/local/bin/', '/usr/bin/', '/bin/', '/sbin/'])
function resolveCommand(name, has) {
  for (const prefix of BIN_PREFIXES) {
    if (name.startsWith(prefix)) {
      const stripped = name.slice(prefix.length)
      if (has(stripped)) return stripped
    }
  }
  return name
}

// Custom names follow builtins in registration order. Freeze shared lookup
// tables so one terminal or handler cannot alter another terminal's registry.
export function createRegistry(commands) {
  const custom = defineCommands(commands, isBuiltin)
  const handlers = Object.freeze({ __proto__: null, ...BUILTIN_COMMANDS, ...custom.handlers })
  const has = (name) => Boolean(handlers[name])
  const names = Object.freeze([...BUILTIN_NAMES, ...custom.names])
  return Object.freeze({
    commands: handlers,
    names,
    pipeNames: Object.freeze([...PIPE_NAMES, ...custom.pipeNames]),
    binPrefixes: BIN_PREFIXES,
    has,
    shellOnly: (name) => SHELL_ONLY.has(name),
    resolveCommand: (name) => resolveCommand(name, has),
    known: names.join(', '),
  })
}

// The no-wired-commands case is the common one and its registry is
// immutable, so build it once and share it across terminals.
export const DEFAULT_REGISTRY = createRegistry()

// Render unavailable command names using the same registry used for dispatch.
export function unknownCommand(name, reg) {
  const gap = SHELL_GAPS.get(name)
  if (gap !== undefined) return unsupported('feature', name, name, `${name}: ${gap}`, 127)
  return unsupported('command', name, name, `${name}: command not found. Available: ${reg.known}`, 127)
}
