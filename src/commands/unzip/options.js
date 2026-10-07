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

// What UnZip prints where it is given no archive: on stdout, and a success,
// where it was given nothing at all; otherwise an error, on stderr — or on
// stdout, where `-t` sends everything.
const USAGE = [
  'UnZip 6.00 of 20 April 2009, by Debian. Original by Info-ZIP.',
  '',
  'Usage: unzip [-Z] [-opts[modifiers]] file[.zip] [list] [-x xlist] [-d exdir]',
  '  Default action is to extract files in list, except those in xlist, to exdir;',
  '  file[.zip] may be a wildcard.  -Z => ZipInfo mode ("unzip -Z" for usage).',
  '',
  '  -p  extract files to pipe, no messages     -l  list files (short format)',
  '  -f  freshen existing files, create none    -t  test compressed archive data',
  '  -u  update files, create if necessary      -z  display archive comment only',
  '  -v  list verbosely/show version info       -T  timestamp archive to latest',
  '  -x  exclude files that follow (in xlist)   -d  extract files into exdir',
  'modifiers:',
  '  -n  never overwrite existing files         -q  quiet mode (-qq => quieter)',
  '  -o  overwrite files WITHOUT prompting      -a  auto-convert any text files',
  '  -j  junk paths (do not make directories)   -aa treat ALL files as text',
  '  -U  use escapes for all non-ASCII Unicode  -UU ignore any Unicode fields',
  '  -C  match filenames case-insensitively     -L  make (some) names lowercase',
  '  -X  restore UID/GID info                   -V  retain VMS version numbers',
  '  -K  keep setuid/setgid/tacky permissions   -M  pipe through "more" pager',
  '  -O CHARSET  specify a character encoding for DOS, Windows and OS/2 archives',
  '  -I CHARSET  specify a character encoding for UNIX and other archives',
  '',
  'See "unzip -hh" or unzip.txt for more help.  Examples:',
  '  unzip data1 -x joe   => extract all files except joe from zipfile data1.zip',
  '  unzip -p foo | more  => send contents of foo.zip via pipe into program more',
  '  unzip -fo foo ReadMe => quietly replace existing ReadMe if archive file newer',
].join('\n') + '\n'

export function parseUnzip(tokens) {
  const opts = { modes: new Set(), lists: 0, quiet: 0, overwriteAll: false, overwriteNone: false, junk: false, exdir: null, archive: null, members: [], excludes: [] }
  let i = 0
  // A word of options may be `-` alone, which says nothing, and a `-` among
  // the letters negates those after it, which is a reading this does not take.
  let negated = false
  for (; i < tokens.length && tokens[i].startsWith('-'); i++) {
    const word = tokens[i]
    for (let j = 1; j < word.length; j++) {
      const letter = word[j]
      if (letter === '-') { negated = true; continue }
      if (negated) throw new UnsupportedError('option', '--', 'negating an option with `-` is not supported')
      if (letter === 'd') {
        opts.exdir = j + 1 < word.length ? word.slice(j + 1) : tokens[++i]
        if (opts.exdir === undefined) return NO_EXDIR
        break
      }
      if (letter === 'l') opts.lists++
      if (MODES[letter]) opts.modes.add(MODES[letter])
      else if (letter === 'q') opts.quiet++
      else if (letter === 'o') opts.overwriteAll = true
      else if (letter === 'n') opts.overwriteNone = true
      else if (letter === 'j') opts.junk = true
      else throw new UnsupportedError('option', `-${letter}`, `unknown option: -${letter}`)
    }
  }
  if (opts.modes.size > 1) throw new UnsupportedError('option', 'modes', 'combining -c, -l, -p, -t and -v is not supported')
  if (i >= tokens.length) {
    // -v, and a second -l, with no archive print what this UnZip was built
    // with instead, which is not this one's to say.
    if (opts.modes.has('verbose') || opts.lists > 1) throw new UnsupportedError('feature', 'version', 'printing the version summary is not supported')
    if (tokens.length === 0) return { usage: { text: USAGE, status: 0, fd: 1 } }
    return { usage: { text: USAGE, status: 10, fd: opts.modes.has('test') ? 1 : 2 } }
  }
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
  // UnZip counts -l, and a second asks for its verbose listing, as -v does.
  const [first = 'extract'] = opts.modes
  const mode = first === 'list' && opts.lists > 1 ? 'verbose' : first
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
