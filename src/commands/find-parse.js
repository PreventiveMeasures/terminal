// Find expression parsing, separate from traversal and action evaluation.
//
// The command line is read the way findutils 4.9 reads it, in its order and
// with its diagnostics: the leading options, the starting points, and then
// the expression in two passes. The first takes each predicate in turn and
// checks its own argument, so a predicate GNU does not have, or one missing
// what it takes, is reported before anything about the shape of the whole;
// the second builds the tree the operators make of the list, with GNU's own
// recursive descent, which is what decides which of its messages a malformed
// expression earns. Only the outer expression is printed by default, and only
// when nothing in it acts on its own.
import { compileGlob } from '../glob.js'
import { lookup } from '../fs.js'
import { err } from '../util.js'
import { unsupported, unsupportedFrom } from '../unsupported.js'
import { INT32_MAX } from '../numeric.js'
import { quoteLocale } from './mkdir.js'

// How tightly each operator binds, as GNU ranks them: a primary and either
// parenthesis bind nothing, and `!` binds tightest.
const COMMA = 1
const OR = 2
const AND = 3
const NEGATE = 4

const PUNCTUATION = {
  __proto__: null,
  '!': { type: 'not', prec: NEGATE }, not: { type: 'not', prec: NEGATE },
  '(': { type: 'open', prec: 0 }, ')': { type: 'close', prec: 0 },
  a: { type: 'binary', op: 'and', prec: AND }, and: { type: 'binary', op: 'and', prec: AND },
  o: { type: 'binary', op: 'or', prec: OR }, or: { type: 'binary', op: 'or', prec: OR },
  ',': { type: 'binary', op: 'comma', prec: COMMA },
}
const PATTERNS = new Set(['name', 'iname', 'path', 'ipath', 'wholename', 'iwholename', 'lname', 'ilname'])
// The rest of GNU's predicates, which this find knows by name and does not
// have: each is refused where it is met, rather than reported as unknown.
const UNMODELLED = new Set([
  'amin', 'anewer', 'atime', 'cmin', 'cnewer', 'ctime', 'context', 'daystart', 'delete', 'executable',
  'execdir', 'files0-from', 'fls', 'follow', 'fprint', 'fprint0', 'fprintf', 'fstype', 'gid', 'group',
  'ignore_readdir_race', 'inum', 'iregex', 'links', 'ls', 'mmin', 'mount', 'mtime', 'newer', 'noleaf',
  'nogroup', 'nouser', 'noignore_readdir_race', 'nowarn', 'warn', 'ok', 'okdir', 'perm', 'printf',
  'quit', 'readable', 'regex', 'regextype', 'samefile', 'uid', 'used', 'user', 'writable', 'xdev',
  'xtype', 'help', '-help', 'version', '-version',
])

// What GNU reads as part of an expression rather than as a starting point:
// a dash and something after it, and `!` and `(` alone — and `)` and `,`
// alone too, once the expression has begun.
const looksLikeExpression = (arg, leading) =>
  arg[0] === '-' ? arg.length > 1 : arg === '!' || arg === '(' || !leading && (arg === ')' || arg === ',')

export function parseFindArgs(tokens, ctx) {
  const p = { tokens, ctx, i: 0, preds: [], depth: { minDepth: 0, maxDepth: Number.POSITIVE_INFINITY, deepestFirst: false }, batches: [], error: null }
  const leading = leadingOptions(p)
  if (leading) return { error: leading }
  const starts = []
  while (p.i < tokens.length && !looksLikeExpression(tokens[p.i], true)) starts.push(tokens[p.i++])
  while (p.i < tokens.length && !p.error) predicate(p)
  if (p.error) return { error: p.error }
  const tree = expressionTree(p.preds)
  if (tree.error) return tree
  return { starts: starts.length ? starts : ['.'], ...p.depth, tree: tree.tree, batches: p.batches }
}

