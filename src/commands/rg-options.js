// ripgrep options are last-one-wins and several are repeatable, so the run is
// decided by walking the parse in order rather than by testing flags. `-i` and
// `-s` cancel each other, `-n` and `-N` cancel each other, `-l`, `-L` and `-c`
// replace each other, and `-u` escalates each time it appears.

import { UnsupportedError } from '../unsupported.js'

const SHORT = ['n', 'N', 'i', 's', 'w', 'F', 'v', 'l', 'c', 'q', 'u', 'a', 'H', 'I']
const LONG = ['line-number', 'no-line-number', 'ignore-case', 'case-sensitive', 'word-regexp',
  'fixed-strings', 'invert-match', 'files-with-matches', 'files-without-match', 'count', 'quiet',
  'hidden', 'no-ignore', 'no-heading', 'with-filename', 'no-filename', 'text', 'unrestricted']
export const ARGS = {
  short: SHORT, long: LONG, valueShort: ['A', 'B', 'C'],
  valueLong: ['after-context', 'before-context', 'context'], repeatable: ['e', 'regexp'],
}

// Long spellings folded onto the short flag that carries the same meaning.
const CANONICAL = new Map(Object.entries({
  'line-number': 'n', 'no-line-number': 'N', 'ignore-case': 'i', 'case-sensitive': 's',
  'word-regexp': 'w', 'fixed-strings': 'F', 'invert-match': 'v', 'files-with-matches': 'l',
  'files-without-match': 'L', count: 'c', quiet: 'q', text: 'a', unrestricted: 'u',
  'with-filename': 'H', 'no-filename': 'I', regexp: 'e',
  'after-context': 'A', 'before-context': 'B', context: 'C',
}))
// Nothing here has an effect: this runtime has no colour and no heading, and
// `--no-ignore` only matters to the ignore-file check the caller makes.
const INERT = new Set(['no-heading', 'no-ignore'])

const gap = (detail, message) => new UnsupportedError('feature', detail, `rg: ${message}`)

export function rgOptions(parsed) {
  const state = {
    patterns: [], context: [], mode: null, showName: null,
    ignoreCase: false, lineNumbers: false, word: false, literal: false,
    invert: false, quiet: false, text: false, hidden: false, unrestricted: 0,
  }
  for (const { name, value } of parsed.order) {
    if (INERT.has(name)) continue
    apply(state, CANONICAL.get(name) ?? name, value)
  }
  // -u reduces filtering one step at a time: ignore files, then hidden entries,
  // then binary files. The third step needs ripgrep's binary reporting.
  if (state.unrestricted >= 2) state.hidden = true
  if (state.unrestricted >= 3) throw gap('-uuu', 'searching binary files is not supported')
  return state
}

function apply(state, flag, value) {
  switch (flag) {
    case 'i': state.ignoreCase = true; return
    case 's': state.ignoreCase = false; return
    case 'n': state.lineNumbers = true; return
    case 'N': state.lineNumbers = false; return
    case 'l': case 'L': case 'c': state.mode = flag; return
    // ripgrep spells these -H and -I; grep spells the second one -h.
    case 'H': state.showName = 'H'; return
    case 'I': state.showName = 'h'; return
    case 'w': state.word = true; return
    case 'F': state.literal = true; return
    case 'v': state.invert = true; return
    case 'q': state.quiet = true; return
    case 'a': state.text = true; return
    case 'e': state.patterns.push(value); return
    case 'hidden': state.hidden = true; return
    case 'u': state.unrestricted++; return
    case 'A': case 'B': case 'C': state.context.push(['-' + flag, value]); return
    default: throw gap(shown(flag), `${shown(flag)} is not supported`)
  }
}

export const shown = (name) => (name.length === 1 ? '-' : '--') + name

// grep -P takes one pattern; ripgrep takes any number and matches their union.
// Wrapping each keeps a trailing alternation or anchor inside its own branch.
export function patternArgs(patterns, literal) {
  // grep -F accepts several patterns; grep -P takes one, so a regex run joins
  // them, wrapping each so a trailing alternation or anchor stays in its branch.
  if (literal) return patterns.flatMap((p) => ['-e', p])
  return ['-e', patterns.length === 1 ? patterns[0] : patterns.map((p) => `(?:${p})`).join('|')]
}

// Rust's regex crate has no backtracking, so these parse there rather than
// matching. PCRE accepts all of them, which would answer where ripgrep errors.
const REJECTED = [
  [/\\[1-9]/u, 'backreference'],
  [/\(\?<?[=!]/u, 'look-around'],
  [/\\[QE]/u, String.raw`\Q…\E literal span`],
]

export function checkPatterns(patterns, literal) {
  if (literal) return
  for (const source of patterns) {
    for (const [re, detail] of REJECTED) {
      if (re.test(source)) throw gap(detail, `${detail} is not supported; ripgrep's regex engine rejects it too`)
    }
  }
}
