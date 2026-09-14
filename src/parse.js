// Read a command line without running any of it: what the parser made of the
// input, for a caller that wants to look at a line, render it, or hand it to
// an engine of its own. Parsing only, so nothing here knows which commands
// exist, what the filesystem holds, or what any word expands to.

import { createUnsupportedFeed, unsupportedNote } from './unsupported.js'
import { parseAll } from './shell/parse.js'

// The published entry, `@preventive/terminal/parse.js`. There is no
// filesystem on this side, so a redirect is read, never refused: where it may
// write is a property of a terminal, not of the line.
export const parse = (line) => read(line, true)

// A terminal's own reading, under the write policy run() would apply.
export const inspect = (line, writable) => read(line, writable)

function read(line, writable) {
  const feed = createUnsupportedFeed()
  const { units, error, incomplete } = parseAll(line, writable)
  const note = error === null ? null : unsupportedNote(error)
  if (note) feed.add(note)
  return {
    ok: error === null,
    incomplete,
    error: error === null ? null : error.message,
    // Bash parses one input unit and runs it before reading the next, so the
    // units ahead of an error are the ones run() would have executed. The
    // tree is a fresh parse each call and belongs to the caller; only the
    // diagnostics are frozen, as they are on a run.
    units,
    unsupported: Object.freeze(feed.entries),
  }
}
