// What a tar command line asks for, read the way GNU tar 1.35 reads one.
//
// A first word with no dash in front of it is the old style: every letter in
// it is an option, and each one that takes an argument takes the next word
// after the cluster, in order — `tar czf out.tgz dir`. Everything after that
// is getopt's: a cluster's letter that takes an argument takes the rest of
// the cluster, or the next word where nothing is left (`-cfz x` names the
// archive `z`); a long option takes `=value` or the next word; `--` ends the
// options. Options and operands are read in the order they come, since
// `-C` is positional: it moves every operand after it, and only those.
//
// An option GNU has and this terminal does not is a gap, named as it was
// written, rather than GNU's own complaint about an option it does not know.

import { UnsupportedError } from '../../unsupported.js'
import { quoteColon, quoteLocale } from './names.js'

const MODES = new Set(['create', 'list', 'extract'])

// Every option taken here, under its long name; the letters are GNU's.
const LETTERS = {
  __proto__: null,
  c: 'create', t: 'list', x: 'extract', f: 'file', v: 'verbose', z: 'gzip', C: 'directory',
  O: 'to-stdout', a: 'auto-compress', H: 'format', b: 'blocking-factor', k: 'keep-old-files',
}
const LONG = {
  __proto__: null,
  create: 'create', list: 'list', extract: 'extract', get: 'extract', file: 'file', verbose: 'verbose',
  gzip: 'gzip', gunzip: 'gzip', ungzip: 'gzip', directory: 'directory', 'to-stdout': 'to-stdout',
  'auto-compress': 'auto-compress', format: 'format', 'blocking-factor': 'blocking-factor',
  'keep-old-files': 'keep-old-files', 'strip-components': 'strip-components', owner: 'owner',
  group: 'group', 'numeric-owner': 'numeric-owner', utc: 'utc', 'no-wildcards': 'no-wildcards',
  sort: 'sort',
}
const WITH_ARGUMENT = new Set(['file', 'directory', 'format', 'blocking-factor', 'strip-components', 'owner', 'group', 'sort'])

// A usage error is GNU's message and its pointer to --help, with the status
// the part of GNU that noticed it exits with: argp's own 64 for the shape of
// an option, tar's 2 for what the options mean together.
const TRY = "Try 'tar --help' or 'tar --usage' for more information."
const usage = (message, status = 2) => ({ usage: { text: `tar: ${message}\n${TRY}\n`, status } })

// The words, the old style spelled out as the options it stands for.
function expandOldStyle(tokens) {
  if (tokens.length === 0 || tokens[0].startsWith('-')) return { words: tokens }
  const rest = tokens.slice(1)
  const words = []
  let taken = 0
  for (const letter of tokens[0]) {
    words.push('-' + letter)
    if (!WITH_ARGUMENT.has(LETTERS[letter])) continue
    if (taken >= rest.length) return usage(`Old option '${letter}' requires an argument.`)
    // The argument travels as its own word, so a cluster of one letter
    // cannot swallow the next option.
    words.push(rest[taken++])
  }
  return { words: [...words, ...rest.slice(taken)], old: true }
}

export function parseTar(tokens, ctx) {
  const expanded = expandOldStyle(tokens)
  if (expanded.usage) return expanded
  const { words } = expanded
  const opts = { mode: null, items: [], verbose: 0, values: new Map(), flags: new Set(), files: 0 }
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word === '--') {
      for (const name of words.slice(i + 1)) opts.items.push({ name })
      break
    }
    let wrong = null
    if (word.startsWith('--')) {
      const eq = word.indexOf('=')
      const given = eq === -1 ? word.slice(2) : word.slice(2, eq)
      const name = LONG[given]
      if (name === undefined) throw new UnsupportedError('option', `--${given}`, `unknown option: --${given}`)
      if (!WITH_ARGUMENT.has(name)) wrong = eq === -1 ? take(opts, name, undefined, ctx) : usage(`option '--${given}' doesn't allow an argument`, 64)
      else if (eq !== -1) wrong = take(opts, name, word.slice(eq + 1), ctx)
      else if (i + 1 < words.length) wrong = take(opts, name, words[++i], ctx)
      else wrong = usage(`option '--${given}' requires an argument`, 64)
    } else if (word.startsWith('-') && word.length > 1) {
      for (let j = 1; j < word.length && wrong === null; j++) {
        const letter = word[j]
        const name = LETTERS[letter]
        if (name === undefined) throw new UnsupportedError('option', `-${letter}`, `unknown option: -${letter}`)
        if (!WITH_ARGUMENT.has(name)) { wrong = take(opts, name, undefined, ctx); continue }
        if (j + 1 < word.length) wrong = take(opts, name, word.slice(j + 1), ctx)
        else if (i + 1 < words.length) wrong = take(opts, name, words[++i], ctx)
        else wrong = usage(`option requires an argument -- '${letter}'`, 64)
        break
      }
    } else opts.items.push({ name: word })
    if (wrong !== null) return wrong
  }
  return settle(opts)
}

// One option, as GNU takes it where it stands: a second mode, and a value it
// cannot read, are refused there, ahead of anything later on the line.
function take(opts, name, value, ctx) {
  if (MODES.has(name)) {
    if (opts.mode !== null && opts.mode !== name) return usage("You may not specify more than one '-Acdtrux', '--delete' or  '--test-label' option")
    opts.mode = name
  } else if (name === 'verbose') opts.verbose++
  else if (name === 'directory') opts.items.push({ dir: value })
  else if (value === undefined) opts.flags.add(name)
  else {
    const read = VALUES[name]?.(value, ctx) ?? { value }
    if (read.gap) throw new UnsupportedError('option', read.gap.detail, read.gap.message)
    if (read.usage) return read
    if (name === 'file') opts.files++
    opts.values.set(name, read.value)
  }
  return null
}

