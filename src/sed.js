// Narrow, hidden command. Implements only the line-range slice
// form that auditors reach for when they want to read a specific
// chunk of a long file: `sed -n 'X,Yp' FILE` or
// `cat FILE | sed -n 'X,Yp'`. Anything else (substitution,
// regex addresses, multiple scripts, in-place edits, etc.) errors
// with a one-line message — we don't pretend to be a real sed.
// Kept out of the user-facing command list in index.js for the
// same reason: surface it on demand, don't advertise it.

import { parseArgs } from './parse.js'
import { err, okWith, readInputs, splitLines } from './util.js'

const SCRIPT = /^(\d+)(?:,(\d+))?p$/u

export function sed(stdin, tokens, ctx) {
  // parseArgs throws on unknown flags (`-i`, `-e`, …). Anything
  // outside the narrow subset should funnel into one canonical
  // error — `sed -i -n '1,2p' file` shouldn't surface a generic
  // "unknown option: -i" that hints at flag support we don't have.
  let parsed
  try { parsed = parseArgs(tokens, { short: ['n'] }) } catch { return unsupported() }
  const { flags, positional } = parsed
  if (!flags.has('n') || positional.length === 0) return unsupported()
  const m = SCRIPT.exec(positional[0])
  if (!m) return unsupported()
  const start = Number(m[1])
  const end = m[2] === undefined ? start : Number(m[2])
  if (start < 1 || end < 1) return err('sed: line numbers must be >= 1')
  if (end < start) return err(`sed: reversed range: ${start},${end}`)
  const files = positional.slice(1)
  if (files.length > 1) return err('sed: at most one input file is supported')
  const r = readInputs('sed', files, stdin, ctx)
  const content = r.inputs[0]?.content ?? ''
  const lines = splitLines(content)
  // `slice(start-1, end)`: inclusive on both ends in 1-indexed
  // terms (matching sed). Out-of-range starts/ends just clamp —
  // sed prints nothing past EOF without complaining.
  const sliced = lines.slice(start - 1, end)
  return okWith(sliced.length > 0 ? sliced.join('\n') + '\n' : '', r)
}

function unsupported() {
  return err("sed: only `-n 'X[,Y]p'` (line range print) is supported")
}
