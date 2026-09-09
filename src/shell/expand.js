// Bash expansion order: braces, tilde, substitutions and word splitting, then globs.
// Quoting is per character: "$d"/*.js still globs, while "$f" never splits.
// Bindings and a few shell-derived variables exist here; unknown environment
// names expand to nothing with a warning and an unsupported entry. Process
// parameters such as $$ remain literal with the same diagnostic.

import { assignmentOf, sliceWord } from './word.js'
import { UnsupportedError } from '../unsupported.js'
import { expandBraces } from './braces.js'
import { globPaths, hasGlobMeta } from '../glob.js'
import { readExpansion, scanRef } from './lex.js'

const PROCESS_PARAMS = new Set(['$', '!', '0', '-', '_'])

export function expandWords(words, ctx) {
  const out = []
  const warnings = []
  for (const w of words) {
    for (const b of expandBraces(w)) {
      // An argument of `export` that looks like an assignment expands as
      // an assignment does — no splitting, no globbing (bash's rule for
      // the declaration builtins) — so `export x=$y` keeps a spaced value.
      const assignment = ctx.registry.resolveCommand(out[0] ?? '') === 'export' && assignmentOf(b)
      if (assignment) out.push(expandAssignment(b, assignment.end, ctx, warnings))
      else out.push(...expandArg(b, ctx, warnings))
    }
  }
  return { argv: out, stderr: warnings.join('') }
}

// Drop unquoted empty results, retain quoted empties, and leave unmatched
// globs literal. The command name undergoes pathname expansion too.
function expandArg(b, ctx, warnings) {
  const out = []
  for (const word of substitute(tilde(b, ctx), ctx, warnings, true)) {
    if (hasGlobMeta(word)) {
      const matches = globPaths(word, ctx)
      if (matches.length > 0) { out.push(...matches); continue }
    }
    if (word.value !== '' || word.q) out.push(word.value)
  }
  return out
}

// Redirect expansion must produce exactly one word; zero or several is an
// ambiguous redirect, including results of splitting and pathname expansion.
export function expandRedirect(word, ctx, warnings) {
  const out = []
  for (const b of expandBraces(word)) out.push(...expandArg(b, ctx, warnings))
  return out.length === 1 ? { value: out[0] } : { error: `${word.value}: ambiguous redirect` }
}

function expandAssignment(w, eq, ctx, warnings) {
  const rest = sliceWord(w, eq)
  return w.value.slice(0, eq) + expandScalar(rest, ctx, warnings, true)
}

// Assignments and here-input expand without splitting or globbing.
// assignmentValue additionally allows tilde prefixes after ':'.
export function expandScalar(word, ctx, warnings = [], assignmentValue = false) {
  return substitute(tilde(word, ctx, assignmentValue), ctx, warnings, false)[0].value
}

export const homeOf = (ctx) => ctx.vars.get('HOME') ?? ctx.home

const maskAt = (w, i) => (w.mask === null ? '0' : w.mask[i])

// Tilde prefixes begin a word or an assignment component (after '=' or ':').
// Named users and directory-stack prefixes are unsupported. Preserve quoted
// tildes and empty-fragment offsets while replacing an unquoted home prefix.
function tilde(w, ctx, assignmentValue = false) {
  if (!w.value.includes('~')) return w
  const v = w.value
  const bare = (i) => maskAt(w, i) === '0'
  const eqLen = assignmentValue ? null : assignmentOf(w)?.end ?? null
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

// Substitution retains per-character quoting for the later glob pass.
// Each field also records quoted emptiness, so an empty "$x" survives.
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
    const active = m !== '1' && w.value[i] === '$'
    const ref = active ? (w.value[i + 1] === '(' ? readExpansion(w.value, i) : scanRef(w.value, i, w.mask)) : null
    if (!ref) { add(cur, w.value[i], m); continue }
    i += ref.raw.length - 1
    const r = ref.command === undefined ? lookup(ref.name, ctx, warnings) : { value: ctx.substitute(ref.command) }
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
    add(cur, pieces[0], '0')
    if (cur.value !== '' || cur.q) push()
    for (let k = 1; k < pieces.length - 1; k++) words.push({ value: pieces[k], mask: '0'.repeat(pieces[k].length), q: false })
    add(cur, pieces.at(-1), '0')
  }
  if (cur.value !== '' || cur.q || words.length === 0) push()
  return words
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
  if (ctx.vars.unsetNames.has(name)) return { value: '' }
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
