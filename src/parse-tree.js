// Reading a command line without running it, and the tree that comes back.
//
// One `type` per node, operators spelled the way they were written, and no
// field that only says "nothing here". A value is a plain string wherever the
// text is final — `head -20` is `['head', '-20']` — and a word in pieces only
// where expansion still decides it, so reading arguments never means reading
// quoting.

import { createUnsupportedFeed, unsupportedNote } from './unsupported.js'
import { expandBraces, hasBraces } from './shell/braces.js'
import { homePrefixes } from './shell/word.js'
import { readBacktickSubstitution, readExpansion, readProcessSubstitution } from './shell/lex.js'
import { parseAll } from './shell/parse.js'

export function read(line, writable) {
  const feed = createUnsupportedFeed()
  const { units, error, incomplete } = parseAll(line, writable)
  const list = []
  // A gap the tree itself reaches — a `~user` home this shell cannot look up
  // — stops the reading where a syntax error does, and leaves the commands
  // ahead of it readable as one does.
  let refused = null
  try { extend(list, units) } catch (e) {
    if (!unsupportedNote(e)) throw e
    refused = e
  }
  const failure = error ?? refused
  const note = failure === null ? null : unsupportedNote(failure)
  if (note) feed.add(note)
  return {
    ok: failure === null,
    incomplete,
    error: failure === null ? null : failure.message,
    list,
    unsupported: Object.freeze(feed.entries),
  }
}

// How a command joins the one before it. The first of a list joins nothing.
const OPERATORS = { seq: ';', and: '&&', or: '||' }

// Bash parses one input unit and runs it before reading the next, so the units
// ahead of an error are the ones a terminal would have executed. A newline
// between them separates commands exactly as `;` does, so they flatten into
// one list rather than nesting a level for every reader to unwrap.
const listOf = (units) => extend([], units)

function extend(list, units) {
  for (const steps of units) {
    for (const step of steps) list.push(nodeOf(step, list.length === 0 ? OPERATORS[step.gate] : OPERATORS[step.gate] ?? ';'))
  }
  return list
}

const listFrom = (steps) => steps.map((step) => nodeOf(step, OPERATORS[step.gate]))

// A pipeline of one is that command: the stage is in the grammar, not in what
// the line says. A `!` with no pipeline at all is bash's empty negated
// command, whose status is 1.
function nodeOf(step, op) {
  const { type, ...rest } = step.stages.length === 1 ? stageOf(step.stages[0])
    : step.stages.length === 0 ? { type: 'command', argv: [] }
      : { type: 'pipeline', stages: step.stages.map(stageOf) }
  return {
    type,
    ...(op ? { op } : {}),
    ...(step.negate ? { negate: true } : {}),
    ...(step.background ? { background: true } : {}),
    ...(step.warnings ? { warnings: step.warnings } : {}),
    ...rest,
  }
}

function stageOf(stage) {
  const node = blockOf(stage)
  if (stage.assigns.length > 0) node.assignments = stage.assigns.map((a) => ({ name: a.name, value: valueOf(a.word, ASSIGNED) }))
  if (stage.redirs.length > 0) node.redirects = stage.redirs.map(redirectOf)
  return node
}

// A list of commands is a `list` wherever one appears, as the grammar has it:
// `( list )`, `{ list; }`, `do list; done`, `then list`.
function blockOf(stage) {
  if (stage.group) return { type: stage.isolate ? 'subshell' : 'group', list: listFrom(stage.group) }
  if (stage.loop) return loopOf(stage.loop)
  if (stage.conditional) return ifOf(stage.conditional)
  if (stage.test) return { type: 'test', expression: conditionOf(stage.test) }
  return { type: 'command', argv: stage.words.flatMap(valuesOf) }
}

