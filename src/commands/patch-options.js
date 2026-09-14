import { parseArgs } from '../args.js'
import { err } from '../util.js'
import { quoteShell } from './quote-name.js'
import { unsupported, unsupportedNote } from '../unsupported.js'

// GNU patch's options: those that run here, and those refused by name so
// they reach the feed. parseArgs refuses anything else as unknown.
const FLAGS = ['R', 'N', 'f', 't', 's', 'b', 'l', 'E', 'T', 'Z', 'e', 'u', 'c', 'n', 'v']
const LONG_FLAGS = ['reverse', 'forward', 'force', 'batch', 'silent', 'quiet', 'backup', 'ignore-whitespace', 'remove-empty-files',
  'dry-run', 'verbose', 'unified', 'context', 'normal', 'ed', 'binary', 'no-backup-if-mismatch', 'backup-if-mismatch',
  'posix', 'follow-symlinks', 'help', 'version', 'set-time', 'set-utc']
const VALUE_SHORT = ['p', 'i', 'o', 'd', 'r', 'F', 'z', 'B', 'Y', 'V', 'g', 'D', 'x']
const VALUE_LONG = ['strip', 'input', 'output', 'directory', 'reject-file', 'fuzz', 'suffix', 'prefix', 'basename-prefix',
  'version-control', 'get', 'reject-format', 'quoting-style', 'read-only', 'merge', 'debug']

const REFUSED = new Map([
  ['T', 'setting file times'], ['Z', 'setting file times'], ['set-time', 'setting file times'], ['set-utc', 'setting file times'],
  ['e', 'ed scripts'], ['ed', 'ed scripts'], ['v', 'a version banner'], ['version', 'a version banner'], ['help', 'a help text'],
  ['verbose', 'verbose output'], ['B', 'backup prefixes'], ['prefix', 'backup prefixes'], ['Y', 'backup prefixes'], ['basename-prefix', 'backup prefixes'],
  ['V', 'numbered backups'], ['version-control', 'numbered backups'], ['g', 'version control'], ['get', 'version control'],
  ['D', 'merged #ifdef output'], ['x', 'debugging output'], ['debug', 'debugging output'], ['posix', 'POSIX mode'],
  ['follow-symlinks', 'symbolic links'], ['quoting-style', 'quoting styles'], ['read-only', 'read-only handling'], ['merge', 'merging'],
])

const usage = (message) => err(`patch: ${message}\npatch: Try 'patch --help' for more information.`, 2)

export function parsePatchOptions(tokens) {
  // --merge and --read-only take an optional value parseArgs cannot express.
  for (const t of tokens) {
    if (t === '--') break
    const bare = t.replace(/=.*/u, '')
    if (bare === '--merge' || bare === '--read-only') return { refused: unsupported('option', 'patch', bare, `patch: ${bare}: ${REFUSED.get(bare.slice(2))} is not supported`, 2) }
  }
  let parsed
  try { parsed = parseArgs(tokens, { short: FLAGS, long: LONG_FLAGS, valueShort: VALUE_SHORT, valueLong: VALUE_LONG }) } catch (e) {
    // A usage error exits 2; an option this patch lacks is a gap as well.
    const note = unsupportedNote(e)
    if (note) return { refused: unsupported(note.kind, 'patch', note.detail, `patch: ${e.message}`, 2) }
    return { error: usage(e.message) }
  }
  const opts = { strip: -1, input: null, output: null, directory: null, rejectFile: null, fuzz: 2, suffix: '.orig', format: null, rejectFormat: null,
    reverse: false, noReverse: false, force: false, batch: false, silent: false, backup: false, backupIfMismatch: true, loose: false, removeEmpty: false, dryRun: false }
  for (const { name, value } of parsed.order) {
    const label = (name.length === 1 ? '-' : '--') + name
    const refused = REFUSED.get(name)
    if (refused) return { refused: unsupported('option', 'patch', label, `patch: ${label}: ${refused} is not supported`, 2) }
    const problem = applyOption(opts, name, value)
    if (problem) return { error: problem }
  }
  if (parsed.positional.length > 2) return { error: usage(`${parsed.positional[2]}: extra operand`) }
  return { opts, operands: parsed.positional }
}

// GNU's numeric_string: digits only, and for these two never negative.
function numeric(value, what) {
  if (!/^[+-]?\d+$/u.test(value)) return { error: err(`patch: **** ${what} ${quoteShell(value, { vars: new Map() })} is not a number`, 2) }
  const n = Number(value)
  if (n < 0) return { error: err(`patch: **** ${what} ${value} is negative`, 2) }
  return { value: Math.min(n, Number.MAX_SAFE_INTEGER) }
}

function applyOption(opts, name, value) {
  switch (name) {
    case 'p': case 'strip': { const n = numeric(value, 'strip count'); if (n.error) return n.error; opts.strip = n.value; return null }
    case 'F': case 'fuzz': { const n = numeric(value, 'fuzz factor'); if (n.error) return n.error; opts.fuzz = n.value; return null }
    case 'i': case 'input': opts.input = value; return null
    case 'o': case 'output': opts.output = value; return null
    case 'd': case 'directory': opts.directory = value; return null
    case 'r': case 'reject-file': opts.rejectFile = value; return null
    case 'z': case 'suffix':
      if (value === '') return err('patch: **** backup suffix is empty', 2)
      opts.suffix = value
      return null
    case 'R': case 'reverse': opts.reverse = true; return null
    case 'N': case 'forward': opts.noReverse = true; return null
    case 'f': case 'force': opts.force = true; return null
    case 't': case 'batch': opts.batch = true; return null
    case 's': case 'silent': case 'quiet': opts.silent = true; return null
    case 'b': case 'backup': opts.backup = true; return null
    case 'l': case 'ignore-whitespace': opts.loose = true; return null
    case 'E': case 'remove-empty-files': opts.removeEmpty = true; return null
    case 'dry-run': opts.dryRun = true; return null
    case 'u': case 'unified': opts.format = 'unified'; return null
    case 'c': case 'context': opts.format = 'context'; return null
    case 'n': case 'normal': opts.format = 'normal'; return null
    case 'no-backup-if-mismatch': opts.backupIfMismatch = false; return null
    case 'backup-if-mismatch': opts.backupIfMismatch = true; return null
    case 'reject-format':
      if (value !== 'unified' && value !== 'context') return err(`patch: **** unknown reject format ${value}`, 2)
      opts.rejectFormat = value
      return null
    default: return null
  }
}