// `-P` is the default this find has, never following a link; `-H` and `-L`
// would follow them, and `-D` and `-O` tune what this find does not have.
function leadingOptions(p) {
  for (; p.i < p.tokens.length; p.i++) {
    const t = p.tokens[p.i]
    if (t === '--') { p.i++; return null }
    if (t === '-P') continue
    if (t === '-H' || t === '-L' || t === '-D' || t.startsWith('-O')) return unsupported('option', 'find', t, `find: unknown option: ${t}`)
    return null
  }
  return null
}

// One predicate off the command line, with whatever argument it takes, onto
// the list — after the `-a` GNU puts between two things that need one. A
// word out of place that names a file is most likely a pattern the shell
// expanded, and GNU says so after the error itself.
function predicate(p) {
  const t = p.tokens[p.i]
  if (!looksLikeExpression(t, false)) {
    const last = p.preds.at(-1)?.name ?? '('
    const hint = lookup(p.ctx.cwd, t, p.ctx.fs).error === null ? `find: possible unquoted pattern after predicate \`${last}'?\n` : ''
    p.error = err(`find: paths must precede expression: \`${t}'\n${hint}`)
    return
  }
  p.i++
  const name = t.startsWith('-') ? t.slice(1) : t
  const punctuation = PUNCTUATION[name]
  if (punctuation) return add(p, { ...punctuation, name: t })
  if (/^-newer..$/u.test(t) || UNMODELLED.has(name)) { p.error = unsupported('option', 'find', t, `find: unknown option: ${t}`); return }
  const primary = primaryOf(p, name, t)
  if (p.error) return
  if (primary === undefined) { p.error = err(`find: unknown predicate \`${t}'`); return }
  add(p, { type: 'primary', prec: 0, name: t, ...primary })
}

function add(p, pred) {
  const last = p.preds.at(-1)
  if ((pred.type === 'primary' || pred.type === 'not' || pred.type === 'open') && (last?.type === 'primary' || last?.type === 'close')) {
    p.preds.push({ type: 'binary', op: 'and', prec: AND, name: '-a' })
  }
  p.preds.push(pred)
}

// What a predicate is, once its argument has been read and checked; nothing
// for a name GNU does not have.
function primaryOf(p, name, t) {
  const missing = () => { p.error = err(`find: missing argument to \`${t}'`) }
  if (['print', 'print0', 'prune', 'empty', 'true', 'false'].includes(name)) return { kind: name, action: name === 'print' || name === 'print0' }
  // `-depth` is the walk's order rather than a question about an entry, so
  // it holds wherever it is written and is true of everything.
  if (name === 'depth' || name === 'd') {
    p.depth.deepestFirst = true
    return { kind: 'true' }
  }
  if (name === 'exec') return execOf(p, t)
  if (!['type', 'size', 'mindepth', 'maxdepth'].includes(name) && !PATTERNS.has(name)) return
  if (p.i === p.tokens.length) return missing()
  const value = p.tokens[p.i++]
  if (name === 'type') return typesOf(p, value)
  if (name === 'size') return sizeOf(p, value)
  if (name === 'mindepth' || name === 'maxdepth') {
    const depth = depthOf(p, t, value)
    if (depth !== null) p.depth[name === 'mindepth' ? 'minDepth' : 'maxDepth'] = depth
    return { kind: 'true' }
  }
  const kind = name === 'wholename' ? 'path' : name === 'iwholename' ? 'ipath' : name
  return { kind, re: compileGlob(value, { ignoreCase: kind.startsWith('i') }) }
}

// A depth is digits and nothing else, read as an int: GNU names the option
// as it was typed and the value as it was given otherwise.
function depthOf(p, t, value) {
  if (!/^\d+$/u.test(value)) {
    p.error = err(`find: Expected a positive decimal integer argument to ${t}, but got ${quoteLocale(value, p.ctx)}`)
    return null
  }
  if (Number(value) > INT32_MAX) { p.error = err(`find: ${value}: Numerical result out of range`); return null }
  return Number(value)
}

