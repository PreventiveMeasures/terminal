import { createTokenizer, tokenize } from './tokenize.js'
import { advanceAliases } from './aliases.js'
import { syntaxLabel } from './lex.js'
import { nestedSyntaxError, syntaxError, unexpectedToken } from './substitution.js'

export { unexpectedToken }

export class IncompleteInput extends Error {
  constructor(error) { super(error.message); this.finalError = error }
}

// Bash's own words for input it cannot read, as an interactive shell prints
// them: one line — the shell's name dropped, as from every diagnostic here,
// and no echo of the source, which only a script's error adds. A grammar
// error names the token it stopped at, and the end of a line is the token
// `newline`; input that ends where the grammar wants more is the end of the
// file, which more input could still have supplied. Inside `$( … )` the
// closing parenthesis is where that input ends.
export const unexpectedEnd = (p) => (p?.closer ? unexpectedToken(p.closer) : new IncompleteInput(syntaxError('syntax error: unexpected end of file', 'end')))
// Where a word was wanted: the token standing there, or — with nothing left
// of a `$( … )` — its closing parenthesis.
export const unexpectedAt = (p, token) => unexpectedToken(token === undefined && p.closer ? p.closer : syntaxLabel(token))

export function tokenAt(p, index = p.i) {
  while (index >= p.raw.length && !p.done) {
    let next
    try { next = p.read() } catch (error) {
      // The tokens ahead of a word the tokenizer cannot finish are bash's
      // to read first, as its reader takes one token at a time: the grammar
      // may fail at one of them, and only past them is the word's error.
      if (!error.tokens) throw error
      next = { tokens: error.tokens, done: true }
      p.lexError = error
    }
    p.raw = next.tokens
    p.done = next.done
  }
  if (index >= p.raw.length && p.lexError) throw p.lexError
  return p.raw[index]
}

function validationOptions(hasCommand, options, parseTokens) {
  const validation = options.validation ?? new Map()
  return { validateSubstitution(command) {
    if (validation.has(command)) return
    try {
      readLine(command, true, hasCommand, { validation, syntaxOnly: true, closer: ')' }, parseTokens)
    } catch (error) { throw nestedSyntaxError(error) }
    validation.set(command, true)
  } }
}

export function readLine(line, writable, hasCommand, options, parseTokens) {
  try {
    let tokens
    try { tokens = tokenize(line, validationOptions(hasCommand, options, parseTokens)) } catch (error) {
      if (!error.tokens) throw error
      return parseTokens(error.tokens, writable, hasCommand, { ...options, lexError: error })
    }
    return parseTokens(tokens, writable, hasCommand, options)
  } catch (error) { throw error instanceof IncompleteInput ? error.finalError : error }
}

// The grammar requests more tokens while retaining its recursive state. Only
// an accepted top-level newline returns control to the execution loop, so a
// unit is parsed no earlier than the caller asks for it.
function unitReader(line, writable, hasCommand, parseTokens) {
  const scanner = createTokenizer(line, validationOptions(hasCommand, {}, parseTokens))
  let aliases = new Set()
  let aliasUsed = false
  return () => {
    const options = { aliases, aliasUsed, read: scanner.read, unit: true }
    const steps = parseTokens([], writable, hasCommand, options)
    aliasUsed = options.aliasUsed
    aliases = advanceAliases(steps, aliases, hasCommand)
    scanner.reset()
    return { steps, done: options.done }
  }
}

// Execution sees unfinished input as the syntax error it ends up being: there
// is no more of it to come.
export function* readUnits(line, writable, hasCommand, parseTokens) {
  const read = unitReader(line, writable, hasCommand, parseTokens)
  for (;;) {
    let unit
    try { unit = read() }
    catch (error) { throw error instanceof IncompleteInput ? error.finalError : error }
    if (unit.steps.length > 0) yield unit.steps
    if (unit.done) return
  }
}

// Reading a line to describe it rather than to run it: every unit up front,
// with the error kept as a value, and the grammar's own unfinished-input
// signal preserved alongside it.
export function readAll(line, writable, hasCommand, parseTokens) {
  const read = unitReader(line, writable, hasCommand, parseTokens)
  const units = []
  for (;;) {
    let unit
    try { unit = read() }
    catch (error) {
      const unfinished = error instanceof IncompleteInput
      return { units, error: unfinished ? error.finalError : error, incomplete: unfinished }
    }
    if (unit.steps.length > 0) units.push(unit.steps)
    if (unit.done) return { units, error: null, incomplete: false }
  }
}
