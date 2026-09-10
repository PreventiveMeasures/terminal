import { UnsupportedError } from '../unsupported.js'
import { UNMODELED_VARIABLES } from './bindings.js'
import { expansionStderr } from './output.js'

const PROCESS_PARAMS = new Set(['$', '!', '0', '-', '_'])
const SHELL_STATE = new Set(['PPID', 'UID', 'EUID', 'BASHPID', 'BASH_SUBSHELL', 'BASH_VERSION', 'BASH_VERSINFO', 'BASH_REMATCH', 'DIRSTACK', 'PIPESTATUS', 'FUNCNAME', 'LINENO', 'REPLY', 'BASH', 'BASH_COMMAND', 'BASH_ARGV0', 'BASH_ARGC', 'BASH_ARGV', 'BASH_SOURCE', 'BASH_LINENO', 'BASH_ALIASES', 'BASH_CMDS', 'GROUPS', 'HOSTTYPE', 'OSTYPE', 'MACHTYPE', 'HOSTNAME', 'SHLVL', 'SHELL', 'TERM', 'PS4', 'OPTERR', 'HISTCMD', 'BASH_EXECUTION_STRING', 'BASH_LOADABLES_PATH', 'COMP_WORDBREAKS'])

// Presence is separate from value: defaults and -v must not treat an empty
// binding as unset or diagnose an ordinary missing variable while probing it.
export function probeParameter(name, ctx) {
  if (PROCESS_PARAMS.has(name) || UNMODELED_VARIABLES.has(name) || SHELL_STATE.has(name)) {
    throw new UnsupportedError('feature', `$${name}`, `shell parameter ${name} is not supported`)
  }
  return parameterValue(name, ctx) ?? { value: '', set: false }
}

function parameterValue(name, ctx) {
  if (name === '?') return { value: String(ctx.lastExit), set: true }
  if (name === '#') return { value: '0', set: true }
  if (name === '@') return { value: '', set: false, omit: true }
  if (name === '*') return { value: '', set: false }
  if (/^[1-9][0-9]*$/u.test(name)) return { value: '', set: false }
  if (ctx.vars.has(name)) return { value: ctx.vars.get(name), set: true }
  if (ctx.vars.unsetNames.has(name)) return { value: '', set: false }
  if (name === 'IFS') return { value: ' \t\n', set: true }
  if (name === 'PWD') return { value: ctx.cwd, set: true }
  if (name === 'HOME') return { value: ctx.home, set: true }
  if (name === 'USER' || name === 'LOGNAME') return { value: ctx.user, set: true }
  return null
}

// Process state has no value here and no honest substitute: `$$` is a pid,
// `$0` a shell name, `$-` the option flags. Leaving the text as typed put a
// note on the feed and still answered `$$` where bash answers a number, which
// is a wrong result wearing a diagnostic. Both entry points refuse now.
export function lookupParameter(name, ctx) {
  if (PROCESS_PARAMS.has(name)) {
    throw new UnsupportedError('feature', `$${name}`, `shell parameter ${name} is not supported (this terminal runs no process)`)
  }
  const found = parameterValue(name, ctx)
  if (found) return found
  report(ctx, `$${name}`, `warning: $${name} is unset (this shell has no environment variables; only \`for\` bindings and \`NAME=value\` assignments)`)
  return { value: '' }
}

function report(ctx, detail, message) {
  expansionStderr(ctx, message + '\n')
  ctx.unsupported.add({ kind: 'feature', command: null, detail, message })
}
