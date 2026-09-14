import { parseArgs } from '../args.js'
import { err, parseNonNegativeInt } from '../util.js'
import { unsupported, unsupportedNote } from '../unsupported.js'
import { quoteShell } from './quote-name.js'

// GNU diff's option surface, sorted into what runs here and what is refused
// by name. Everything else parseArgs refuses as an unknown option, so no
// option is ever silently ignored.
const FLAGS = ['q', 's', 'r', 'N', 'a', 'i', 'w', 'b', 'Z', 'p', 'd', 'u', 'c', 'e', 'n', 'y', 't', 'T', 'l', 'E', 'B', 'P', 'v', 'H']
const LONG_FLAGS = [
  'brief', 'report-identical-files', 'recursive', 'new-file', 'text', 'ignore-case', 'ignore-all-space', 'ignore-space-change',
  'ignore-trailing-space', 'strip-trailing-cr', 'show-c-function', 'minimal', 'normal', 'unified', 'context',
  'ed', 'rcs', 'side-by-side', 'expand-tabs', 'initial-tab', 'paginate', 'ignore-tab-expansion', 'ignore-blank-lines',
  'unidirectional-new-file', 'version', 'help', 'suppress-common-lines', 'speed-large-files', 'ignore-file-name-case',
  'no-ignore-file-name-case', 'no-dereference', 'left-column',
]
const VALUE_SHORT = ['U', 'C', 'x', 'X', 'S', 'F', 'W', 'I', 'D']
const VALUE_LONG = ['show-function-line', 'exclude-from', 'starting-file', 'from-file', 'to-file', 'ifdef', 'width', 'tabsize', 'horizon-lines',
  'ignore-matching-lines', 'line-format', 'old-line-format', 'new-line-format', 'unchanged-line-format',
  'old-group-format', 'new-group-format', 'unchanged-group-format', 'changed-group-format', 'color', 'palette']
const REPEATABLE = ['L', 'label', 'x', 'exclude']

// Recognized, refused, and named on the feed: what each would need.
const REFUSED = new Map([
  ['e', 'ed script output'], ['ed', 'ed script output'], ['n', 'RCS output'], ['rcs', 'RCS output'],
  ['y', 'side-by-side output'], ['side-by-side', 'side-by-side output'], ['W', 'side-by-side output'], ['width', 'side-by-side output'],
  ['suppress-common-lines', 'side-by-side output'], ['left-column', 'side-by-side output'],
  ['t', 'tab expansion'], ['expand-tabs', 'tab expansion'], ['T', 'initial tabs'], ['initial-tab', 'initial tabs'], ['tabsize', 'tab expansion'],
  ['E', 'tab expansion'], ['ignore-tab-expansion', 'tab expansion'],
  ['B', 'ignoring blank lines'], ['ignore-blank-lines', 'ignoring blank lines'], ['I', 'ignoring matching lines'], ['ignore-matching-lines', 'ignoring matching lines'],
  ['D', 'merged #ifdef output'], ['ifdef', 'merged #ifdef output'], ['l', 'pagination'], ['paginate', 'pagination'],
  ['F', 'a custom function regex'], ['show-function-line', 'a custom function regex'], ['X', 'reading exclusions from a file'], ['exclude-from', 'reading exclusions from a file'],
  ['S', 'a starting file'], ['starting-file', 'a starting file'], ['from-file', 'comparing one file to many'], ['to-file', 'comparing one file to many'],
  ['P', 'one-sided new files'], ['unidirectional-new-file', 'one-sided new files'], ['v', 'a version banner'], ['version', 'a version banner'],
  ['help', 'a help text'], ['H', 'large-file heuristics'], ['speed-large-files', 'large-file heuristics'], ['horizon-lines', 'the horizon setting'],
  ['ignore-file-name-case', 'case-insensitive names'], ['no-ignore-file-name-case', 'case-insensitive names'], ['no-dereference', 'symbolic links'],
  ['color', 'colored output'], ['palette', 'colored output'], ['line-format', 'custom line formats'], ['old-line-format', 'custom line formats'],
  ['new-line-format', 'custom line formats'], ['unchanged-line-format', 'custom line formats'], ['old-group-format', 'custom group formats'],
  ['new-group-format', 'custom group formats'], ['unchanged-group-format', 'custom group formats'], ['changed-group-format', 'custom group formats'],
])

const usage = (message) => err(`diff: ${message}\ndiff: Try 'diff --help' for more information.`, 2)

// GNU takes `--unified` and `--context` with or without a count; parseArgs
// takes one or the other, so both spellings are rewritten first.
function normalize(tokens) {
  const out = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--') { out.push(...tokens.slice(i)); break }
    if (t === '--unified' || t === '--context') out.push('-' + (t === '--unified' ? 'u' : 'c'))
    else if (t.startsWith('--unified=') || t.startsWith('--context=')) out.push(t.startsWith('--u') ? '-U' : '-C', t.slice(10))
    else if (t.startsWith('--color')) return { refused: 'colored output', label: t }
    else out.push(t)
  }
  return { tokens: out }
}