// A loop is its body and what decides another turn of it: the words a `for`
// takes one at a time, or the list a `while` runs to ask, which `until` reads
// the other way round.
function loopOf(loop) {
  if (loop.words) return { type: 'for', name: loop.name, words: loop.words.flatMap(valuesOf), list: listFrom(loop.body) }
  return { type: loop.until ? 'until' : 'while', condition: listFrom(loop.condition), list: listFrom(loop.body) }
}

function ifOf(conditional) {
  const node = { type: 'if', branches: conditional.branches.map((b) => ({ condition: listFrom(b.condition), list: listFrom(b.body) })) }
  if (conditional.otherwise) node.otherwise = listFrom(conditional.otherwise)
  return node
}

// What the shell will still do to the word a slot holds. Splitting a result
// into fields and matching it as a pattern are the two things quoting turns
// off, so a slot that does neither reads as quoted however it was written: an
// assignment value, a here-string and a `[[ … ]]` operand are all expanded and
// then left alone, and `x=*.js` is the text bash assigns rather than a
// pattern. The one operand quoting still governs is the pattern side of
// `[[ x == y ]]`, which is matched against the other side rather than split.
const WORD = { split: true, glob: true }
const ASSIGNED = { assignment: true }
const SCALAR = {}
const PATTERN = { glob: true }
const PATTERN_OPS = new Set(['==', '=', '!='])

// The one rule the whole tree follows: text that nothing can change any more
// is that text, and everything else is a word in the pieces expansion works
// on — literal runs, and the references and substitutions between them.
function valueOf(w, slot = WORD, braces = false) {
  if (!expandable(w)) return w.value
  const parts = partsOf(w, braces ? { ...slot, braces: true } : slot)
  // One piece is that piece: the word around it says nothing the piece does not.
  return parts.length === 1 ? parts[0] : { type: 'parts', parts }
}

// Brace expansion is the one expansion a line settles on its own: no
// filesystem, no variables, only text, and bash runs it before anything else.
// So a word list is read with its braces already expanded — `a{b,c}` is `ab`
// and `ac` — and only the two places that cannot be keep a `brace` piece: a
// slot that takes a single word, and a group with more products than reading
// a line should make.
const valuesOf = (w) => {
  const products = expand(w)
  return products === null ? [valueOf(w, WORD, true)] : products.map((product) => valueOf(product))
}

// A redirect names one file, so a target that multiplies is an ambiguous
// redirect — what it was written as is all there is to say about it.
function targetOf(w) {
  const products = expand(w)
  return products?.length === 1 ? valueOf(products[0]) : valueOf(w, WORD, true)
}

function expand(w) {
  try { return expandBraces(w) } catch (e) {
    if (unsupportedNote(e)) return null
    throw e
  }
}

