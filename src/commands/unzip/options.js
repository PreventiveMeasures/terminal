// An unzip command line, read the way Info-ZIP UnZip 6.00 reads one, and the
// patterns it names members with.
//
// Options come before the archive — letters, in clusters, `-d DIR` or
// `-dDIR` for where to extract — and everything after it is a member
// pattern, bar two words it still watches for: `-x`, after which the
// patterns exclude, and `-d`. Anything else that looks like an option there
// is a name like any other, and is reported as one when nothing matches it.

import { UnsupportedError } from '../../unsupported.js'

// What each letter does; a mode letter picks what is done with the members.
const MODES = { __proto__: null, l: 'list', t: 'test', p: 'pipe', c: 'crt', v: 'verbose' }

// A `-d` with nothing after it is UnZip's own error, wherever it stands.
const NO_EXDIR = { usage: { text: 'error:  must specify directory to which to extract with -d option\n', status: 10 } }

export function parseUnzip(tokens) {
  const opts = { modes: new Set(), quiet: 0, overwriteAll: false, overwriteNone: false, junk: false, exdir: null, archive: null, members: [], excludes: [] }
  let i = 0
  for (; i < tokens.length && tokens[i].startsWith('-') && tokens[i].length > 1; i++) {
    const word = tokens[i]
    for (let j = 1; j < word.length; j++) {
      const letter = word[j]
      if (letter === 'd') {
        opts.exdir = j + 1 < word.length ? word.slice(j + 1) : tokens[++i]
        if (opts.exdir === undefined) return NO_EXDIR
        break
      }
      if (MODES[letter]) opts.modes.add(MODES[letter])
      else if (letter === 'q') opts.quiet++
      else if (letter === 'o') opts.overwriteAll = true
      else if (letter === 'n') opts.overwriteNone = true
      else if (letter === 'j') opts.junk = true
      else throw new UnsupportedError('option', `-${letter}`, `unknown option: -${letter}`)
    }
  }
  if (opts.modes.size > 1) throw new UnsupportedError('option', 'modes', 'combining -c, -l, -p, -t and -v is not supported')
  if (i >= tokens.length) throw new UnsupportedError('feature', 'usage', 'printing the usage summary is not supported')
  opts.archive = tokens[i++]
  let excluding = false
  for (; i < tokens.length; i++) {
    const word = tokens[i]
    if (word === '-x') excluding = true
    else if (word.startsWith('-d')) {
      opts.exdir = word.length > 2 ? word.slice(2) : tokens[++i]
      if (opts.exdir === undefined) return NO_EXDIR
    } else (excluding ? opts.excludes : opts.members).push(word)
  }
  const [mode = 'extract'] = opts.modes
  // Given both, UnZip takes -n, and says so (see index.js).
  const overwrite = opts.overwriteNone ? 'none' : opts.overwriteAll ? 'all' : null
  return { ...opts, mode, overwrite, bothOverwrites: opts.overwriteAll && opts.overwriteNone }
}

// Info-ZIP's recmatch, over the bytes of the name as the archive stores them:
// `*` takes any run, `/` included, `?` one byte, `[...]` one of a set or,
// with `!` or `^` first, none of it, and a backslash takes the next
// character as itself. It answers 1 for a match, 0 for none, and 2 for a
// `*` that ran out of string, which ends every search above it.
function recmatch(p, pi, s, si) {
  if (pi >= p.length) return si >= s.length ? 1 : 0
  let c = p[pi++]
  if (c === 0x3f) return si < s.length ? recmatch(p, pi, s, si + 1) : 0
  if (c === 0x2a) {
    if (pi >= p.length) return 1
    for (; si < s.length; si++) {
      const found = recmatch(p, pi, s, si)
      if (found !== 0) return found
    }
    return 2
  }
  if (c === 0x5b) return bracket(p, pi, s, si)
  if (c === 0x5c) {
    if (pi >= p.length) return 0
    c = p[pi++]
  }
  return si < s.length && s[si] === c ? recmatch(p, pi, s, si + 1) : 0
}

function bracket(p, start, s, si) {
  if (si >= s.length) return 0
  const reverse = p[start] === 0x21 || p[start] === 0x5e
  let pi = start + (reverse ? 1 : 0)
  let q = pi
  for (let escaped = false; q < p.length; q++) {
    if (escaped) escaped = false
    else if (p[q] === 0x5c) escaped = true
    else if (p[q] === 0x5d) break
  }
  if (q >= p.length) return 0
  let low = 0
  let escaped = p[pi] === 0x2d
  for (; pi < q; pi++) {
    if (!escaped && p[pi] === 0x5c) escaped = true
    else if (!escaped && p[pi] === 0x2d) low = p[pi - 1]
    else {
      // A character with a `-` after it opens a range rather than standing
      // for itself; the one after the `-` closes it.
      if (p[pi + 1] !== 0x2d && s[si] >= (low || p[pi]) && s[si] <= p[pi]) return reverse ? 0 : recmatch(p, q + 1, s, si + 1)
      low = 0
      escaped = false
    }
  }
  return reverse ? recmatch(p, q + 1, s, si + 1) : 0
}

export const matches = (pattern, name) => recmatch(pattern, 0, name, 0) === 1