export function parseDiffOptions(tokens) {
  const normalized = normalize(tokens)
  if (normalized.refused) return { refused: unsupported('option', 'diff', normalized.label.replace(/=.*/u, ''), `diff: ${normalized.label}: ${normalized.refused} is not supported`, 2) }
  let parsed
  try { parsed = parseArgs(normalized.tokens, { short: FLAGS, long: LONG_FLAGS, valueShort: VALUE_SHORT, valueLong: VALUE_LONG, repeatable: REPEATABLE }) } catch (e) {
    // A usage error exits 2; an option this diff lacks is a gap as well.
    const note = unsupportedNote(e)
    if (note) return { refused: unsupported(note.kind, 'diff', note.detail, `diff: ${e.message}`, 2) }
    return { error: usage(e.message) }
  }
  const opts = { style: null, context: -1, labels: [], excludes: [], whitespace: 'none', switches: switchString(tokens) }
  for (const { name, value } of parsed.order) {
    const refused = REFUSED.get(name)
    const label = (name.length === 1 ? '-' : '--') + name
    if (refused) return { refused: unsupported('option', 'diff', label, `diff: ${label}: ${refused} is not supported`, 2) }
    const result = applyOption(opts, name, value)
    if (result) return { error: result }
  }
  // -p on its own asks for context output, as GNU's show_c_function does.
  if (opts.showFunction && opts.style === null) opts.style = 'context'
  if (opts.context < 0) opts.context = 3
  if (parsed.positional.length < 2) return { error: usage(`missing operand after '${parsed.positional[0] ?? 'diff'}'`) }
  if (parsed.positional.length > 2) return { error: usage(`extra operand '${parsed.positional[2]}'`) }
  return { opts, operands: parsed.positional }
}

// diff.c: the output style is set once, a second different style is an
// error; -U/-C raise the context to their count, -u/-c to 3 if unset.
function applyOption(opts, name, value) {
  const style = (kind) => {
    if (opts.style !== null && opts.style !== kind) return usage('conflicting output style options')
    opts.style = kind
    return null
  }
  switch (name) {
    case 'u': case 'c': {
      const conflict = style(name === 'u' ? 'unified' : 'context')
      if (opts.context < 3) opts.context = 3
      return conflict
    }
    case 'U': case 'C': {
      const count = parseContext(value)
      if (count === null) return usage(`invalid context length '${value}'`)
      const conflict = style(name === 'U' ? 'unified' : 'context')
      if (opts.context < count) opts.context = count
      return conflict
    }
    case 'normal': return style('normal')
    case 'q': case 'brief': opts.brief = true; return null
    case 's': case 'report-identical-files': opts.identical = true; return null
    case 'r': case 'recursive': opts.recursive = true; return null
    case 'N': case 'new-file': opts.newFile = true; return null
    case 'a': case 'text': opts.text = true; return null
    case 'i': case 'ignore-case': opts.ignoreCase = true; return null
    case 'w': case 'ignore-all-space': opts.whitespace = 'all'; return null
    case 'b': case 'ignore-space-change': if (opts.whitespace !== 'all') opts.whitespace = 'change'; return null
    case 'Z': case 'ignore-trailing-space': if (opts.whitespace === 'none') opts.whitespace = 'trailing'; return null
    case 'strip-trailing-cr': opts.stripCr = true; return null
    case 'p': case 'show-c-function': opts.showFunction = true; return null
    case 'd': case 'minimal': opts.minimal = true; return null
    case 'L': case 'label':
      if (opts.labels.length === 2) return err('diff: too many file label options', 2)
      opts.labels.push(value)
      return null
    case 'x': case 'exclude': opts.excludes.push(value); return null
    default: return null
  }
}

// strtoimax: blanks and a sign are fine, anything else in the text is not,
// and an empty string reads as zero.
function parseContext(value) {
  if (value === '') return 0
  const parsed = parseNonNegativeInt(value, 'diff')
  return parsed.error ? null : parsed.value
}

// The option words as typed, for the `diff -r …` line above each file pair
// in a directory comparison: GNU joins the option arguments it was given,
// shell-quoted, in the order getopt left them (options before operands).
function switchString(tokens) {
  const words = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--') break
    if (!t.startsWith('-') || t === '-') continue
    words.push(t)
    if (takesValue(t) && i + 1 < tokens.length) words.push(tokens[++i])
  }
  return words.map((word) => ' ' + quoteShell(word, { vars: new Map() })).join('')
}

function takesValue(token) {
  if (token.startsWith('--')) return !token.includes('=') && (VALUE_LONG.includes(token.slice(2)) || token === '--label' || token === '--exclude')
  for (let j = 1; j < token.length; j++) {
    const c = token[j]
    if (VALUE_SHORT.includes(c) || c === 'L') return j + 1 === token.length
  }
  return false
}
