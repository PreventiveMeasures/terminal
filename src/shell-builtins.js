// The shell's own builtins — the ones that act on the shell rather
// than on the file tree: `exit`, `break` / `continue`, `export` /
// `unset`. They are dispatched like any command (so a wired command of
// the same name still wins, and `find -exec exit ';'` merely returns a
// status), but the engine reads two extra fields off their results:
// `halt`, which ends the line, and `control`, which the enclosing `for`
// loop consumes. index.js strips both before a result reaches the
// caller. Hidden: shell machinery, not part of the documented command
// surface.

import { err, ok } from './util.js'
import { unsupported } from './unsupported.js'

// `exit [N]`: end the command line with status N (the last command's
// status when omitted), modulo 256 as the OS would see it. Inside a
// subshell or a pipeline it ends only that part, which index.js
// arranges by dropping `halt` at those boundaries. An argument that is
// not a number bash can hold (a 64-bit integer) is an error that still
// exits, with status 2, and so is more than one argument, with status
// 1 — both as bash 5.2 behaves, which checks the first argument before
// counting them (`exit nope 1` is the numeric error) and skips a
// leading `--`. BigInt keeps the modulo exact for any length of digits.
const INT64_MAX = 9223372036854775807n
const INT64_MIN = -9223372036854775808n

function exit(_stdin, tokens, ctx) {
  const args = tokens[0] === '--' ? tokens.slice(1) : tokens
  if (args.length === 0) return { stdout: '', stderr: '', exitCode: ctx.lastExit, halt: true }
  const arg = args[0]
  const n = /^[+-]?\d+$/u.test(arg) ? BigInt(arg) : null
  if (n === null || n > INT64_MAX || n < INT64_MIN) {
    return { stdout: '', stderr: `exit: ${arg}: numeric argument required\n`, exitCode: 2, halt: true }
  }
  if (args.length > 1) return { stdout: '', stderr: 'exit: too many arguments\n', exitCode: 1, halt: true }
  return { stdout: '', stderr: '', exitCode: Number(((n % 256n) + 256n) % 256n), halt: true }
}

// `break` / `continue` end or skip the current iteration of the
// enclosing `for`. A count other than 1 (`break 2`) would need nested
// loop bookkeeping this shell does not keep; outside any loop bash only
// warns, and so does this.
function loopControl(name) {
  return (_stdin, tokens, ctx) => {
    if (tokens.length > 1) return err(`${name}: too many arguments`)
    if (tokens.length === 1 && tokens[0] !== '1') {
      if (!/^\d+$/u.test(tokens[0]) || tokens[0] === '0') return err(`${name}: ${tokens[0]}: loop count out of range`)
      return unsupported('feature', name, `${name} N`, `${name} ${tokens[0]}: only \`${name}\` (one level) is supported`)
    }
    if (ctx.loopDepth === 0) return err(`${name}: only meaningful in a \`for\` loop`, 0)
    return { stdout: '', stderr: '', exitCode: 0, control: name }
  }
}

// `export NAME[=value]…`: there is no environment to export into, so
// this is assignment — or, without a value, a rebinding of the current
// value, which is what lets `x=2 export x` keep `x` as bash does (a
// prefix assignment the command rebinds outlives it). `unset NAME…`
// removes bindings. Both accept the names bash accepts.
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u

function exportCmd(_stdin, tokens, ctx) {
  if (tokens.length === 0 || tokens[0] === '-p') return unsupported('option', 'export', '-p', 'export: listing the environment is not supported (there is none)')
  for (const t of tokens) {
    const eq = t.indexOf('=')
    const name = eq === -1 ? t : t.slice(0, eq)
    if (t.startsWith('-')) return unsupported('option', 'export', t, `export: option \`${t}\` is not supported`)
    if (!NAME.test(name)) return err(`export: \`${name}': not a valid identifier`)
    if (eq !== -1) ctx.vars.set(name, t.slice(eq + 1))
    else if (ctx.vars.has(name)) ctx.vars.set(name, ctx.vars.get(name))
  }
  return ok()
}

function unset(_stdin, tokens, ctx) {
  for (const t of tokens) {
    if (t.startsWith('-')) return unsupported('option', 'unset', t, `unset: option \`${t}\` is not supported`)
    if (!NAME.test(t)) return err(`unset: \`${t}': not a valid identifier`)
    ctx.vars.delete(t)
  }
  return ok()
}

export const SHELL_BUILTINS = {
  exit, break: loopControl('break'), continue: loopControl('continue'), export: exportCmd, unset,
}

// Bash builtins and keywords this shell does not implement. They are
// shell machinery rather than commands someone could wire in, so a
// line that reaches for one gets a `feature` gap naming it, not a
// "command not found" with a hint listing unrelated commands. Only
// consulted when nothing is registered under the name, so a wired
// command still wins.
export const SHELL_GAPS = new Map([
  ['return', '`return` is not supported (there are no shell functions)'],
  ['source', '`source` is not supported (nothing can be sourced into this shell)'],
  ['.', '`.` (source) is not supported'],
  ['eval', '`eval` is not supported'],
  ['exec', '`exec` is not supported'],
  ['read', '`read` is not supported (there is no interactive input)'],
  ['shift', '`shift` is not supported (there are no positional parameters)'],
  ['set', '`set` is not supported'],
  ['shopt', '`shopt` is not supported'],
  ['local', '`local` is not supported (there are no shell functions)'],
  ['declare', '`declare` is not supported; use `NAME=value`'],
  ['typeset', '`typeset` is not supported; use `NAME=value`'],
  ['readonly', '`readonly` is not supported; use `NAME=value`'],
  ['let', '`let` is not supported (no arithmetic)'],
  ['test', '`test` is not supported; gate on a command\'s exit status instead'],
  ['[', '`[ … ]` is not supported; gate on a command\'s exit status instead'],
  ['printf', '`printf` is not supported; use `echo` (with `-e` for escapes)'],
  ['type', '`type` is not supported; use `which`'],
  ['command', '`command` is not supported; run the command directly'],
  ['builtin', '`builtin` is not supported'],
  ['hash', '`hash` is not supported'],
  ['alias', '`alias` is not supported'],
  ['unalias', '`unalias` is not supported'],
  ['trap', '`trap` is not supported'],
  ['wait', '`wait` is not supported (nothing runs in the background)'],
  ['kill', '`kill` is not supported (there are no processes)'],
  ['jobs', '`jobs` is not supported (there are no processes)'],
  ['bg', '`bg` is not supported (there are no processes)'],
  ['fg', '`fg` is not supported (there are no processes)'],
  ['disown', '`disown` is not supported (there are no processes)'],
  ['suspend', '`suspend` is not supported'],
  ['times', '`times` is not supported'],
  ['ulimit', '`ulimit` is not supported'],
  ['umask', '`umask` is not supported'],
  ['pushd', '`pushd` is not supported; use `cd`'],
  ['popd', '`popd` is not supported; use `cd -`'],
  ['dirs', '`dirs` is not supported'],
  ['history', '`history` is not supported'],
  ['help', '`help` is not supported'],
  ['logout', '`logout` is not supported'],
  ['getopts', '`getopts` is not supported'],
  ['mapfile', '`mapfile` is not supported'],
  ['readarray', '`readarray` is not supported'],
  ['caller', '`caller` is not supported'],
  ['enable', '`enable` is not supported'],
  ['compgen', '`compgen` is not supported'],
  ['complete', '`complete` is not supported'],
  ['bind', '`bind` is not supported'],
  ['fc', '`fc` is not supported'],
])
