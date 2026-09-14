// Reading a command line without running it, and the tree that comes back.
//
// One `type` per node, operators spelled the way they were written, and no
// field that only says "nothing here". A value is a plain string wherever the
// text is final — `head -20` is `['head', '-20']` — and a word in pieces only
// where expansion still decides it, so reading arguments never means reading
// quoting.

import { createUnsupportedFeed, unsupportedNote } from './unsupported.js'
import { hasBraces } from './shell/braces.js'
import { readBacktickSubstitution, readExpansion } from './shell/lex.js'
import { parseAll } from './shell/parse.js'

export function read(line, writable) {
  const feed = createUnsupportedFeed()
  const { units, error, incomplete } = parseAll(line, writable)
  const note = error === null ? null : unsupportedNote(error)
  if (note) feed.add(note)
  return {
    ok: error === null,
    incomplete,
    error: error === null ? null : error.message,
    list: listOf(units),
    unsupported: Object.freeze(feed.entries),
  }
}

// How a command joins the one before it. The first of a list joins nothing.
const OPERATORS = { seq: ';', and: '&&', or: '||' }

// Bash parses one input unit and runs it before reading the next, so the units
// ahead of an error are the ones a terminal would have executed. A newline
// between them separates commands exactly as `;` does, so they flatten into
// one list rather than nesting a level for every reader to unwrap.
function listOf(units) {
  const list = []
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
    ...(step.warnings ? { warnings: step.warnings } : {}),
    ...rest,
  }
}

function stageOf(stage) {
  const node = blockOf(stage)
  if (stage.assigns.length > 0) node.assignments = stage.assigns.map((a) => ({ name: a.name, value: valueOf(a.word) }))
  if (stage.redirs.length > 0) node.redirects = stage.redirs.map(redirectOf)
  return node
}

// A list of commands is a `list` wherever one appears, as the grammar has it:
// `( list )`, `{ list; }`, `do list; done`, `then list`.
function blockOf(stage) {
  if (stage.group) return { type: stage.isolate ? 'subshell' : 'group', list: listFrom(stage.group) }
  if (stage.loop) return { type: 'for', name: stage.loop.name, words: stage.loop.words.map(valueOf), list: listFrom(stage.loop.body) }
  if (stage.conditional) return ifOf(stage.conditional)
  if (stage.test) return { type: 'test', expression: conditionOf(stage.test) }
  return { type: 'command', argv: stage.words.map(valueOf) }
}

function ifOf(conditional) {
  const node = { type: 'if', branches: conditional.branches.map((b) => ({ condition: listFrom(b.condition), list: listFrom(b.body) })) }
  if (conditional.otherwise) node.otherwise = listFrom(conditional.otherwise)
  return node
}

// The one rule the whole tree follows: text that nothing can change any more
// is that text, and everything else is a word in the pieces expansion works
// on — literal runs, and the references and substitutions between them.
function valueOf(w) {
  if (!expandable(w)) return w.value
  const parts = partsOf(w)
  // One piece is that piece: the word around it says nothing the piece does not.
  return parts.length === 1 ? parts[0] : { type: 'parts', parts }
}

