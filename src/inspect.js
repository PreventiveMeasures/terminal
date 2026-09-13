// Read a command line without running any of it: the shell's own verdict on
// the input, for a caller that wants to look before it runs. Everything here
// comes from parsing, so the gaps only dispatch and expansion can find — an
// unregistered command, an option a command refuses — are not part of it.

import { createUnsupportedFeed, unsupportedNote } from './unsupported.js'
import { parseAll } from './shell/parse.js'

export function inspectLine(line, ctx, reg) {
  const feed = createUnsupportedFeed()
  const { units, error, incomplete } = parseAll(line, ctx.writable, reg.has)
  const note = error === null ? null : unsupportedNote(error)
  if (note) feed.add(note)
  const commands = []
  // Bash parses one input unit and runs it before reading the next, so the
  // units ahead of an error are exactly the ones run() would have executed.
  for (const steps of units) collectCommands(steps, commands, reg)
  return {
    ok: error === null,
    incomplete,
    error: error === null ? null : error.message,
    commands: Object.freeze(commands),
    unsupported: Object.freeze(feed.entries),
  }
}

// A block occupies its whole stage, so a stage is either a nested list or one
// simple command whose first word names it. Assignment-only and redirect-only
// stages name nothing, and a `[[ … ]]` test runs no command at all.
function collectCommands(steps, out, reg) {
  for (const step of steps) {
    for (const stage of step.stages) {
      if (stage.group) collectCommands(stage.group, out, reg)
      else if (stage.loop) collectCommands(stage.loop.body, out, reg)
      else if (stage.conditional) collectConditional(stage.conditional, out, reg)
      else if (stage.words.length > 0) out.push(commandOf(stage.words[0], reg))
    }
  }
}

// Conditions in branch order, each ahead of the body it guards.
function collectConditional(conditional, out, reg) {
  for (const branch of conditional.branches) {
    collectCommands(branch.condition, out, reg)
    collectCommands(branch.body, out, reg)
  }
  if (conditional.otherwise) collectCommands(conditional.otherwise, out, reg)
}

// The registry answers for the name as typed, bin prefixes included. A shell
// builtin reached through one of those prefixes is refused at dispatch, so
// that spelling resolves to nothing this terminal would run.
function commandOf(word, reg) {
  if (expandable(word)) return Object.freeze({ name: null, resolved: null })
  const name = word.value
  const resolved = reg.resolveCommand(name)
  const known = reg.has(resolved) && !(resolved !== name && reg.shellOnly(resolved))
  return Object.freeze({ name, resolved: known ? resolved : null })
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
