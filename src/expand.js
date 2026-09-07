// Word expansion, in bash's order: brace expansion, tilde expansion,
// parameter expansion with word splitting of the unquoted results, then
// pathname expansion, and finally quote removal. It runs on the words
// tokenize.js produced — a `value` plus a per-character quoting `mask`
// (`0` bare, `1` hard-quoted, `2` double-quoted) — so a quoted fragment
// only protects its own characters: `"$d"/*.js` still globs, `"*"` and
// `\*` never do, and `"$f"` is never split where `$f` is.
//
// The shell has no environment. What a `$NAME` can find is a `for`
// binding or a `NAME=value` assignment made earlier, plus the handful
// of names the terminal can answer itself (`PWD`, `OLDPWD`, `HOME`,
// `USER`, `LOGNAME`) and the status parameters (`$?`, `$#`, `$@`, `$*`,
// `$1`…`$9`). Anything else expands to nothing, as an unset variable
// does in bash — but with a warning on stderr and an entry on the
// diagnostic channel, because "no environment" is a gap of this
// terminal rather than a fact about the user's shell. `$$`, `$!`, `$0`,
// `$-` and `$_` name process facts that do not exist here; they stay as
// typed, with the same warning.

import { sliceWord } from './word.js'
import { UnsupportedError } from './unsupported.js'
import { expandBraces } from './braces.js'
import { globPaths, hasGlobMeta } from './glob.js'

