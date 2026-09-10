import { createTokenizer, tokenize } from './tokenize.js'
import { advanceAliases } from './aliases.js'
import { UnsupportedError } from '../unsupported.js'

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
  const token = p.raw[index]
  if (token?.kind === 'amp') throw new UnsupportedError('feature', '&', 'background processes (`&`) are not supported')
  return token
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
// an accepted top-level newline returns control to the execution loop.
export function* readUnits(line, writable, hasCommand, parseTokens) {
  const scanner = createTokenizer(line, validationOptions(hasCommand, {}, parseTokens))
  let aliases = new Set()
  let aliasUsed = false
  for (;;) {
    const options = { aliases, aliasUsed, read: scanner.read, unit: true }
    let steps
    try { steps = parseTokens([], writable, hasCommand, options) }
    catch (error) {
      if (!(error instanceof IncompleteInput)) throw error
      throw error.finalError
    }
    aliasUsed = options.aliasUsed
    aliases = advanceAliases(steps, aliases, hasCommand)
    scanner.reset()
    if (steps.length > 0) yield steps
    if (options.done) return
  }
}
