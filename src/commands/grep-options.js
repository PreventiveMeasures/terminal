// grep's command line, read as GNU reads it: the spellings it takes for each
// option, and the options it dies at, in the order it meets them.
import { parseArgs } from '../args.js'
import { err } from '../util.js'
import { unsupported } from '../unsupported.js'
import { GREP_USAGE, grepPatterns } from './grep-pattern-files.js'

// -r and -R coincide over a tree holding no links; where one does, -R is the
// spelling that would follow it, and refuses instead.
const SHORT_FLAGS = ['i', 'y', 'v', 'n', 'r', 'R', 'l', 'L', 'c', 'w', 'x', 'h', 'H', 'o', 'E', 'F', 'G', 'P', 'q', 'I', 'a', 's']
const VALUE_SHORTS = ['A', 'B', 'C', 'm']

// GNU's long spellings of those, and `-y`, its old one for `-i`: each is
// folded onto the short option it names before anything reads the parse.
const SPELLING = {
  __proto__: null, y: 'i', text: 'a', 'no-messages': 's', count: 'c', 'ignore-case': 'i', 'line-number': 'n',
  'files-with-matches': 'l', 'files-without-match': 'L', 'invert-match': 'v', 'word-regexp': 'w', 'line-regexp': 'x',
  'only-matching': 'o', quiet: 'q', silent: 'q', 'with-filename': 'H', 'no-filename': 'h', 'extended-regexp': 'E',
  'fixed-strings': 'F', 'fixed-regexp': 'F', 'basic-regexp': 'G', 'perl-regexp': 'P', recursive: 'r', 'dereference-recursive': 'R',
  'max-count': 'm', 'after-context': 'A', 'before-context': 'B', context: 'C', regexp: 'e', file: 'f', colour: 'color',
}
const LONG_VALUES = ['max-count', 'after-context', 'before-context', 'context', 'color', 'colour']
const REPEATABLE = ['e', 'f', 'file', 'regexp', 'include', 'exclude', 'exclude-dir']
const LONG_FLAGS = Object.keys(SPELLING).filter((name) => name.length > 1 && !LONG_VALUES.includes(name) && !REPEATABLE.includes(name))

const ARGS = { short: SHORT_FLAGS, long: LONG_FLAGS, valueShort: VALUE_SHORTS, valueLong: LONG_VALUES, repeatable: REPEATABLE }

export function parseGrepArgs(tokens) {
  const parsed = parseArgs(tokens, ARGS)
  const flags = new Set()
  const values = new Map()
  const order = parsed.order.map(({ name, value }) => {
    const canonical = SPELLING[name] ?? name
    if (value === undefined) {
      flags.add(canonical)
      return { name: canonical }
    }
    if (REPEATABLE.includes(canonical)) values.set(canonical, [...(values.get(canonical) ?? []), value])
    else values.set(canonical, value)
    return { name: canonical, value }
  })
  return { flags, values, order, positional: parsed.positional }
}

// The options GNU dies at as it meets them, in the order it meets them: a
// context or a count it cannot read, and a second dialect.
const MATCHERS = new Set(['E', 'F', 'G', 'P'])
export function optionDeath() {
  let matcher = null
  return ({ name, value }) => {
    if (name === 'A' || name === 'B' || name === 'C') {
      const n = gnuInteger(value)
      return n === null || n < 0 ? err(`grep: ${value}: invalid context length argument`, 2) : null
    }
    if (name === 'm') return gnuInteger(value) === null ? err('grep: invalid max count', 2) : null
    if (!MATCHERS.has(name)) return null
    if (matcher !== null && matcher !== name) return err('grep: conflicting matchers specified', 2)
    matcher = name
    return null
  }
}

// A number as xstrtoimax reads one for grep: blanks, a sign and digits, and
// nothing after them. One too large for the type is as good as the largest.
function gnuInteger(text) {
  const m = /^[ \t\n\v\f\r]*([+-]?)(\d+)$/u.exec(text)
  if (!m) return null
  const n = Math.min(Number(m[2]), Number.MAX_SAFE_INTEGER)
  return m[1] === '-' && n !== 0 ? -n : n
}

// getopt's own two complaints, which GNU follows with its usage lines —
// unless an option before the one complained of had already ended the run,
// as GNU reads that one first. A bundle missing its value is read up to its
// last letter.
export function argumentError(tokens, e, stdin, ctx) {
  const missing = /^(--?)(.+) requires an argument$/u.exec(e.message)
  const extra = /^option --(.+) doesn't allow an argument$/u.exec(e.message)
  if (!missing && !extra) return null
  let before
  if (missing) {
    const last = tokens.at(-1)
    before = [...tokens.slice(0, -1), ...(missing[1] === '-' && last.length > 2 ? [last.slice(0, -1)] : [])]
  } else before = tokens.slice(0, Math.max(0, tokens.findIndex((token) => token.startsWith(`--${extra[1]}=`))))
  let parsed
  try { parsed = parseGrepArgs(before) } catch {
    return unsupported('option', 'grep', 'malformed command line', `grep: ${e.message}`, 2)
  }
  const earlier = grepPatterns(parsed, stdin, ctx, optionDeath())
  if (earlier?.error) return earlier.error
  const complaint = extra ? `option '--${extra[1]}' doesn't allow an argument`
    : missing[1] === '--' ? `option '--${missing[2]}' requires an argument` : `option requires an argument -- '${missing[2]}'`
  return err(`grep: ${complaint}\n${GREP_USAGE}`, 2)
}

// `--color=never` and its two other spellings change nothing here. Anything
// else colours what it prints, or — for a word GNU does not know — prints
// GNU's help instead, and neither is modelled.
const COLOURS = /^(?:never|no|none|always|yes|force|auto|tty|if-tty)$/iu
export function colourGap(order, tokens) {
  const colours = order.filter((o) => o.name === 'color')
  if (colours.length === 0) return null
  const bare = tokens.some((token) => token === '--color' || token === '--colour')
  if (!bare && colours.every((o) => COLOURS.test(o.value)) && /^(?:never|no|none)$/iu.test(colours.at(-1).value)) return null
  return unsupported('option', 'grep', '--color', 'grep: coloured output is not supported; --color=never is', 2)
}

// The values were read as GNU reads them when they were met (optionDeath).
// -A and -B outrank -C whichever comes first, and a negative -m is no limit.
export function parseCounts(values) {
  const count = (flag) => (values.has(flag) ? gnuInteger(values.get(flag)) : undefined)
  const max = count('m')
  // An explicit zero context still separates nonadjacent match groups.
  return {
    after: count('A') ?? count('C') ?? 0, before: count('B') ?? count('C') ?? 0, max: max < 0 ? undefined : max,
    hasContext: ['A', 'B', 'C'].some((flag) => values.has(flag)),
  }
}