// Quoting belongs to a piece rather than to each character: a literal run is
// quoted or it is not, and a reference carries whether its result will be
// split and globbed. An expansion's source never becomes text of its own.
function partsOf(word, slot) {
  const { value } = word
  const mask = word.mask ?? '0'.repeat(value.length)
  const empty = new Set(word.empty ?? [])
  const parts = []
  let text = ''
  let quoted = false
  let start = 0
  // Text nothing can change any more is that text, so neighbouring runs of it
  // are one piece however each was quoted: `a"b"` is `ab`.
  const push = (piece) => {
    const last = parts.at(-1)
    if (typeof piece === 'string' && typeof last === 'string') parts[parts.length - 1] = last + piece
    else parts.push(piece)
  }
  const flush = (end) => {
    if (text !== '') push(textOf(word, text, quoted, start, end, slot))
    text = ''
  }
  // Matching without splitting is the pattern side of `[[ x == y ]]`, and the
  // only slot where what a reference comes back as is read rather than
  // compared. Everywhere else matching travels with splitting, which `multi`
  // already answers, so there is nothing left for a piece to say.
  const matches = slot.glob === true && slot.split !== true
  const homes = homePrefixes(word, slot.assignment === true)
  for (let i = 0; i <= value.length; i++) {
    // An empty quoted fragment is a piece: `$x""` keeps a final empty field.
    if (empty.has(i)) { flush(i); push('') }
    if (i === value.length) break
    // A `~` prefix is the home directory under another spelling, so that is
    // what it reads as, and a reader needs to know only the one thing. Quoted,
    // because tilde expansion is neither split into fields nor matched as a
    // pattern, which is what quoting a reference settles too.
    if (homes.has(i)) { flush(i); push({ type: 'variable', name: 'HOME', multi: false }); continue }
    // `<( … )` is a command whose output the word is a path to, so what it
    // holds is what it runs. Quoting settles it as text: `"<(ls)"` is `<(ls)`.
    if (mask[i] === '0' && (value[i] === '<' || value[i] === '>') && value[i + 1] === '(') {
      const found = processAt(value, i)
      flush(i)
      push(found.part)
      i = found.end - 1
      continue
    }
    const bare = mask[i] !== '1'
    if (bare && (value[i] === '$' || value[i] === '`')) {
      const found = expansionAt(value, i, mask[i] === '2', slot)
      if (found) { flush(i); push(matches && mask[i] !== '2' ? matchedBy(found.part) : found.part); i = found.end - 1; continue }
    }
    if (text !== '' && (mask[i] !== '0') !== quoted) flush(i)
    if (text === '') start = i
    quoted = mask[i] !== '0'
    text += value[i]
  }
  flush(value.length)
  return parts
}

// Quoting settles text, and so does having nothing in it that expands: either
// way the piece is the string itself. What is left says which expansion it is
// waiting for, named for the first one that will reach it — brace expansion
// runs before the pathname matching a product of it may still go through.
function textOf(word, value, quoted, from, to, slot) {
  if (quoted) return value
  if (slot.braces && /[{},]/u.test(value) && hasBraces(word)) return { type: 'brace', source: value }
  if (slot.glob && globbed(word, from, to)) return { type: 'pattern', pattern: value, multi: slot.split === true }
  return value
}

// A bare reference on the pattern side of `[[ x == y ]]` is not text to
// compare but the pattern to compare by, so it stands where a pattern's text
// would: `[[ a == $b ]]` matches by what `b` holds, and `"$b"` is that text.
// A sum is a number, and no pattern syntax survives being one.
const matchedBy = (part) => (part.type === 'variable' || part.type === 'substitution' ? { type: 'pattern', pattern: part, multi: false } : part)

// A run is matched as a pattern once it holds a `*` or `?`, or a `[` that a
// bare `]` closes — which may be in a later run, since quoting inside a
// bracket expression makes its text literal without ending it.
function globbed(word, from, to) {
  for (let i = from; i < to; i++) {
    const ch = word.value[i]
    if (ch === '*' || ch === '?') return true
    if (ch === '[' && closesBracket(word, i)) return true
  }
  return false
}

// A substitution runs commands, so it holds commands: `foo `bar a b c`` names
// `foo` and, inside its argument, `bar`. Writes are read rather than refused
// here however the enclosing terminal is configured, since the commands inside
// run when the substitution expands, not when the line is read. Bash parses a
// backtick that late too, so a body that will not parse keeps its diagnostic
// instead of taking the line down with it.
function substitutionOf(source, mark) {
  const { units, error } = parseAll(source, true)
  return {
    type: 'substitution',
    list: error === null ? listOf(units) : [],
    ...(error === null ? {} : { error: error.message }),
    ...mark,
  }
}

function processAt(value, at) {
  const { raw, command } = readProcessSubstitution(value, at)
  return { part: { type: 'process', op: value[at], list: listOf(parseAll(command, true).units) }, end: at + raw.length }
}

