// POSIX bracket-expression classes (`[:alpha:]` and friends) as regex
// class bodies, for the places that translate shell or POSIX patterns
// into ECMAScript regexes: globs (glob.js), grep's BRE/ERE (bre.js) and
// tr's SET syntax. The C-locale ASCII definitions, which is what every
// GNU tool here matches under LC_ALL=C and what a source tree needs.
// `word` is GNU's `\w` (letters, digits, underscore) and not a POSIX
// class; it is here for the regex translators.
export const POSIX_CLASSES = {
  __proto__: null,
  alpha: 'A-Za-z',
  digit: '0-9',
  alnum: '0-9A-Za-z',
  upper: 'A-Z',
  lower: 'a-z',
  space: ' \\t\\n\\v\\f\\r',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  xdigit: '0-9A-Fa-f',
  cntrl: '\\x00-\\x1F\\x7F',
  print: '\\x20-\\x7E',
  graph: '\\x21-\\x7E',
  word: '0-9A-Za-z_',
}

// The `[:name:]` at `s[i]` (which must be `[`), as `{ body, end }` with
// `end` the index just past the closing `:]`, or null when it is not a
// class. An unknown name is reported, as the GNU tools reject it —
// except under `{ unknown: 'empty' }`, which returns it with no members
// instead. That is what shell globbing needs: glibc's fnmatch reads an
// unknown class and simply matches nothing for it, where grep fails the
// pattern (see readBracket). An OPTIONS OBJECT rather than a positional
// flag for the reason compileGlob gives.
export function readPosixClass(s, i, opts = {}) {
  const m = /^\[:([a-z]+):\]/u.exec(s.slice(i))
  if (!m) return null
  const body = POSIX_CLASSES[m[1]]
  if (body === undefined) {
    if (opts?.unknown !== 'empty') throw new Error(`invalid character class \`[:${m[1]}:]\``)
    return { body: '', end: i + m[0].length }
  }
  return { body, end: i + m[0].length }
}