// A size is a sign, a count, and the unit it is counted in — and what is
// measured is rounded up to the next whole unit, so `-size 1k` is every file
// from one byte to a thousand and twenty-four. `b` is the unit when none is
// given, which is the half-kilobyte block find has always counted in. GNU
// reads the unit off the end first, then the count, as strtoumax reads one
// after the sign: blanks and a `+` of its own allowed, and nothing past
// what 64 bits hold.
const SIZE_UNITS = { __proto__: null, b: 512, c: 1, w: 2, k: 1024, M: 1048576, G: 1073741824 }
const UINTMAX = 2n ** 64n - 1n

function sizeOf(p, value) {
  if (value === '') { p.error = err('find: invalid null argument to -size'); return }
  const last = value.at(-1)
  const suffixed = !/\d/u.test(last)
  if (suffixed && !(last in SIZE_UNITS)) {
    // GNU prints the one byte, which for a character past ASCII is no
    // character at all.
    p.error = last.codePointAt(0) < 0x80 ? err(`find: invalid -size type \`${last}'`) : unsupported('feature', 'find', '-size type', 'find: a -size type that is not ASCII is not supported')
    return
  }
  const body = suffixed ? value.slice(0, -1) : value
  const sign = body[0] === '+' || body[0] === '-' ? body[0] : ''
  const count = /^[ \t\n\v\f\r]*\+?(\d+)$/u.exec(body.slice(sign.length))
  if (!count || BigInt(count[1]) > UINTMAX) { p.error = err(`find: Invalid argument \`${value}' to -size`); return }
  return { kind: 'size', sign, count: BigInt(count[1]), unit: BigInt(SIZE_UNITS[suffixed ? last : 'b']) }
}

// The types a path-to-content map can hold are files, the directories its
// paths imply, and the links a source entry declares. The devices, pipes and
// sockets GNU also knows are unrepresentable here, so a list GNU would take
// that asks for one is a gap; anything GNU would not take is a typo, and
// GNU's own error. A door is Solaris's, and GNU on Linux says so.
const TYPES = 'bcdflps'
const UNMODELLED_TYPES = 'bcps'

function typesOf(p, value) {
  const fail = (message) => { p.error = err(`find: ${message}`) }
  if (value === '') return fail('Arguments to -type should contain at least one letter')
  const types = []
  for (let at = 0; at < value.length;) {
    const letter = String.fromCodePoint(value.codePointAt(at))
    if (letter === 'D') return fail('-type D is not supported because Solaris doors are not supported on the platform find was compiled on.')
    if (!TYPES.includes(letter)) {
      if (letter.codePointAt(0) >= 0x80) { p.error = unsupported('feature', 'find', '-type', 'find: a -type letter that is not ASCII is not supported'); return }
      return fail(`Unknown argument to -type: ${letter}`)
    }
    if (types.includes(letter)) return fail(`Duplicate file type '${letter}' in the argument list to -type.`)
    types.push(letter)
    at += letter.length
    if (at === value.length) break
    if (value[at] !== ',') return fail("Must separate multiple arguments to -type using: ','")
    if (++at === value.length) return fail("Last file type in list argument to -type is missing, i.e., list is ending on: ','")
  }
  if (types.some((type) => UNMODELLED_TYPES.includes(type))) {
    p.error = unsupported('option', 'find', `-type ${value}`, `find: -type ${value} is not supported (devices, pipes and sockets are not among the entries this filesystem holds)`)
    return
  }
  return { kind: 'type', types }
}

// The command runs to a `;` of its own, or to a `+` straight after a word
// holding `{}`; a batch takes its names in that one `{}`, by itself.
function execOf(p, t) {
  const { tokens } = p
  const start = p.i
  if (start === tokens.length) { p.error = err(`find: missing argument to \`${t}'`); return }
  let end = start
  let braces = 0
  let braceArg = null
  let batch = false
  for (let saw = false; end < tokens.length && tokens[end] !== ';'; end++) {
    if (tokens[end] === '+' && saw) { batch = true; break }
    saw = tokens[end].includes('{}')
    if (saw) { braces++; braceArg = tokens[end] }
  }
  if (end === tokens.length) { p.error = err(`find: missing argument to \`${t}'`); return }
  if (end === start) { p.error = err(`find: invalid argument \`${tokens[end]}' to \`${t}'`); return }
  if (batch && braces > 1) { p.error = err('find: Only one instance of {} is supported with -exec ... +'); return }
  if (batch && braceArg !== '{}') {
    const q = (text) => quoteLocale(text, p.ctx)
    p.error = err(`find: In ${q('-exec ... {} +')} the ${q('{}')} must appear by itself, but you specified ${q(braceArg)}`)
    return
  }
  p.i = end + 1
  const pred = { kind: 'exec', action: true, mode: batch ? 'batch' : 'each', cmd: tokens[start], args: tokens.slice(start + 1, end) }
  if (batch) {
    pred.collected = []
    p.batches.push(pred)
  }
  return pred
}

