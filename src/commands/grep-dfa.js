// The dfa matcher's lexer, for what GNU grep says of its patterns once glibc
// has taken every one of them (./grep-syntax.js): dfa.c's lex, followed as it
// is written as far as it warns or stops, and building nothing.
import { encodeUtf8Loose } from '../util.js'
import { RE_DUP_MAX, utf8Width } from '../regcomp.js'

// An error of the dfa's, which grep reports as the dfa words it.
function regError(message) {
  const e = new Error(message)
  e.gnuRegex = true
  return e
}

const WRAP = {
  ere: { line: ['^(', ')$'], word: ['(^|[^[:alnum:]_])(', ')([^[:alnum:]_]|$)'] },
  bre: { line: ['^\\(', '\\)$'], word: ['\\(^\\|[^[:alnum:]_]\\)\\(', '\\)\\([^[:alnum:]_]\\|$\\)'] },
}

// The dfa's lexer over every pattern at once, one to a line, wrapped as grep
// wraps them for -x or -w: what it warns of, and the error it stops at. Its
// parser only ever rejects what glibc has rejected first, so the lexer is all
// that is left to say anything. `laststart` is the lexer's own: whether what
// comes next begins an expression, where a repetition repeats nothing. An ERE
// warns of one there; a BRE reads it as the character it is.
export function dfaDiagnostics(patterns, { extended, lines = false, words = false }) {
  const wrap = lines || words ? WRAP[extended ? 'ere' : 'bre'][lines ? 'line' : 'word'] : ['', '']
  const s = encodeUtf8Loose(wrap[0] + patterns.join('\n') + wrap[1])
  const warnings = []
  const lexer = { s, i: 0, laststart: true, lasttok: 'END', parens: 0, extended, warn: (text) => warnings.push(`grep: warning: ${text}\n`) }
  try {
    while (lex(lexer) !== 'END');
  } catch (e) {
    if (e.gnuRegex) return { warnings, error: `grep: ${e.message}\n` }
    throw e
  }
  return { warnings, error: null }
}

// One call of dfa.c's lex. A byte past ASCII starts a character that is
// never syntax.
function lex(l) {
  const { s } = l
  let backslash = false
  for (;;) {
    if (l.i >= s.length) return (l.lasttok = 'END')
    const c = s[l.i]
    l.i += c >= 0x80 ? utf8Width(c) : 1
    const ch = c >= 0x80 ? '' : String.fromCodePoint(c)
    if (ch !== '\\' || backslash) return token(l, ch, backslash)
    if (l.i >= s.length) throw regError('unfinished \\ escape')
    backslash = true
  }
}

const ANCHOR_ESCAPES = new Set(['`', '\'', '<', '>', 'b', 'B'])

// What lex returns for `ch`, after a backslash or not. A BRE spells `\?`,
// `\+`, `\{`, `\|`, `\(` and `\)` where an ERE spells them bare; spelt the
// other way, each is the character.
function token(l, ch, backslash) {
  const bare = backslash === !l.extended
  const give = (type) => (l.lasttok = type)
  const normal = () => { l.laststart = false; return give('CHAR') }
  if (backslash && /[1-9]/u.test(ch)) { l.laststart = false; return give('BACKREF') }
  if (backslash && ANCHOR_ESCAPES.has(ch)) return give('ANCHOR')
  if (ch === '^' && !backslash) {
    return l.extended || ['END', 'LPAREN', 'OR'].includes(l.lasttok) ? give('BEGLINE') : normal()
  }
  if (ch === '$' && !backslash) return l.extended || dollarAnchors(l.s, l.i) ? give('ENDLINE') : normal()
  if (ch === '*' ? !backslash : (ch === '?' || ch === '+') && bare) {
    if (!l.laststart) return give('REPEAT')
    if (!l.extended) return normal()
    l.warn(`${ch} at start of expression`)
    return give('REPEAT')
  }
  if (ch === '{' && bare) return interval(l, backslash) ? give('REPMN') : normal()
  if ((ch === '|' && bare) || (ch === '\n' && !backslash)) { l.laststart = true; return give('OR') }
  if (ch === '(' && bare) { l.parens++; l.laststart = true; return give('LPAREN') }
  if (ch === ')' && bare && !(l.parens === 0 && l.extended)) { l.parens--; l.laststart = false; return give('RPAREN') }
  if (ch === '[' && !backslash) { l.laststart = false; bracket(l); return give('CSET') }
  return normal()
}