const SPECIAL = /[?#@*$!0-9_-]/u
const NAME_CHAR = /[A-Za-z0-9_]/u
const PROCESS_PARAMS = new Set(['$', '!', '0', '-', '_'])

// Expand command words and arguments in the same order as bash.
export function expandWords(words, ctx) {
  const out = []
  const warnings = []
  words.forEach((w) => {
    for (const b of expandBraces(w)) {
      // An argument of `export` that looks like an assignment expands as
      // an assignment does — no splitting, no globbing (bash's rule for
      // the declaration builtins) — so `export x=$y` keeps a spaced value.
      if (out[0] === 'export' && assignmentOf(b)) out.push(expandAssignment(b, ctx, warnings))
      else out.push(...expandArg(b, ctx, warnings, true))
    }
  })
  return { argv: out, stderr: warnings.join('') }
}

// One brace product to its argv words: substitution with splitting,
// then pathname expansion (including the command name), then quote
// removal, which drops a bare word that expanded to nothing (`$x`
// unset, `{,a}`'s empty alternative) while `""` and `"$x"` survive.
function expandArg(b, ctx, warnings, glob) {
  const out = []
  for (const word of substitute(tilde(b, ctx), ctx, warnings, true)) {
    if (glob && hasGlobMeta(word)) {
      const matches = globPaths(word, ctx)
      if (matches.length > 0) { out.push(...matches); continue }
    }
    if (word.value !== '' || word.q) out.push(word.value)
  }
  return out
}

// A redirect operand: expanded like an argument, and required to come
// out as exactly one word — bash's "ambiguous redirect" otherwise, for
// a glob with several matches, a split value, or an empty one.
export function expandRedirect(word, ctx, warnings) {
  const out = []
  for (const b of expandBraces(word)) out.push(...expandArg(b, ctx, warnings, true))
  return out.length === 1 ? { value: out[0] } : { error: `${word.value}: ambiguous redirect` }
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/u

// `NAME=` with the name and `=` unquoted, or null.
function assignmentOf(w) {
  const m = ASSIGNMENT.exec(w.value)
  if (!m || (w.mask !== null && /[12]/u.test(w.mask.slice(0, m[0].length)))) return null
  return m[0].length
}

function expandAssignment(w, ctx, warnings) {
  const eq = assignmentOf(w)
  const rest = sliceWord(w, eq)
  return w.value.slice(0, eq) + expandScalar(rest, ctx, warnings, true)
}

// A single word expanded without splitting or globbing — an assignment
// value, a here-string, a here-document. Braces are left alone too, as
// bash leaves them in an assignment. `assignmentValue` marks the right-
// hand side of an assignment, where a `:` also starts a tilde-prefix.
export function expandScalar(word, ctx, warnings = [], assignmentValue = false) {
  return substitute(tilde(word, ctx, assignmentValue), ctx, warnings, false).map((p) => p.value).join('')
}

// The home directory: an assigned `HOME` wins over the terminal's own.
export const homeOf = (ctx) => ctx.vars.get('HOME') ?? ctx.home

const maskAt = (w, i) => (w.mask === null ? '0' : w.mask[i])

// Tilde expansion: a bare `~` (alone, or before a bare `/`) at the
// start of the word is the home directory. In a word that looks like an
// assignment (`root=~`, `PATH=a:~/bin`) bash also expands after the
// first bare `=` and after each bare `:` beyond it, and a `:` ends the
// prefix there; an assignment's value gets the same treatment on its
// own. Named users and stack references are diagnosed; a quoted `~`
// and a `~` anywhere else stay literal.
function tilde(w, ctx, assignmentValue = false) {
  if (!w.value.includes('~')) return w
  const v = w.value
  const bare = (i) => maskAt(w, i) === '0'
  const eqLen = assignmentValue ? null : assignmentOf(w)
  const inValue = (i) => assignmentValue || (eqLen !== null && i >= eqLen)
  const home = homeOf(ctx)
  let value = ''
  let mask = ''
  const empty = []
  for (let i = 0; i < v.length; i++) {
    if (w.empty?.includes(i)) empty.push(value.length)
    const prefixStart = i === 0 || i === eqLen || (inValue(i) && v[i - 1] === ':' && bare(i - 1))
    if (prefixStart && v[i] === '~' && bare(i)) {
      const n = v[i + 1]
      if (n && n !== '/' && n !== ':' && bare(i + 1)) throw new UnsupportedError('feature', 'tilde prefix', 'named-user and directory-stack tilde prefixes are not supported')
      const ends = n === undefined || (bare(i + 1) && (n === '/' || (n === ':' && inValue(i))))
      if (ends) {
        // A root home makes `~/x` `/x`, not `//x`.
        const h = home === '/' && n === '/' ? '' : home
        value += h
        mask += '1'.repeat(h.length)
        continue
      }
    }
    value += v[i]
    mask += maskAt(w, i)
  }
  if (w.empty?.includes(v.length)) empty.push(value.length)
  return { value, mask: /[12]/u.test(mask) ? mask : null, ...(empty.length ? { empty } : {}) }
}

const fresh = () => ({ value: '', mask: '', q: false })

function add(word, text, m) {
  word.value += text
  word.mask += m.repeat(text.length)
  if (m !== '0') word.q = true
}

// Replace every reference with its value, splitting the unquoted results
// into words when `split` is set. Each result carries its own mask, so
// the glob step still sees which characters were quoted, plus `q`: was
// anything about this word quoted, which decides whether an empty
// result is an argument (`""`, `"$x"`) or nothing at all (`$x`).
function substitute(w, ctx, warnings, split) {
  const words = []
  let cur = fresh()
  // `""`: nothing to add, but the word was quoted, so it survives.
  if (w.value === '' && w.mask !== null) cur.q = true
  const push = () => { words.push(cur); cur = fresh() }
  for (let i = 0; i <= w.value.length; i++) {
    if (w.empty?.includes(i)) cur.q = true
    if (i === w.value.length) break
    const m = maskAt(w, i)
    const ref = m !== '1' && w.value[i] === '$' ? readRef(w, i, m) : null
    if (!ref) { add(cur, w.value[i], m); continue }
    i += ref.raw.length - 1
    const r = lookup(ref.name, ctx, warnings)
    if (r.literal) { add(cur, ref.raw, m); continue }
    // `"$@"` with no positional parameters is no word at all, where
    // `"$*"` is one empty word; only the quoting of the rest decides.
    if (r.omit) continue
    if (m === '2' || !split) { add(cur, r.value, '2'); continue }
    // IFS splitting of a bare expansion. Leading blanks end the current
    // word (an empty one is dropped, not emitted); each inner piece is a
    // word of its own; the last piece starts the next word.
    const ifs = ctx.vars.get('IFS') ?? ' \t\n'
    if (ifs !== '' && ifs !== ' \t\n') throw new UnsupportedError('feature', 'IFS', 'custom IFS separators are not supported')
    const pieces = ifs === '' ? [r.value] : r.value.split(/[ \t\n]+/u)
    if (pieces.length === 1) { add(cur, pieces[0], '0'); continue }
    if (pieces[0] !== '') add(cur, pieces[0], '0')
    if (cur.value !== '' || cur.q) push()
    for (let k = 1; k < pieces.length - 1; k++) words.push({ value: pieces[k], mask: '0'.repeat(pieces[k].length), q: false })
    cur = fresh()
    if (pieces.at(-1) !== '') add(cur, pieces.at(-1), '0')
  }
  if (cur.value !== '' || cur.q || words.length === 0) push()
  return words
}

// The reference at the `$` at `w.value[i]`, confined to characters that
// share its quoting: `"$x"y` names `x`, not `xy`, and a quoted `"$"`
// followed by a bare name is no reference at all. tokenize.js already
// rejected the unsupported `${…}` forms, so a `${` here is `${NAME}`.
function readRef(w, i, m) {
  const v = w.value
  const same = (j) => j < v.length && maskAt(w, j) === m
  if (v[i + 1] === '{') {
    let j = i + 2
    while (same(j) && v[j] !== '}') j++
    if (!same(j)) return null
    const name = v.slice(i + 2, j)
    return /^(?:[A-Za-z_][A-Za-z0-9_]*|[?#@*$!0-9-])$/u.test(name) ? { name, raw: v.slice(i, j + 1) } : null
  }
  if (!same(i + 1)) return null
  const c = v[i + 1]
  if (SPECIAL.test(c) && !(c === '_' && same(i + 2) && NAME_CHAR.test(v[i + 2]))) return { name: c, raw: v.slice(i, i + 2) }
  if (!/[A-Za-z_]/u.test(c)) return null
  let j = i + 2
  while (same(j) && NAME_CHAR.test(v[j])) j++
  return { name: v.slice(i + 1, j), raw: v.slice(i, j) }
}

function lookup(name, ctx, warnings) {
  if (name === '?') return { value: String(ctx.lastExit) }
  if (name === '#') return { value: '0' }
  if (name === '@') return { value: '', omit: true }
  if (name === '*' || /^[1-9]$/u.test(name)) return { value: '' }
  if (PROCESS_PARAMS.has(name)) {
    report(ctx, warnings, `$${name}`, `warning: \`$${name}\` is not supported (this terminal runs no process); left as typed`)
    return { literal: true }
  }
  if (ctx.vars.has(name)) return { value: ctx.vars.get(name) }
  if (name === 'PWD') return { value: ctx.cwd }
  if (name === 'HOME') return { value: ctx.home }
  if (name === 'USER' || name === 'LOGNAME') return { value: ctx.user }
  report(ctx, warnings, `$${name}`, `warning: $${name} is unset (this shell has no environment variables; only \`for\` bindings and \`NAME=value\` assignments)`)
  return { value: '' }
}

function report(ctx, warnings, detail, message) {
  warnings.push(message + '\n')
  ctx.unsupported.add({ kind: 'feature', command: null, detail, message })
}
