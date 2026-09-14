import { createTokenizer, tokenize } from './tokenize.js'
import { advanceAliases } from './aliases.js'

export class IncompleteInput extends Error {
  constructor(error) { super(error.message); this.finalError = error }
}

export const incomplete = (message) => new IncompleteInput(new Error(message))

export function tokenAt(p, index = p.i) {
  while (index >= p.raw.length && !p.done) {
    const next = p.read()
    p.raw = next.tokens
    p.done = next.done
  }
  return p.raw[index]
}

function validationOptions(hasCommand, options, parseTokens) {
  const validation = options.validation ?? new Map()
  return { validateSubstitution(command) {
    if (validation.has(command)) return
    readLine(command, true, hasCommand, { validation, syntaxOnly: true }, parseTokens)
    validation.set(command, true)
  } }
}

export function readLine(line, writable, hasCommand, options, parseTokens) {
  try {
    return parseTokens(tokenize(line, validationOptions(hasCommand, options, parseTokens)), writable, hasCommand, options)
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
