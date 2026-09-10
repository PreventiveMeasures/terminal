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
import { lookupParameter, probeParameter } from './variables.js'
import { evaluateParameter } from './parameter.js'
import { evaluateArithmetic } from './arithmetic.js'
import { tokenizeFragment } from './tokenize.js'
import { withState } from './state.js'

export function expandWords(words, ctx) {
  const out = []
  const command = words[0]
  const declaration = command?.value === 'export' && !/[12]/u.test(command.mask ?? '') && !command.empty?.length
  for (const w of words) {
    for (const b of expandBraces(w)) {
      // Bash marks declaration arguments before expansion. Changing a word
      // through brace expansion discards its assignment expansion flags.
      const assignment = declaration && b === w && assignmentOf(w)
      if (assignment) {
        const value = expandAssignment(b, assignment.end, ctx)
        out.push({ value, mask: '1'.repeat(value.length), q: true })
      } else out.push(...substitute(tilde(b, ctx, b === w ? false : 'word'), ctx, true))
    }
  }
  return { argv: globWords(out, ctx) }
}

// Drop unquoted empty results, retain quoted empties, and leave unmatched
// globs literal. The command name undergoes pathname expansion too.
function globWords(words, ctx) {
  const out = []
  for (const word of words) {
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
export function expandRedirect(word, ctx) {
  const { argv: out } = expandWords([word], ctx)
  return out.length === 1 ? { value: out[0] } : { error: `${word.value}: ambiguous redirect` }
}

function expandAssignment(w, eq, ctx) {
  const rest = sliceWord(w, eq)
  return w.value.slice(0, eq) + expandScalar(rest, ctx, true)
}

// Assignments and here-input expand without splitting or globbing.
// assignmentValue additionally allows tilde prefixes after ':'.
export function expandScalar(word, ctx, assignmentValue = false) {
  return substitute(tilde(word, ctx, assignmentValue), ctx, false, assignmentValue)[0].value
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
  const inValue = (i) => assignmentValue === true || (eqLen !== null && i >= eqLen)
  const home = homeOf(ctx)
  let value = ''
  let mask = ''
  const empty = []
  for (let i = 0; i < v.length; i++) {
    if (w.empty?.includes(i)) empty.push(value.length)
    const prefixStart = i === 0 || i === eqLen || (inValue(i) && v[i - 1] === ':' && bare(i - 1))
    if (prefixStart && v[i] === '~' && bare(i) && unquotedTilde(w, i, inValue(i) || assignmentValue === 'parameterAssign')) {
      const n = v[i + 1]
      if (n && n !== '/' && n !== ':' && bare(i + 1)) throw new UnsupportedError('feature', 'tilde prefix', 'named-user and directory-stack tilde prefixes are not supported')
      const ends = n === undefined || (bare(i + 1) && (n === '/' || (n === ':' && (inValue(i) || assignmentValue === 'parameterAssign'))))
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

function unquotedTilde(w, start, assignment) {
  // Empty quotes also inhibit expansion: ~''/x and ''~/x are literal paths.
  for (let i = start; i <= w.value.length; i++) {
    if (w.empty?.includes(i)) return false
    if (i === w.value.length) return true
    if (maskAt(w, i) !== '0') return false
    if (w.value[i] === '/' || (assignment && w.value[i] === ':')) return true
  }
  return true
}

// Keep quoting until both conditional pattern matching and ordinary shell
// splitting have consumed it. Scalar expansion returns the same value only.
export function expandPattern(word, ctx) {
  return withState(ctx, { strictExpansion: true }, () => expandedWord(tilde(word, ctx), ctx))
}

function substitute(word, ctx, split, assignment = false) {
  const expanded = expandedWord(word, ctx, assignment)
  return split ? splitFields(expanded, ctx) : [expanded]
}

function expandedWord(w, ctx, assignment = false) {
  const out = { value: '', mask: '', empty: [], split: false }
  const append = (value, mask) => { out.value += value; out.mask += mask }
  if (w.value === '' && w.mask !== null) out.empty.push(0)
  for (let i = 0; i <= w.value.length; i++) {
    if (w.empty?.includes(i)) out.empty.push(out.value.length)
    if (i === w.value.length) break
    const m = maskAt(w, i)
    const active = m !== '1' && w.value[i] === '$'
    const compound = w.value[i + 1] === '(' || w.value[i + 1] === '{'
    const ref = active ? (compound ? readExpansion(w.value, i, 0, m === '2') : scanRef(w.value, i, w.mask)) : null
    if (!ref) { append(w.value[i], m); continue }
    i += ref.raw.length - 1
    const r = expansionValue(ref, ctx, m === '2', assignment)
    if (r.literal) { append(ref.raw, m.repeat(ref.raw.length)); continue }
    if (r.omit) continue
    if (m === '2') {
      if (r.value === '') out.empty.push(out.value.length)
      append(r.value, '2'.repeat(r.value.length))
    } else {
      out.split = true
      for (const offset of r.empty ?? []) out.empty.push(out.value.length + offset)
      if (r.q && !r.value && !r.empty?.length) out.empty.push(out.value.length)
      append(r.value, r.mask ?? '0'.repeat(r.value.length))
    }
  }
  out.q = out.empty.length > 0 || /[12]/u.test(out.mask)
  return out
}

function expansionValue(ref, ctx, quoted, assignment) {
  if (ref.command !== undefined) return { value: ctx.substitute(ref.command) }
  if (ref.arithmetic !== undefined) {
    try {
      const source = withState(ctx, { strictExpansion: true }, () => expandScalar(tokenizeFragment(ref.arithmetic, true), ctx))
      return { value: String(evaluateArithmetic(source, ctx)) }
    } catch (error) { error.halt = true; throw error }
  }
  if (ref.parameter !== undefined) {
    if (ref.parameter.operator === '' && !ctx.strictExpansion && !/^[0-9]{2,}$/u.test(ref.parameter.name)) return lookupParameter(ref.parameter.name, ctx)
    return evaluateParameter(ref.parameter, ctx, {
      lookup: (name) => probeParameter(name, ctx),
      readExpansion,
      expand: (source, options = {}) => {
        const operand = options.pattern || options.error || options.replacement || options.arithmetic
        const word = tokenizeFragment(source, options.arithmetic || !operand && quoted)
        const assign = !operand && (options.assignment || assignment)
        const mode = options.assignment ? 'parameterAssign' : assign ? true : 'parameter'
        return withState(ctx, { strictExpansion: true }, () => expandedWord(options.arithmetic ? word : tilde(word, ctx, mode), ctx, assign))
      },
    })
  }
  return ctx.strictExpansion ? probeParameter(ref.name, ctx) : lookupParameter(ref.name, ctx)
}

function splitFields(word, ctx) {
  if (!word.split) return word.value !== '' || word.q ? [word] : []
  const ifs = ctx.vars.get('IFS') ?? ' \t\n'
  if (ifs !== '' && ifs !== ' \t\n') throw new UnsupportedError('feature', 'IFS', 'custom IFS separators are not supported')
  const words = []
  let cur = { value: '', mask: '', q: false }
  const push = () => {
    if (cur.value !== '' || cur.q) words.push(cur)
    cur = { value: '', mask: '', q: false }
  }
  const empties = new Set(word.empty)
  for (let i = 0; i <= word.value.length; i++) {
    if (empties.has(i)) cur.q = true
    if (i === word.value.length) break
    const c = word.value[i], m = word.mask[i]
    if (ifs !== '' && m === '0' && /[ \t\n]/u.test(c)) { push(); continue }
    cur.value += c
    cur.mask += m
    cur.q ||= m !== '0'
  }
  push()
  return words
}
