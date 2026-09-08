// Unsupported constructs are reported both on stderr and on a separate feed:
// redirects and pipelines may hide stderr or replace a failing exit status.
// Ordinary command failures (missing files, no matches) stay off this feed.

import { err } from './util.js'

// Keep notes off public result/error fields and out of object spreads.
const NOTE = Symbol('unsupported')

// Custom handlers can throw null, primitives, or objects with hostile getters.
export function unsupportedNote(carrier) {
  if (carrier === null || carrier === undefined) return null
  try {
    return carrier[NOTE] ?? null
  } catch {
    return null
  }
}

// A null command denotes a shell construct or a shared parser's incomplete
// note; dispatch supplies the command when it becomes known.
// Notes store messages without the stream's terminating newline.
export function unsupported(kind, command, detail, message, code = 1) {
  return markUnsupported(err(message, code), kind, command, detail, message)
}

// Preserve output produced before a command encounters a runtime gap.
export function markUnsupported(result, kind, command, detail, message) {
  Object.defineProperty(result, NOTE, { value: { kind, command, detail, message }, enumerable: false, configurable: true })
  return result
}

// A command that catches parser errors must retain their diagnostic notes.
export function unsupportedFrom(e, command, message, code) {
  const found = unsupportedNote(e)
  if (!found) return err(message, code)
  return unsupported(found.kind, command, found.detail, message, code)
}

export class UnsupportedError extends Error {
  constructor(kind, detail, message) {
    super(message)
    this.name = 'UnsupportedError'
    markUnsupported(this, kind, null, detail, message)
  }
}

// Deduplicate repeated gaps, retaining the first occurrence and its context.
export function createUnsupportedFeed() {
  const seen = new Set()
  const entries = []
  return {
    entries,
    // Alias invocations share an identity but report the spelling first used.
    add(entry, identity = entry.command) {
      // Escape each field: diagnostics can themselves contain NULs.
      const key = JSON.stringify([entry.kind, identity, entry.detail])
      if (seen.has(key)) return
      seen.add(key)
      entries.push(Object.freeze(entry))
    },
  }
}