// Re-read the construct from the source the tokenizer copied into the word.
// It parsed once already, so the only question left is what it is.
//
// `multi` is what quoting decides and what a reader of one argument has to
// know: whether what comes back is still one word. Quotes settle it, and so
// does a slot that splits nothing — an assignment value, a here-string, a
// `[[ … ]]` operand — since only its own top level is settled, and the
// commands inside a substitution are read as commands wherever it stands.
function expansionAt(value, at, quoted, slot) {
  const splits = slot.split === true
  const mark = { multi: splits && !quoted }
  if (value[at] === '`') {
    const { raw, command } = readBacktickSubstitution(value, at)
    return { part: substitutionOf(command, mark), end: at + raw.length }
  }
  const ref = readExpansion(value, at, 0, quoted)
  if (!ref) return null
  const end = at + ref.raw.length
  if (ref.command !== undefined) return { part: substitutionOf(ref.command, mark), end }
  // A sum is a number, and no number is two words: nothing splits on a digit
  // here, since a custom `IFS` is refused, and no digit matches a file.
  if (ref.arithmetic !== undefined) return { part: { type: 'arithmetic', source: ref.arithmetic }, end }
  const { name, operator, word } = ref.parameter ?? { name: ref.name, operator: '' }
  const part = { type: 'variable', name, ...(operator ? { operator } : {}), ...(word === undefined ? {} : { operand: word }), ...mark }
  // `"$@"` is the one reference quotes do not settle: a word for each
  // positional parameter, and none at all where a shell has none, as this does.
  if (name === '@' && splits) part.multi = true
  return { part, end }
}

// A word an expansion could still change: a `$` or backtick that quoting has
// not disarmed, or a bare `~`, `*`, `?` or `{`. A `[` counts only once a `]`
// could close it, since a bracket expression nothing closes matches its own
// text and nothing else — which is all `[` in `[ -f x ]` ever is. Masks count
// UTF-16 units, so index the value the same way rather than by code point.
function expandable(word) {
  for (let i = 0; i < word.value.length; i++) {
    const ch = word.value[i]
    const mask = word.mask === null ? '0' : word.mask[i]
    if ((ch === '$' || ch === '`') && mask !== '1') return true
    if (mask !== '0') continue
    if ('~*?{'.includes(ch)) return true
    if ((ch === '<' || ch === '>') && word.value[i + 1] === '(') return true
    if (ch === '[' && closesBracket(word, i)) return true
  }
  return false
}

// Only a bare `]` closes a bracket expression: a quoted one is text the
// pattern has to match, as pathname expansion reads it.
function closesBracket(word, from) {
  for (let i = from + 1; i < word.value.length; i++) {
    if (word.value[i] === ']' && (word.mask === null || word.mask[i] === '0')) return true
  }
  return false
}

// The operator as written carries what separate flags used to: `&>` sends
// stderr along, `>>` appends.
function redirectOf(r) {
  if (r.op === 'dup') return { fd: r.fd, op: '>&', toFd: r.toFd }
  if (r.op === 'close') return { fd: r.fd, op: '>&-' }
  if (r.op === 'text') return { fd: 0, op: '<<', text: r.body, expand: r.expand }
  if (r.op === 'herestring') return { fd: 0, op: '<<<', text: valueOf(r.word, SCALAR) }
  if (r.op === 'read') return { fd: 0, op: '<', target: targetOf(r.word) }
  return { fd: r.fd, op: (r.both ? '&>' : '>') + (r.append ? '>' : ''), target: r.target ?? targetOf(r.word) }
}

function conditionOf(e) {
  if (e.kind === 'and' || e.kind === 'or') return { type: e.kind, left: conditionOf(e.left), right: conditionOf(e.right) }
  if (e.kind === 'not') return { type: 'not', expression: conditionOf(e.expression) }
  if (e.kind === 'unary') return { type: 'unary', op: e.op, word: valueOf(e.word, SCALAR) }
  return { type: 'binary', op: e.op, left: valueOf(e.left, SCALAR), right: valueOf(e.right, PATTERN_OPS.has(e.op) ? PATTERN : SCALAR) }
}
