import { createTokenizer, tokenize } from './tokenize.js'
import { advanceAliases } from './aliases.js'

export class IncompleteInput extends Error {
  constructor(error) { super(error.message); this.finalError = error }
}

export const incomplete = (message) => new IncompleteInput(new Error(message))

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

// A lexical newline can be inside an unfinished compound command. Retry only
// when the grammar explicitly needs more input; semicolon lists stay atomic.
export function* readUnits(line, writable, hasCommand, parseTokens) {
  const scanner = createTokenizer(line, validationOptions(hasCommand, {}, parseTokens))
  let aliases = new Set()
  let aliasUsed = false
  for (;;) {
    const { tokens, done } = scanner.read()
    let steps
    const options = { aliases, aliasUsed }
    try { steps = parseTokens(tokens, writable, hasCommand, options) }
    catch (error) {
      if (!(error instanceof IncompleteInput)) throw error
      if (done) throw error.finalError
      continue
    }
    aliasUsed = options.aliasUsed
    aliases = advanceAliases(steps, aliases, hasCommand)
    scanner.reset()
    if (steps.length > 0) yield steps
    if (done) return
  }
}