// Quoting belongs to a piece rather than to each character: a literal run is
// quoted or it is not, and a reference carries whether its result will be
// split and globbed. An expansion's source never becomes text of its own.
function partsOf(word) {
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
    if (text !== '') push(textOf(word, text, quoted, start, end))
    text = ''
  }
  for (let i = 0; i <= value.length; i++) {
    // An empty quoted fragment is a piece: `$x""` keeps a final empty field.
    if (empty.has(i)) { flush(i); push('') }
    if (i === value.length) break
    const bare = mask[i] !== '1'
    if (bare && (value[i] === '$' || value[i] === '`')) {
      const found = expansionAt(value, i, mask[i] === '2')
      if (found) { flush(i); push(found.part); i = found.end - 1; continue }
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
function textOf(word, value, quoted, from, to) {
  if (quoted) return value
  if (/[{},]/u.test(value) && hasBraces(word)) return { type: 'brace', source: value }
  if (globbed(word, from, to)) return { type: 'pattern', pattern: value }
  if (from === 0 && value.startsWith('~')) return { type: 'tilde', source: value }
  return value
}

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

// Re-read the construct from the source the tokenizer copied into the word.
// It parsed once already, so the only question left is what it is.
function expansionAt(value, at, quoted) {
  const mark = quoted ? { quoted: true } : {}
  if (value[at] === '`') {
    const { raw, command } = readBacktickSubstitution(value, at)
    return { part: substitutionOf(command, mark), end: at + raw.length }
  }
  const ref = readExpansion(value, at, 0, quoted)
  if (!ref) return null
  const end = at + ref.raw.length
  if (ref.command !== undefined) return { part: substitutionOf(ref.command, mark), end }
  if (ref.arithmetic !== undefined) return { part: { type: 'arithmetic', source: ref.arithmetic, ...mark }, end }
  const { name, operator, word } = ref.parameter ?? { name: ref.name, operator: '' }
  return {
    part: {
      type: 'parameter',
      name,
      ...(operator ? { operator } : {}),
      ...(word === undefined ? {} : { operand: word }),
      ...mark,
    },
    end,
  }
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
  if (r.op === 'herestring') return { fd: 0, op: '<<<', text: valueOf(r.word) }
  if (r.op === 'read') return { fd: 0, op: '<', target: valueOf(r.word) }
  return { fd: r.fd, op: (r.both ? '&>' : '>') + (r.append ? '>' : ''), target: r.target ?? valueOf(r.word) }
}

function conditionOf(e) {
  if (e.kind === 'and' || e.kind === 'or') return { type: e.kind, left: conditionOf(e.left), right: conditionOf(e.right) }
  if (e.kind === 'not') return { type: 'not', expression: conditionOf(e.expression) }
  if (e.kind === 'unary') return { type: 'unary', op: e.op, word: valueOf(e.word) }
  return { type: 'binary', op: e.op, left: valueOf(e.left), right: valueOf(e.right) }
}

// A chain is what a line looks like when nothing in it needs explaining: the
// commands it runs, each stage's argv, each redirect as the tokens it was
// written with. Anything a summary would have to lie about — a block, a
// negation, an assignment, a word an expansion still decides — stops it, so a
// caller either gets the whole line in plain text or hears why it cannot.
//
// A gate stands between the chains it gates, since `&&` and `||` decide
// whether the next one runs at all. A `;` decides nothing, so it is the plain
// sequence the rows already are.
export function summarize(line, writable) {
  const result = read(line, writable)
  if (!result.ok) throw new Error(result.error)
  const summary = []
  for (const node of result.list) {
    if (node.op === '&&' || node.op === '||') summary.push(node.op)
    summary.push(chainOf(node))
  }
  return summary
}

const BLOCKS = { subshell: 'a subshell', group: 'a brace group', for: '`for`', if: '`if`', test: '`[[ … ]]`', pipeline: 'a pipeline of pipelines' }

function chainOf(node) {
  if (node.negate) throw refuse('`!`')
  const stages = node.type === 'pipeline' ? node.stages : [node]
  const chain = []
  for (const [index, stage] of stages.entries()) {
    if (stage.type !== 'command') throw refuse(BLOCKS[stage.type])
    if (stage.assignments) throw refuse('an assignment')
    if (stage.argv.length === 0) throw refuse('a command with no name')
    const redirects = stage.redirects ?? []
    const input = inputOf(redirects, index)
    if (input) chain.push(['cat', literal(input.target)])
    chain.push(stage.argv.map(literal))
    for (const redirect of redirects) {
      if (redirect !== input) chain.push(redirectTokens(redirect))
    }
  }
  return chain
}

// A summary says what a line does, not how it was spelled, so a command
// reading a file is the `cat` that feeds it: `wc < 1.txt` is `cat 1.txt | wc`.
// Only the first stage can be fed that way — a later one reading a file leaves
// the stage before it writing into nothing, which no chain says — and one
// stage reads from one place, so a second source has no equivalent either.
function inputOf(redirects, index) {
  const inputs = redirects.filter((r) => r.op === '<' || r.op === '<<<')
  if (inputs.length === 0) return null
  if (index > 0) throw refuse('a pipeline stage reading its own input')
  if (inputs.length > 1) throw refuse('a command reading from two places')
  if (inputs[0].op === '<<<') throw refuse('a here-string')
  return inputs[0]
}

// The operator as it was typed, with the descriptor it defaults to left off.
function redirectTokens(redirect) {
  const { fd, op } = redirect
  if (op === '<<') throw refuse('a here-document')
  const lead = op.startsWith('&') || fd === 1 ? '' : String(fd)
  if (op === '>&') return [`${lead}>&${redirect.toFd}`]
  if (op === '>&-') return [`${lead}>&-`]
  return [lead + op, literal(redirect.target)]
}

const literal = (value) => {
  if (typeof value === 'string') return value
  const text = literalText(value)
  if (text === null) throw refuse(`${piecesOf(value).map(spell).join('')}`, 'a literal word')
  return text
}

const piecesOf = (value) => value.type === 'parts' ? value.parts : [value]

// `"$(cat <<'EOF' … EOF)"` is the text it holds and nothing else: a literal
// here-document, cat, and the trailing newlines `$( )` strips. Every part has
// to be quoted for that to hold — bare, the text would be split into fields
// and globbed, and no single token would stand for it.
function literalText(value) {
  let text = ''
  for (const part of piecesOf(value)) {
    if (typeof part === 'string') { text += part; continue }
    if (!part.quoted) return null
    const here = heredocText(part)
    if (here === null) return null
    text += here
  }
  return text
}

function heredocText(part) {
  if (part.type !== 'substitution' || part.list.length !== 1) return null
  const [node] = part.list
  if (node.type !== 'command' || node.negate || node.assignments) return null
  if (node.argv.length !== 1 || node.argv[0] !== 'cat') return null
  const [redirect, ...rest] = node.redirects ?? []
  if (rest.length > 0 || redirect?.op !== '<<' || redirect.expand) return null
  return redirect.text.replace(/\n+$/u, '')
}

// Name the piece that needs expanding the way it was written.
const spell = (part) => {
  if (typeof part === 'string') return part
  if (part.type === 'pattern') return part.pattern
  if (part.type === 'brace' || part.type === 'tilde') return part.source
  if (part.type === 'parameter') return `\${${part.name}${part.operator ?? ''}${part.operand ?? ''}}`
  return part.type === 'arithmetic' ? '$((…))' : '$(…)'
}

const refuse = (what, kind = 'a simple chain') => new Error(`summarize: ${what} is not ${kind}`)
