// Find expression parsing, separate from traversal and action evaluation.
import { compileGlob } from '../glob.js'
import { err, parseNonNegativeInt } from '../util.js'
import { unsupported } from '../unsupported.js'

const VALUE_PRIMARIES = new Set(['name', 'iname', 'type', 'path', 'ipath', 'mindepth', 'maxdepth'])
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
  const kind = t.startsWith('--') ? t.slice(2) : t.startsWith('-') ? t.slice(1) : null
  if (['print', 'print0', 'prune', 'empty'].includes(kind)) {
    if (kind === 'print' || kind === 'print0') p.hasAction = true
    return { kind, negate }
  }
  if (kind === 'exec') {
    const r = consumeExec(p.tokens, p.i - 1, negate)
    if (r.error) { p.error = r.error; return null }
    p.i = r.nextI + 1; p.hasAction = true
    if (r.pred.mode === 'batch') p.batches.push(r.pred)
    return r.pred
  }
  if (VALUE_PRIMARIES.has(kind)) {
    if (p.i === p.tokens.length) { p.error = err(`find: ${t} requires a value`); return null }
    const r = valuePredicate(kind, p.tokens[p.i++], negate, p.depth)
    if (r.error) { p.error = r.error; return null }
    return r
  }
  if (t === ',') { p.error = unsupported('feature', 'find', 'comma operator', 'find: comma expressions are not supported'); return null }
  if (p.i - 1 > from && !t.startsWith('-')) { p.error = err(`find: -not must be followed by a primary, got: ${t}`); return null }
  p.error = t === '--' || !t.startsWith('-') ? err(`find: paths must precede expression: ${t}`)
    : unsupported('option', 'find', t, `find: unknown option: ${t}`)
  return null
}

function valuePredicate(kind, value, negate, depth) {
  if (kind === 'type') {
    const checked = parseTypes(value)
    return checked.error ? checked : { kind, negate, types: checked.types }
  }
  if (kind === 'mindepth' || kind === 'maxdepth') {
    const count = parseNonNegativeInt(value, `find: -${kind}`, value, { max: 2147483647, digitsOnly: true })
    if (count.error) return count
    depth[kind === 'mindepth' ? 'minDepth' : 'maxDepth'] = count.value
    return { kind: 'true', negate }
  }
  return { kind, negate, re: compileGlob(value, { ignoreCase: kind === 'iname' || kind === 'ipath' }) }
}

// Known but unrepresentable file types are unsupported; invalid types are errors.
const UNMODELLED_TYPES = 'lbcps'

function parseTypes(value) {
  const types = value.split(',')
  const duplicate = types.find((type, i) => types.indexOf(type) !== i)
  if (duplicate !== undefined) return { error: err(`find: Duplicate file type '${duplicate}' in the argument list to -type.`) }
  if (types.every((type) => type === 'f' || type === 'd')) return { types }
  const message = `find: -type/--type expects 'f' or 'd', got: ${value}`
  const known = types.every((type) => type.length === 1 && ('fd' + UNMODELLED_TYPES).includes(type))
  return { error: known ? unsupported('option', 'find', `-type ${value}`, message) : err(message) }
}

// The '+' terminator follows {}; other '+' arguments are ordinary text.
// Each batched predicate owns its collector, independent of other -exec terms.
function consumeExec(tokens, i, pendingNot) {
  let j = i + 1
  while (j < tokens.length && tokens[j] !== ';' && !(tokens[j] === '+' && tokens[j - 1] === '{}')) j++
  if (j >= tokens.length) return { error: err("find: -exec: missing terminator (`;` or `{} +`); quote or escape `;`") }
  if (j === i + 1) return { error: err('find: -exec: requires a command') }
  const execTokens = tokens.slice(i + 1, j)
  const mode = tokens[j] === ';' ? 'each' : 'batch'
  if (mode === 'batch') {
    // Batched substitution permits exactly one standalone {}, at the end.
    if (execTokens.slice(0, -1).some((t) => t.includes('{}'))) {
      return { error: err('find: -exec ... +: only one instance of `{}` is supported') }
    }
    // Batched execution has no per-entry status to negate.
    if (pendingNot) {
      return { error: unsupported('feature', 'find', '-not -exec ... +', 'find: `-not -exec ... +` is not supported (the `+` form has no meaningful negation)') }
    }
  }
  const pred = { kind: 'exec', mode, cmd: execTokens[0], args: execTokens.slice(1), negate: pendingNot }
  if (mode === 'batch') pred.collected = []
  return { pred, nextI: j }
}
