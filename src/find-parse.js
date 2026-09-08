// Find expression parsing, separate from traversal and action evaluation.
import { compileGlob } from './glob.js'
import { err, parseNonNegativeInt } from './util.js'
import { unsupported } from './unsupported.js'

const VALUE_PRIMARIES = new Set(['name', 'iname', 'type', 'path', 'mindepth', 'maxdepth'])
const isTok = (t, name) => t === '-' + name || t === '--' + name

export function parseFindArgs(tokens) {
  const p = { tokens, i: 0, depth: { minDepth: 0, maxDepth: Number.POSITIVE_INFINITY }, hasAction: false, batches: [], error: null }
  const starts = []
  if (tokens[0] === '--') p.i++
  // A closing parenthesis is a path until expression parsing has started.
  while (p.i < tokens.length && !/^(?:-.+|!|\()$/u.test(tokens[p.i])) starts.push(tokens[p.i++])
  const groups = expression(p, 0)
  if (p.error) return { error: p.error }
  // Only the outer expression receives implicit printing. Any action in
  // any nested branch suppresses it, including unreachable branches.
  if (!p.hasAction) for (const group of groups) group.push({ kind: 'print' })
  return { starts: starts.length ? starts : ['.'], ...p.depth, groups, batches: p.batches }
}

// OR has lower precedence than explicit or implicit AND. Parentheses
// nest this representation and negation applies to the entire primary.
function expression(p, level) {
  const groups = [[]]
  let rhs = false
  if (level > 128) { p.error = unsupported('feature', 'find', 'expression depth', 'find: expression nesting above 128 is not supported'); return groups }
  while (p.i < p.tokens.length && !p.error) {
    const t = p.tokens[p.i]
    if (t === ')') {
      if (!level) p.error = err('find: unexpected closing parenthesis')
      break
    }
    if (t === '-a' || isTok(t, 'and') || t === '-o' || isTok(t, 'or')) {
      if (rhs || groups.at(-1).length === 0) { p.error = err(`find: ${t} with no left-hand expression`); break }
      if (t === '-o' || isTok(t, 'or')) groups.push([])
      p.i++; rhs = t; continue
    }
    const pred = parsePrimary(p, level)
    if (pred) groups.at(-1).push(pred)
    rhs = false
  }
  if (!p.error && rhs) p.error = err(`find: ${rhs} with no right-hand expression`)
  if (!p.error && level && groups.at(-1).length === 0) p.error = err('find: expected an expression')
  if (!p.error && level) {
    if (p.tokens[p.i] === ')') p.i++
    else p.error = err('find: missing closing parenthesis')
  }
  return groups
}

function parsePrimary(p, level) {
  const from = p.i
  let negate = false
  while (p.tokens[p.i] === '!' || p.tokens[p.i] === '-not') { negate = !negate; p.i++ }
  const t = p.tokens[p.i++]
  if (t === '(') return { kind: 'group', groups: expression(p, level + 1), negate }
  if (t === undefined || t === ')' || t === '-a' || t === '-o' || isTok(t, 'and') || isTok(t, 'or')) {
    p.error = err(`find: -not or operator ${t ?? ''} must be followed by a primary`); return null
  }
  for (const kind of ['print', 'print0', 'prune', 'empty']) {
    if (!isTok(t, kind)) continue
    if (kind === 'print' || kind === 'print0') p.hasAction = true
    return { kind, negate }
  }
  if (isTok(t, 'exec')) {
    const r = consumeExec(p.tokens, p.i - 1, negate)
    if (r.error) { p.error = r.error; return null }
    p.i = r.nextI + 1; p.hasAction = true
    if (r.pred.mode === 'batch') p.batches.push(r.pred)
    return r.pred
  }
  const kind = primaryFor(t)
  if (kind !== null) {
    if (p.i === p.tokens.length) { p.error = err(`find: ${t} requires a value`); return null }
    const r = valuePredicate(kind, p.tokens[p.i++], negate, p.depth)
    if (r.error) { p.error = r.error; return null }
    return r
  }
  if (p.i - 1 > from) { p.error = err(`find: -not must be followed by a primary, got: ${t}`); return null }
  p.error = t === '--' || !t.startsWith('-') ? err(`find: paths must precede expression: ${t}`)
    : unsupported('option', 'find', t, `find: unknown option: ${t}`)
  return null
}

function valuePredicate(primary, value, negate, depth) {
  const checked = checkPrimary(primary, value)
  if (checked.error) return checked
  const pred = { kind: primary, value, negate }
  if (primary === 'mindepth' || primary === 'maxdepth') {
    const count = parseNonNegativeInt(value, `find: -${primary}`)
    if (count.error) return count
    depth[primary === 'mindepth' ? 'minDepth' : 'maxDepth'] = count.value
    pred.kind = 'true'
  }
  if (primary === 'name' || primary === 'path') pred.re = compileGlob(value)
  if (primary === 'iname') pred.re = compileGlob(value, { ignoreCase: true })
  return pred
}

function primaryFor(token) {
  if (token.startsWith('--') && VALUE_PRIMARIES.has(token.slice(2))) return token.slice(2)
  if (token.startsWith('-') && VALUE_PRIMARIES.has(token.slice(1))) return token.slice(1)
  return null
}

// The file types GNU find knows that this one cannot represent: the
// virtual FS has only regular files and the directories implied by
// them, so there is nothing to match a symlink, device, FIFO, or
// socket against. They are a GAP rather than a bad value — `find . -type
// l` is a working GNU invocation — and separating them from a genuine
// typo like `-type q` is the difference between telling a caller "this
// terminal cannot do that" and "you mistyped".
const UNMODELLED_TYPES = 'lbcps'

function checkPrimary(kind, value) {
  if (kind === 'type' && value !== 'f' && value !== 'd') {
    const message = `find: -type/--type expects 'f' or 'd', got: ${value}`
    if (value.length === 1 && UNMODELLED_TYPES.includes(value)) {
      return { error: unsupported('option', 'find', `-type ${value}`, message) }
    }
    return { error: err(message) }
  }
  return {}
}

// Consume the variadic `-exec CMD ARG... ;` or `-exec CMD ARG... {} +`
// starting at tokens[i] (the `-exec`/`--exec` itself). Returns the
// built predicate and the index of the terminator (caller advances
// past it). `+` form requires `{}` as the last argument — POSIX is
// strict here; GNU is too. The collector array lives on the predicate
// so multiple `+` invocations each keep their own batch.
function consumeExec(tokens, i, pendingNot) {
  let j = i + 1
  while (j < tokens.length && tokens[j] !== ';' && !(tokens[j] === '+' && tokens[j - 1] === '{}')) j++
  if (j >= tokens.length) return { error: err("find: -exec: missing terminator (`;` or `{} +`); quote or escape `;`") }
  if (j === i + 1) return { error: err('find: -exec: requires a command') }
  const execTokens = tokens.slice(i + 1, j)
  const mode = tokens[j] === ';' ? 'each' : 'batch'
  if (mode === 'batch') {
    if (execTokens.at(-1) !== '{}') {
      return { error: err('find: -exec ... +: `{}` must be the last argument before `+`') }
    }
    // POSIX/GNU: only one `{}` is allowed in `+` form. Without this
    // check `find … -exec echo {} {} +` would pass the leading `{}`
    // through literally — confusing and inconsistent with GNU's
    // rejection of the same input.
    if (execTokens.slice(0, -1).some((t) => t.includes('{}'))) {
      return { error: err('find: -exec ... +: only one instance of `{}` is supported') }
    }
    // -not on the batch form is incoherent: the predicate is treated
    // as always-true during the walk (a real filter would need to know
    // the outcome before all paths are collected), so negating it
    // would either drop every match silently or run the batched
    // command anyway. Reject up front rather than pick a surprising
    // semantic.
    if (pendingNot) {
      return { error: unsupported('feature', 'find', '-not -exec ... +', 'find: `-not -exec ... +` is not supported (the `+` form has no meaningful negation)') }
    }
  }
  const pred = { kind: 'exec', mode, cmd: execTokens[0], args: execTokens.slice(1), negate: pendingNot }
  if (mode === 'batch') pred.collected = []
  return { pred, nextI: j }
}