// The values GNU reads as it meets them.
const VALUES = {
  __proto__: null,
  'strip-components': (text) => {
    const n = wholeNumber(text)
    return n === null || n < 0 ? usage(`${text}: Invalid number of elements`) : { value: n }
  },
  // GNU's bound: a record of that many blocks has to fit an int.
  'blocking-factor': (text) => {
    const n = wholeNumber(text)
    return n === null || n < 1 || n > 4194303 ? usage(`${text}: Invalid blocking factor`) : { value: n }
  },
  format: (text) => {
    const chosen = FORMATS[text]
    if (chosen === undefined) return usage(`${text}: Invalid archive format`)
    // A format GNU writes and the archive package does not.
    return chosen === null ? { gap: { detail: `--format=${text}`, message: `the ${text} archive format is not supported` } } : { value: chosen }
  },
  sort: (text, ctx) => {
    const order = argmatch(text, SORTS)
    if (order.error) {
      const choices = SORTS.map((name) => `  - ${quoteLocale(name, ctx)}\n`).join('')
      return { usage: { text: `tar: ${order.error} argument ${quoteLocale(text, ctx)} for ${quoteLocale('--sort', ctx)}\nValid arguments are:\n${choices}`, status: 2 } }
    }
    return order.value === 'inode' ? { gap: { detail: '--sort=inode', message: '--sort=inode is not supported' } } : order
  },
  owner: (text, ctx) => ownerSpec(text, ctx),
  group: (text, ctx) => ownerSpec(text, ctx),
}

// GNU's parse_owner_group: `NAME:ID`, `:ID`, an ID alone where the text
// starts with a digit and is nothing but one, and a name otherwise. An ID it
// cannot read, or past what a uid holds, ends the run before anything else.
const ID_MAX = 4294967295
function ownerSpec(text, ctx) {
  const colon = text.indexOf(':')
  const number = colon === -1 ? text : text.slice(colon + 1)
  const digits = colon === -1 ? /^\d+$/u.exec(text) : /^[ \t\n\v\f\r]*\+?(\d+)$/u.exec(number)
  if (colon === -1 && digits === null) return { value: { name: text, id: null } }
  const id = digits === null ? null : Number(BigInt(digits.at(-1)) > BigInt(ID_MAX) ? -1 : digits.at(-1))
  if (id === null || id < 0) return { usage: { text: `tar: ${quoteColon(number, ctx)}: Invalid owner or group ID\ntar: Error is not recoverable: exiting now\n`, status: 2 } }
  return { value: { name: colon > 0 ? text.slice(0, colon) : null, id } }
}

// What the options mean together, which GNU checks once they are all read.
function settle(opts) {
  if (opts.mode === null) return usage("You must specify one of the '-Acdtrux', '--delete' or '--test-label' options")
  if (opts.files > 1) return usage("Multiple archive files require '-M' option")
  if (opts.mode === 'create' && !opts.items.some((item) => item.name !== undefined)) return usage('Cowardly refusing to create an empty archive')
  return {
    mode: opts.mode,
    items: opts.items,
    verbose: opts.verbose,
    archive: opts.values.get('file') ?? '-',
    gzip: opts.flags.has('gzip'),
    auto: opts.flags.has('auto-compress'),
    toStdout: opts.flags.has('to-stdout'),
    keepOld: opts.flags.has('keep-old-files'),
    numericOwner: opts.flags.has('numeric-owner'),
    utc: opts.flags.has('utc'),
    owner: opts.values.get('owner'),
    group: opts.values.get('group'),
    strip: opts.values.get('strip-components') ?? 0,
    blocking: opts.values.get('blocking-factor') ?? 20,
    format: opts.values.get('format') ?? 'gnu',
  }
}

// GNU's names for the formats, and which of them the package writes: its
// 'pax' is POSIX's, which GNU also calls 'posix'.
const FORMATS = { __proto__: null, gnu: 'gnu', ustar: 'ustar', pax: 'pax', posix: 'pax', oldgnu: null, v7: null }

// A walk here goes in name order, which is what `--sort=name` asks for and
// what reading a directory as it lies gives in this tree; there are no
// inodes to go by. GNU takes any of them by a prefix only one has.
const SORTS = ['none', 'name', 'inode']
function argmatch(given, choices) {
  if (choices.includes(given)) return { value: given }
  const matches = choices.filter((choice) => choice.startsWith(given))
  if (matches.length === 1) return { value: matches[0] }
  return { error: matches.length ? 'ambiguous' : 'invalid' }
}

// A decimal number as xstrtoimax reads one: blanks and a sign in front,
// nothing after, and nothing past what an intmax holds. A count past what a
// double holds exactly counts past every name there is, so it is held at the
// largest one that does.
const INTMAX = 2n ** 63n - 1n
function wholeNumber(text) {
  const match = /^[ \t\n\v\f\r]*([+-]?)(\d+)$/u.exec(text)
  if (!match) return null
  const n = BigInt(match[1] + match[2])
  if (n > INTMAX || n < -INTMAX - 1n) return null
  return n < 0n ? -1 : Number(n > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : n)
}
