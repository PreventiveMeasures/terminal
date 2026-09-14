// Reading a command line without running it, and the tree that comes back.
//
// One `type` per node, operators spelled the way they were written, and no
// field that only says "nothing here". A value is a plain string wherever the
// text is final — `head -20` is `['head', '-20']` — and a node only where
// expansion still decides it, so a caller reading arguments never has to read
// quoting masks to do it.

import { createUnsupportedFeed, unsupportedNote } from './unsupported.js'
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
  if (stage.assigns.length > 0) node.assigns = stage.assigns.map((a) => ({ name: a.name, value: valueOf(a.word) }))
  if (stage.redirs.length > 0) node.redirs = stage.redirs.map(redirectOf)
  return node
}

function blockOf(stage) {
  if (stage.group) return { type: stage.isolate ? 'subshell' : 'group', body: listFrom(stage.group) }
  if (stage.loop) return { type: 'for', name: stage.loop.name, words: stage.loop.words.map(valueOf), body: listFrom(stage.loop.body) }
  if (stage.conditional) return ifOf(stage.conditional)
  if (stage.test) return { type: 'test', expression: conditionOf(stage.test) }
  return { type: 'command', argv: stage.words.map(valueOf) }
}

function ifOf(conditional) {
  const node = { type: 'if', branches: conditional.branches.map((b) => ({ condition: listFrom(b.condition), body: listFrom(b.body) })) }
  if (conditional.otherwise) node.otherwise = listFrom(conditional.otherwise)
  return node
}

// The one rule the whole tree follows: text that nothing can change any more
// is that text, and everything else is a word node carrying what was written
// and which of it was quoted.
function valueOf(w) {
  if (!expandable(w)) return w.value
  return {
    type: 'word',
    value: w.value,
    ...(w.mask === null ? {} : { mask: w.mask }),
    ...(w.empty ? { empty: w.empty } : {}),
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
  if (r.op === 'text') return { fd: 0, op: '<<', body: r.body, expand: r.expand }
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
