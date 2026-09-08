// Builtins may return halt/control for the execution engine; index.js removes
// these internal fields before exposing results. Registered overrides win.

import { err, ok } from '../util.js'
import { unsupported } from '../unsupported.js'
import { NAME_RE } from './lex.js'

// Bash accepts signed 64-bit control counts. Exit status wraps modulo 256;
// malformed exit numbers take precedence over excess-argument errors.
// Subshell/pipeline boundaries consume halt without stopping the outer shell.
const INT64_MAX = 9223372036854775807n
const INT64_MIN = -9223372036854775808n

function controlNumber(value) {
  const arg = value.replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/gu, '')
  const parsed = /^[+-]?\d+$/u.test(arg) ? BigInt(arg) : null
  const n = parsed !== null && parsed >= INT64_MIN && parsed <= INT64_MAX ? parsed : null
  return { arg, n }
}

const halt = (result) => ({ ...result, halt: true })

function exit(_stdin, tokens, ctx) {
  const args = tokens[0] === '--' ? tokens.slice(1) : tokens
  if (args.length === 0) return halt({ ...ok(), exitCode: ctx.lastExit })
  const { arg, n } = controlNumber(args[0])
  if (n === null) {
    return halt(err(`exit: ${arg}: numeric argument required`, 2))
  }
  if (args.length > 1) return halt(err('exit: too many arguments'))
  return halt({ ...ok(), exitCode: Number(((n % 256n) + 256n) % 256n) })
}

// `break` / `continue` end or skip the current iteration of the
// enclosing `for`, or N enclosing loops. A subshell starts with no
// enclosing loops; outside any loop Bash only warns, and so does this.
function loopControl(name) {
  return (_stdin, tokens, ctx) => {
    const args = tokens[0] === '--' ? tokens.slice(1) : tokens
    if (args.length > 1) return halt(err(`${name}: too many arguments`))
    const { arg, n } = controlNumber(args[0] ?? '1')
    if (n === null) return halt(err(`${name}: ${arg}: numeric argument required`, 128))
    if (n <= 0) return { ...err(`${name}: ${arg}: loop count out of range`), control: ctx.loopDepth ? { type: 'break', levels: ctx.loopDepth } : undefined }
    if (ctx.loopDepth === 0) return err(`${name}: only meaningful in a \`for\` loop`, 0)
    return { ...ok(), control: { type: name, levels: Number(n > BigInt(ctx.loopDepth) ? BigInt(ctx.loopDepth) : n) } }
  }
}

// Rebinding matters: x=2 export x persists the prefix assignment. A bare
// export name only rebinds an existing value; it does not invent one.
function exportCmd(_stdin, tokens, ctx) {
  // `--` ends option processing, as `help export` says: everything after
  // it is a name, so `export -- -p` is an invalid identifier rather than
  // the listing option, and `export --` alone still lists.
  const terminated = tokens[0] === '--'
  const operands = terminated ? tokens.slice(1) : tokens
  if (operands.length === 0 || (!terminated && operands[0] === '-p')) return unsupported('option', 'export', '-p', 'export: listing the environment is not supported (there is none)')
  let stderr = ''
  for (const t of operands) {
    const eq = t.indexOf('=')
    const append = eq > 0 && t[eq - 1] === '+'
    const name = eq === -1 ? t : t.slice(0, append ? eq - 1 : eq)
    if (!terminated && t.startsWith('-')) return unsupported('option', 'export', t, `export: option \`${t}\` is not supported`)
    if (!NAME_RE.test(name)) { stderr += `export: \`${name}': not a valid identifier\n`; continue }
    if (eq !== -1) ctx.vars.set(name, (append ? ctx.vars.get(name) ?? '' : '') + t.slice(eq + 1))
    else if (ctx.vars.has(name)) ctx.vars.set(name, ctx.vars.get(name))
  }
  return { stdout: '', stderr, exitCode: stderr ? 1 : 0 }
}

function unset(_stdin, tokens, ctx) {
  let start = tokens[0] === '-v' ? 1 : 0
  const terminated = tokens[start] === '--'
  if (terminated) start++
  const operands = tokens.slice(start)
  for (const t of operands) {
    if (!terminated && t.startsWith('-')) return unsupported('option', 'unset', t, `unset: option \`${t}\` is not supported`)
    if (t.includes('[')) return unsupported('feature', 'unset', 'array subscript', 'unset: array subscripts are not supported')
    ctx.vars.delete(t)
  }
  return ok()
}

export const SHELL_BUILTINS = {
  exit, break: loopControl('break'), continue: loopControl('continue'), export: exportCmd, unset,
}

// Diagnose unavailable shell machinery after checking registered overrides.
// Entries hold a name, optional explanation suffix, and optional display label.
export const SHELL_GAPS = new Map([
  ['return', ' (there are no shell functions)'],
  ['source', ' (nothing can be sourced into this shell)'],
  ['.', '', '`.` (source)'],
  'eval',
  'exec',
  ['read', ' (there is no interactive input)'],
  ['shift', ' (there are no positional parameters)'],
  'set',
  'shopt',
  ['local', ' (there are no shell functions)'],
  ['declare', '; use `NAME=value`'],
  ['typeset', '; use `NAME=value`'],
  ['readonly', '; use `NAME=value`'],
  ['let', ' (no arithmetic)'],
  ['test', '; gate on a command\'s exit status instead'],
  ['[', '; gate on a command\'s exit status instead', '`[ … ]`'],
  ['printf', '; use `echo` (with `-e` for escapes)'],
  ['type', '; use `which`'],
  ['command', '; run the command directly'],
  'builtin',
  'hash',
  'alias',
  'unalias',
  'trap',
  ['wait', ' (nothing runs in the background)'],
  ['kill', ' (there are no processes)'],
  ['jobs', ' (there are no processes)'],
  ['bg', ' (there are no processes)'],
  ['fg', ' (there are no processes)'],
  ['disown', ' (there are no processes)'],
  'suspend',
  'times',
  'ulimit',
  'umask',
  ['pushd', '; use `cd`'],
  ['popd', '; use `cd -`'],
  'dirs',
  'history',
  'help',
  'logout',
  'getopts',
  'mapfile',
  'readarray',
  'caller',
  'enable',
  'compgen',
  'complete',
  'bind',
  'fc',
].map((entry) => {
  const [name, reason = '', label = '`' + name + '`'] = Array.isArray(entry) ? entry : [entry]
  return [name, label + ' is not supported' + reason]
}))
