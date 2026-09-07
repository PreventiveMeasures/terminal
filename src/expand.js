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

import { expandBraces } from './braces.js'
import { globPaths, hasGlobMeta } from './glob.js'

const SPECIAL = /[?#@*$!0-9_-]/u
const NAME_CHAR = /[A-Za-z0-9_]/u
const PROCESS_PARAMS = new Set(['$', '!', '0', '-', '_'])

// Expand a stage's words into argv strings. argv[0] — the command name —
// skips brace and pathname expansion, matching what bash users expect
// from a literal command name (`{ls,pwd}` as a command is not a thing
// anyone types); it still expands `$c`, so `for c in cat wc; do $c f`
// works. Returns the argv plus any warnings for stderr.
export function expandWords(words, ctx) {
  const out = []
  const warnings = []
  words.forEach((w, i) => {
    const braced = i === 0 ? [w] : expandBraces(w)
    for (const b of braced) {
      for (const word of substitute(tilde(b, ctx), ctx, warnings, true)) {
        if (i > 0 && hasGlobMeta(word)) {
          const matches = globPaths(word, ctx)
          if (matches.length > 0) { out.push(...matches); continue }
        }
        // Quote removal drops a bare word that expanded to nothing (`$x`
        // unset, `{,a}`'s empty alternative); `""` and `"$x"` survive.
        if (word.value !== '' || word.q) out.push(word.value)
      }
    }
  })
  return { argv: out, stderr: warnings.join('') }
}

// A single word expanded without splitting or globbing — an assignment
// value, a redirect target, a here-string. Braces are left alone too, as
// bash leaves them in an assignment.
export function expandScalar(word, ctx, warnings = []) {
  return substitute(tilde(word, ctx), ctx, warnings, false).map((p) => p.value).join('')
}

const maskAt = (w, i) => (w.mask === null ? '0' : w.mask[i])

// `~` and `~/…`, unquoted and leading: the home directory. `~user` and
// a `~` anywhere else stay literal, as in bash for an unknown user.
function tilde(w, ctx) {
  if (w.value[0] !== '~' || maskAt(w, 0) !== '0') return w
  const rest = w.value.slice(1)
  if (rest !== '' && !(rest[0] === '/' && maskAt(w, 1) === '0')) return w
  // A root home makes `~/x` `/x`, not `//x`.
  const home = ctx.home === '/' && rest !== '' ? '' : ctx.home
  const restMask = w.mask === null ? '0'.repeat(rest.length) : w.mask.slice(1)
  return { value: home + rest, mask: '1'.repeat(home.length) + restMask }
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
  for (let i = 0; i < w.value.length; i++) {
    const m = maskAt(w, i)
    const ref = m !== '1' && w.value[i] === '$' ? readRef(w, i, m) : null
    if (!ref) { add(cur, w.value[i], m); continue }
    i += ref.raw.length - 1
    const r = lookup(ref.name, ctx, warnings)
    if (r.literal) { add(cur, ref.raw, m); continue }
    if (m === '2' || !split) { add(cur, r.value, '2'); continue }
    // IFS splitting of a bare expansion. Leading blanks end the current
    // word (an empty one is dropped, not emitted); each inner piece is a
    // word of its own; the last piece starts the next word.
    const pieces = r.value.split(/[ \t\n]+/u)
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
  if (name === '@' || name === '*' || /^[1-9]$/u.test(name)) return { value: '' }
  if (PROCESS_PARAMS.has(name)) {
    report(ctx, warnings, `$${name}`, `warning: \`$${name}\` is not supported (this terminal runs no process); left as typed`)
    return { literal: true }
  }
  if (ctx.vars.has(name)) return { value: ctx.vars.get(name) }
  if (name === 'PWD') return { value: ctx.cwd }
  if (name === 'HOME') return { value: ctx.home }
  if (name === 'USER' || name === 'LOGNAME') return { value: ctx.user }
  if (name === 'OLDPWD' && ctx.oldpwd !== null) return { value: ctx.oldpwd }
  report(ctx, warnings, `$${name}`, `warning: $${name} is unset (this shell has no environment variables; only \`for\` bindings and \`NAME=value\` assignments)`)
  return { value: '' }
}

function report(ctx, warnings, detail, message) {
  warnings.push(message + '\n')
  ctx.unsupported.add({ kind: 'feature', command: null, detail, message })
}
