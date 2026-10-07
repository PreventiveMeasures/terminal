// The commands bash runs as builtins of its own and a path, xargs or find
// -exec runs as the coreutils programs of the same name, which part ways
// from the builtins over options, escapes and what they say: `/bin/echo -e
// '☺'` writes the escape back out where `echo -e` writes the character.
// Each program is handed the name it was run by, which coreutils names
// itself by in what it says.

import { echo, echoProgram } from './echo.js'
import { printf, printfProgram } from './printf.js'
import { bracketProgram, testProgram } from './test.js'
import { parseArgs } from '../args.js'
import { ok } from '../util.js'
import { unsupported } from '../unsupported.js'

// These builtins accept and ignore arguments.
function cmdTrue() { return ok() }
function cmdFalse() { return { stdout: '', stderr: '', exitCode: 1 } }

export const SHELL_STYLE_COMMANDS = { echo, printf }
export const TRIVIAL_COMMANDS = {
  true: cmdTrue, false: cmdFalse, ':': cmdTrue,
}

// The programs ignore their arguments too, but for `--help` or `--version`
// standing alone, which they answer.
const trivialProgram = (exitCode) => (_stdin, tokens, _ctx, name) => {
  if (tokens.length === 1 && (tokens[0] === '--help' || tokens[0] === '--version')) {
    return unsupported('option', name.slice(name.lastIndexOf('/') + 1), tokens[0], `${name}: ${tokens[0]} is not supported`)
  }
  return { stdout: '', stderr: '', exitCode }
}

// coreutils' pwd prints the directory itself unless -L asks for $PWD, and
// here the two are one: a working directory reached through a link is
// refused where it would be entered. Operands it warns of and passes over.
function pwdProgram(_stdin, tokens, ctx, name = 'pwd') {
  const { positional } = parseArgs(tokens, { short: ['L', 'P'], long: ['logical', 'physical'] })
  return { stdout: ctx.cwd + '\n', stderr: positional.length > 0 ? `${name}: ignoring non-option arguments\n` : '', exitCode: 0 }
}

// GNU's own tools name themselves by what they were run as, path and all —
// `/usr/bin/head: cannot open …` and `Try '/usr/bin/head --help'` — where
// gzip, gawk, ripgrep, util-linux, xxd, curl and the scripts keep a name of
// their own. Commands here write the name they are registered by, so a run
// by path renames them where GNU's would read the path. The programs above
// are handed their name and write it themselves.
const PATH_NAMED = new Set([
  'basename', 'base32', 'base64', 'cat', 'cp', 'cut', 'date', 'dirname', 'du', 'head', 'ln', 'ls', 'mkdir', 'nl', 'od',
  'realpath', 'rm', 'seq', 'sha1sum', 'sha256sum', 'sha384sum', 'sha512sum', 'sort', 'stat', 'tac', 'tail', 'tee',
  'touch', 'tr', 'uniq', 'wc', 'whoami', 'diff', 'find', 'grep', 'patch', 'sed', 'tar', 'xargs',
])

// grep and tar point at --help by their own names whatever they were run as.
const OWN_HELP = new Set(['grep', 'tar'])

// What renames a result's diagnostics for `resolved` run as `name`, or null
// where there is nothing to rename. It rewrites in place, since a result
// carries its unsupported note where a copy would drop it.
export function diagnosticName(name, resolved) {
  if (name === resolved || !PATH_NAMED.has(resolved)) return null
  const lead = (text) => text.replaceAll(new RegExp(`^${resolved}: `, 'gmu'), `${name}: `)
  const rename = OWN_HELP.has(resolved) ? lead : (text) => lead(text).replaceAll(`Try '${resolved} --help'`, `Try '${name} --help'`)
  return (result) => {
    if (result.stderr) result.stderr = rename(result.stderr)
    for (const event of result.events ?? []) if (event.fd === 2 && typeof event.text === 'string') event.text = rename(event.text)
    return result
  }
}

export const PROGRAMS = Object.freeze({
  __proto__: null,
  echo: echoProgram, printf: printfProgram, test: testProgram, '[': bracketProgram,
  true: trivialProgram(0), false: trivialProgram(1), pwd: pwdProgram,
})