// The tree the operators make of the list, as GNU builds it: the list is put
// in an outer pair of parentheses of the parser's own, and followed by
// `-print` where nothing in it acts — those are the `(` and `)` GNU's
// messages call artificial, and whose being there decides several of them.
function expressionTree(preds) {
  if (preds.length === 0) return { tree: { type: 'primary', kind: 'print' } }
  const acts = preds.some((pred) => pred.action)
  const list = acts ? preds : [{ type: 'open', prec: 0, name: '(', artificial: true }, ...preds, { type: 'close', prec: 0, name: ')', artificial: true }]
  const s = { list, i: 0 }
  try {
    const tree = expression(s, 0, null)
    if (s.i < list.length) {
      const extra = list[s.i]
      throw new Error(extra.type === 'close' ? "you have too many ')'" : `unexpected extra predicate '${extra.name}'`)
    }
    return { tree: acts ? tree : { type: 'binary', op: 'and', left: tree, right: { type: 'primary', kind: 'print' } } }
  } catch (e) {
    return { error: unsupportedFrom(e, 'find', `find: ${e.message}`) }
  }
}

// GNU's get_expr: one operand — a primary, a negation, or a parenthesized
// expression — and then whatever binds tighter than `prec` to its right.
function expression(s, prec, prev) {
  const pred = s.list[s.i]
  if (pred === undefined) throw new Error('invalid expression')
  let node
  if (pred.type === 'binary') throw new Error(`invalid expression; you have used a binary operator '${pred.name}' with nothing before it.`)
  if (pred.type === 'close') {
    if (prev === null) throw new Error(`invalid expression: expected expression before closing parentheses '${pred.name}'.`)
    if ((prev.type === 'not' || prev.type === 'binary') && !pred.artificial) throw new Error(`expected an expression between '${prev.name}' and ')'`)
    throw new Error(pred.artificial ? `expected an expression after '${prev.name}'` : "invalid expression; you have too many ')'")
  }
  if (pred.type === 'primary') {
    node = pred
    s.i++
  } else if (pred.type === 'not') {
    s.i++
    // The `+` form is true of every name it collects, so a negation of it is
    // false of each, which is what GNU makes of one too.
    node = { type: 'not', operand: expression(s, NEGATE, pred) }
  } else {
    const next = s.list[s.i + 1]
    if (next === undefined || next.artificial) {
      throw new Error(`invalid expression; expected to find a ')' but didn't see one. Perhaps you need an extra predicate after '${pred.name}'`)
    }
    s.i++
    if (next.type === 'close') {
      throw new Error(pred.artificial ? `invalid expression: expected expression before closing parentheses '${next.name}'.` : 'invalid expression; empty parentheses are not allowed.')
    }
    node = expression(s, 0, pred)
    if (s.list[s.i]?.type !== 'close') throw new Error("invalid expression; I was expecting to find a ')' somewhere but did not see one.")
    s.i++
  }
  if (s.i < s.list.length && s.list[s.i].prec > prec) node = rest(s, node, prec)
  return node
}

// GNU's scan_rest: the binary operators that bind tighter than `prec`, each
// taking what has been built so far as its left side.
function rest(s, head, prec) {
  let tree = head
  while (s.i < s.list.length && s.list[s.i].prec > prec) {
    const pred = s.list[s.i]
    if (pred.type !== 'binary') throw new Error('invalid expression')
    s.i++
    tree = { type: 'binary', op: pred.op, left: tree, right: expression(s, pred.prec, pred) }
  }
  return tree
}
