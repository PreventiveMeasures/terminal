// gawk's command line: its options read as gawk's getopt reads them (up to
// the first operand or `--`, values attached or in the next word), and its
// usage text, which gawk prints — and exits 1 — for an option it does not
// know, or a command line with no program at all.

import { BUILTINS, KEYWORDS } from './common.js'
import { UnsupportedError } from '../unsupported.js'

const OPTIONS = [
  ['-f progfile', '--file=progfile'], ['-F fs', '--field-separator=fs'], ['-v var=val', '--assign=var=val'],
]
const EXTENSIONS = [
  ['-b', '--characters-as-bytes'], ['-c', '--traditional'], ['-C', '--copyright'], ['-d[file]', '--dump-variables[=file]'],
  ['-D[file]', '--debug[=file]'], ["-e 'program-text'", "--source='program-text'"], ['-E file', '--exec=file'], ['-g', '--gen-pot'],
  ['-h', '--help'], ['-i includefile', '--include=includefile'], ['-I', '--trace'], ['-l library', '--load=library'],
  ['-L[fatal|invalid|no-ext]', '--lint[=fatal|invalid|no-ext]'], ['-M', '--bignum'], ['-N', '--use-lc-numeric'],
  ['-n', '--non-decimal-data'], ['-o[file]', '--pretty-print[=file]'], ['-O', '--optimize'], ['-p[file]', '--profile[=file]'],
  ['-P', '--posix'], ['-r', '--re-interval'], ['-s', '--no-optimize'], ['-S', '--sandbox'], ['-t', '--lint-old'], ['-V', '--version'],
]

// Columns are tab stops, as gawk's own table lays them out.
const row = ([short, long]) => `\t${short}${'\t'.repeat(short.length < 8 ? 3 : short.length < 16 ? 2 : 1)}${long}\n`

export const USAGE = 'Usage: awk [POSIX or GNU style options] -f progfile [--] file ...\n'
  + "Usage: awk [POSIX or GNU style options] [--] 'program' file ...\n"
  + 'POSIX options:\t\tGNU long options: (standard)\n' + OPTIONS.map(row).join('')
  + 'Short options:\t\tGNU long options: (extensions)\n' + EXTENSIONS.map(row).join('')
  + "\nTo report bugs, use the `gawkbug' program.\n"
  + "For full instructions, see the node `Bugs' in `gawk.info'\n"
  + "which is section `Reporting Problems and Bugs' in the\n"
  + 'printed version.  This same information may be found at\n'
  + 'https://www.gnu.org/software/gawk/manual/html_node/Bugs.html.\n'
  + 'PLEASE do NOT try to report bugs by posting in comp.lang.awk,\n'
  + 'or by using a web forum such as Stack Overflow.\n\n'
  + 'gawk is a pattern scanning and processing language.\n'
  + 'By default it reads standard input and writes standard output.\n\n'
  + "Examples:\n\tawk '{ sum += $1 }; END { print sum }' file\n\tawk -F: '{ print $1 }' /etc/passwd\n"

// gawk's short options; all but -f, -F and -v are refused as unsupported.
const SHORT = new Set('FfvWbcCdDeEghiIlLnNoOpMPrsStVYZ')
const LONG = new Map([['file', 'f'], ['field-separator', 'F'], ['assign', 'v']])
const OTHER_LONG = [
  'bignum', 'characters-as-bytes', 'copyright', 'debug', 'dump-variables', 'exec', 'gen-pot', 'help', 'include',
  'lint', 'lint-old', 'load', 'no-optimize', 'non-decimal-data', 'optimize', 'posix', 'pretty-print', 'profile',
  're-interval', 'sandbox', 'source', 'trace', 'traditional', 'use-lc-numeric', 'version',
]

const usage = (prefix = '') => ({ result: { stdout: '', stderr: prefix + USAGE, exitCode: 1 } })

// { assigns: [{ kind: 'F' | 'v', value }], files, operands } or { result }.
export function gawkOptions(tokens) {
  const assigns = []
  const files = []
  const take = (kind, value) => (kind === 'f' ? files.push(value) : assigns.push({ kind, value }))
  let i = 0
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--') { i++; break }
    if (!t.startsWith('-') || t === '-') break
    if (t.startsWith('--')) {
      const eq = t.indexOf('=')
      const name = t.slice(2, eq === -1 ? undefined : eq)
      const matches = [...LONG.keys(), ...OTHER_LONG].filter((o) => o === name || o.startsWith(name))
      const option = matches.includes(name) ? name : matches.length === 1 ? matches[0] : null
      if (option === null) return usage()
      if (!LONG.has(option)) throw new UnsupportedError('option', `--${option}`, `option --${option} is not supported`)
      if (eq === -1 && i + 1 >= tokens.length) return usage(`awk: option '--${option}' requires an argument\n`)
      take(LONG.get(option), eq === -1 ? tokens[++i] : t.slice(eq + 1))
      continue
    }
    const c = t[1]
    if (!SHORT.has(c)) return usage()
    if (c !== 'f' && c !== 'F' && c !== 'v') throw new UnsupportedError('option', `-${c}`, `option -${c} is not supported`)
    if (t.length === 2 && i + 1 >= tokens.length) return usage(`awk: option requires an argument -- ${c}\n`)
    take(c, t.length > 2 ? t.slice(2) : tokens[++i])
  }
  return { assigns, files, operands: tokens.slice(i) }
}

// Why -v cannot assign to a name, in gawk's words, or null.
export function illegalName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) return `\`${name}' is not a legal variable name`
  if (KEYWORDS.has(name) || BUILTINS.has(name)) return `cannot use gawk builtin \`${name}' as variable name`
  return null
}
