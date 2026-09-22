// Builtins are shared; custom commands and completion order are per terminal.

import { defineCommands } from './custom.js'
import { EXTRA_COMMANDS, HIDDEN_EXTRAS, NETWORK_NAMES, networkState } from './commands/extra.js'
import { NAV_COMMANDS } from './commands/nav.js'
import { cat } from './commands/cat.js'
import { sed } from './commands/sed.js'
import { bracket, test } from './commands/test.js'
import { markUnsupported, unsupported, unsupportedNote } from './unsupported.js'
import { SHELL_BUILTINS, SHELL_GAPS } from './shell/builtins.js'
import { TEXT_COMMANDS, TRIVIAL_COMMANDS } from './commands/text.js'
import { quietSearch } from './commands/grep.js'

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

// Registered with the announced commands, and announced with the unannounced
// ones: a hint is for someone who has just been told a name is not a command,
// and splitting a path, making a link or writing a file is not what they were
// reaching for. What the list keeps is what someone looking around a tree
// reaches for.
const UNANNOUNCED_NAMES = new Set(['basename', 'cp', 'dirname', 'ln', 'mkdir', 'patch', 'rm', 'touch'])
const ANNOUNCED = Object.fromEntries(Object.entries(VISIBLE_COMMANDS).filter(([name]) => !UNANNOUNCED_NAMES.has(name)))

// Priority for completion/help; unlisted builtins follow in sorted order.
const COMMAND_ORDER = [
  'ls', 'cd', 'cat', 'grep', 'rg', 'find',
  'head', 'tail', 'wc', 'tree', 'du', 'stat', 'realpath',
  'sort', 'uniq', 'cut', 'tr', 'awk', 'nl', 'tac', 'hexdump', 'base64',
  'xargs', 'echo', 'printf', 'test', 'diff',
  'pwd', 'seq', 'which',
]
// Announced or not, a command is a command to complete: what a terminal
// offers is what it has, and the list in `command not found` is the shorter
// question of what it announces. The unannounced ones follow the announced,
// so a prefix both answer to offers the everyday one first. The shell's own
// builtins stay out of it: `cd` is announced with the rest, and the others
// are the shell's syntax rather than something a terminal hands out.
const UNANNOUNCED = Object.keys(BUILTIN_COMMANDS).filter((name) => !SHELL_ONLY.has(name) && !Object.hasOwn(ANNOUNCED, name)).sort()
// The unannounced readers, which belong after a pipe as the announced ones do.
const UNANNOUNCED_PIPE = new Set(['base32', 'brotli', 'egrep', 'fgrep', 'gunzip', 'gzcat', 'gzip', 'od', 'sed', 'sha1sum', 'sha256sum', 'sha384sum', 'sha512sum', 'shasum', 'xxd', 'zcat'])
const BUILTIN_NAMES = orderedCommandNames()

// Only commands that consume stdin are offered after a pipe.
const PIPE_NAMES = [
  'grep', 'head', 'tail', 'wc',
  'sort', 'uniq', 'cut', 'xargs', 'awk',
  'tr', 'nl', 'tac', 'hexdump', 'cat', 'base64', 'diff', 'patch',
]

function orderedCommandNames() {
  const remaining = new Set(Object.keys(ANNOUNCED))
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

// Chaining `&&` behind a command whose only product is a status is the idiom
// rather than an oversight, so a gate those close goes unremarked; a search
// asked for with -q says the same thing with a flag. Bin-prefixed spellings
// resolve first, so `/bin/false` is exempt for the reason `false` is.
const STATUS_ONLY = new Set(['test', '[', 'true', 'false'])
const SEARCHES = new Set(['grep', 'egrep', 'fgrep'])
function chainRole(argv, has) {
  const resolved = resolveCommand(argv[0], has)
  if (STATUS_ONLY.has(resolved)) return 'status'
  if (!SEARCHES.has(resolved)) return 'work'
  return quietSearch(argv.slice(1)) ? 'status' : 'search'
}

// Custom names follow builtins in registration order. Freeze shared lookup
// tables so one terminal or handler cannot alter another terminal's registry.
// A network asked for is one the runtime must also have: where it has no
// `fetch`, the commands that would use one stay out, as the compressors stay
// out of a runtime whose streams do not know their format.
export function createRegistry(commands, network = false) {
  const net = networkState(network)
  const networked = net.commands === null ? [] : NETWORK_NAMES
  const custom = defineCommands(commands, (name) => isBuiltin(name) || networked.includes(name))
  const handlers = Object.freeze({ __proto__: null, ...BUILTIN_COMMANDS, ...net.commands, ...custom.handlers })
  const has = (name) => Boolean(handlers[name])
  const names = Object.freeze([...BUILTIN_NAMES, ...networked, ...UNANNOUNCED, ...custom.names])
  return Object.freeze({
    commands: handlers,
    names,
    // Whether a network was asked for, and whether the runtime has one to
    // give: what a name that is missing because of it says it is missing for.
    network: Object.freeze({ asked: net.asked, usable: net.usable }),
    // `curl` reads stdin with `-d @-`, so it belongs after a pipe as readily
    // as it does in front of one.
    pipeNames: Object.freeze([...PIPE_NAMES, ...networked, ...UNANNOUNCED.filter((name) => UNANNOUNCED_PIPE.has(name)), ...custom.pipeNames]),
    binPrefixes: BIN_PREFIXES,
    has,
    shellOnly: (name) => SHELL_ONLY.has(name),
    resolveCommand: (name) => resolveCommand(name, has),
    chainRole: (argv) => chainRole(argv, has),
    // What the terminal says it has when a name is not one of them: the
    // commands it announces, which is not every command it answers to.
    known: [...BUILTIN_NAMES, ...networked, ...custom.names].join(', '),
  })
}

// The no-wired-commands case is the common one and its registry is
// immutable, so build it once and share it across terminals.
export const DEFAULT_REGISTRY = createRegistry()

// The same, for a terminal that asked for a network and wired no commands of
// its own: it needs no registry of its own either. Built the first time one
// is asked for, since most terminals never ask.
let NETWORK_REGISTRY = null
export const defaultRegistry = (network) => {
  if (!network) return DEFAULT_REGISTRY
  NETWORK_REGISTRY ??= createRegistry(undefined, true)
  return NETWORK_REGISTRY
}

// Render unavailable command names using the same registry used for dispatch.
export function unknownCommand(name, reg) {
  const gap = SHELL_GAPS.get(name)
  if (gap !== undefined) return unsupported('feature', name, name, `${name}: ${gap}`, 127)
  // A name that is missing for one reason and one reason only says that
  // reason, rather than sending someone to look for a spelling of it in a
  // list it was never going to be in. A bin-prefixed spelling of it is the
  // same name: nothing resolves one that is not registered, so it is read
  // here rather than left to the generic miss.
  const networked = NETWORK_NAMES.find((known) => name === known || BIN_PREFIXES.some((prefix) => name === prefix + known))
  if (networked !== undefined) return unsupported('feature', name, 'network', `${name}: ${networkGap(networked, reg)}`, 127)
  return unsupported('command', name, name, `${name}: command not found. Available: ${reg.known}`, 127)
}

const networkGap = (name, reg) => reg.network?.asked
  ? `this runtime has no \`fetch\`, so \`network: true\` has nothing to make a request with, and \`${name}\` is not here`
  : `this terminal has no network. \`createTerminal\` takes \`network: true\`, which is what puts \`${name}\` here`