// A BRE `$` is an anchor at the end, before a newline, and before `\)` or
// `\|` — or a bare `)` or `|` with something after it, which the dfa reads
// the same way.
function dollarAnchors(s, at) {
  const left = s.length - at
  if (left === 0 || s[at] === 0x0a) return true
  const next = s[at + (s[at] === 0x5c ? 1 : 0)]
  return left > 1 && (next === 0x29 || next === 0x7c)
}

// dfa.c's lex for `{`: an interval it can read is one, and one it cannot is
// the character `{` in an ERE and an error in a BRE — unless it comes where
// an expression begins, where a BRE reads `\{` as the character and an ERE
// warns. Whether it took the interval.
function interval(l, backslash) {
  const { s, extended } = l
  let p = l.i
  let minrep = -1
  let maxrep = -1
  const digit = () => p < s.length && s[p] >= 0x30 && s[p] <= 0x39
  const more = (n) => (n < 0 ? s[p] - 0x30 : Math.min(RE_DUP_MAX + 1, n * 10 + s[p] - 0x30))
  for (; digit(); p++) minrep = more(minrep)
  if (p < s.length && s[p] === 0x2c) {
    if (minrep < 0) minrep = 0
    for (p++; digit(); p++) maxrep = more(maxrep)
  } else if (p < s.length) maxrep = minrep
  const valid = (!backslash || (p < s.length && s[p++] === 0x5c)) && p < s.length && s[p++] === 0x7d &&
    minrep >= 0 && (maxrep < 0 || minrep <= maxrep)
  if (!valid && extended) return false
  if (l.laststart) {
    if (!extended) return false
    l.warn('{...} at start of expression')
  }
  if (!valid) throw regError('invalid content of \\{\\}')
  if (RE_DUP_MAX < maxrep) throw regError('regular expression too big')
  l.i = p
  l.laststart = false
  return true
}

// dfa.c's parse_bracket_exp, for what it says rather than what it holds: a
// bracket whose first and last members are `:`, with something else between
// and nothing more to it — `[:space:]` — is taken for a class spelt without
// its outer bracket, and rejected. A range, a class or a collating element
// in it rules that out.
function bracket(l) {
  const { s } = l
  const next = () => {
    if (l.i >= s.length) throw regError('unbalanced [')
    const c = s[l.i]
    l.i += c >= 0x80 ? utf8Width(c) : 1
    return c
  }
  let c = next()
  if (c === 0x5e) c = next()
  let state = c === 0x3a ? 1 : 0
  let c1
  do {
    c1 = -1
    state &= ~2
    if (c === 0x5b) {
      c1 = next()
      if (c1 === 0x3a || c1 === 0x2e || c1 === 0x3d) {
        do c = next(); while (l.i < s.length && !(c === c1 && s[l.i] === 0x5d))
        next()
        state |= 8
        c1 = next()
        continue
      }
    }
    if (c1 === -1) c1 = next()
    if (c1 === 0x2d) {
      let c2 = next()
      if (c2 === 0x5b && s[l.i] === 0x2e) c2 = 0x5d
      if (c2 === 0x5d) l.i--
      else {
        state |= 8
        c1 = next()
        if (c !== c2 || c >= 0x80) continue
      }
    }
    state |= c === 0x3a ? 2 : 4
  } while ((c = c1) !== 0x5d)
  if (state === 7) throw regError('character class syntax is [[:space:]], not [:space:]')
}
