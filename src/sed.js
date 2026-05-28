// Narrow, hidden command. Implements only the line-range slice
// form that auditors reach for when they want to read a specific
// chunk of a long file: `sed -n 'X,Yp' FILE` (single range), or
// `sed -n 'X1,Y1p;X2,Y2p;…' FILE` (semicolon-separated multi-range,
// useful for extracting non-contiguous slices in one pass).
// Multiple FILE arguments concatenate with cumulative line
// numbering — `sed -n '5p' a.txt b.txt` selects from the joined
// stream, matching GNU. Anything else (substitution, regex
// addresses, multiple scripts, in-place edits, etc.) errors with
// a one-line message — we don't pretend to be a real sed. Kept
// out of the user-facing command list in index.js for the same
// reason: surface it on demand, don't advertise it.

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
  const parsedScript = parseScript(positional[0])
  if (parsedScript.error) return parsedScript.error
  const { ranges } = parsedScript
  if (ranges.length === 0) return unsupported()
  const files = positional.slice(1)
  const r = readInputs('sed', files, stdin, ctx)
  // Multi-file: GNU concatenates the inputs into one virtual stream
  // with CUMULATIVE line numbering (`sed -n '5p' a.txt b.txt` prints
  // the 5th line of `a.txt` if a.txt has >= 5 lines, otherwise the
  // line that falls at position 5 of the concatenation). Crucially,
  // GNU doesn't merge bytes across the file boundary: a file with
  // no trailing newline still ends a line at EOF, so the next file's
  // first line starts cleanly. splitLines per input + flatMap mirrors
  // that — joining raw `content` would merge unterminated last lines
  // into the next file's first.
  const lines = r.inputs.flatMap((input) => splitLines(input.content))
  // sed semantics: for each input line in order, for each command
  // in script order, run it. So with `-n '1,3p;2,4p'` on lines 1-4,
  // lines 2 and 3 print TWICE — matched by both ranges. Matches GNU.
  // Out-of-range starts/ends just don't fire (sed prints nothing
  // past EOF without complaining).
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1
    for (const { start, end } of ranges) {
      if (lineNum >= start && lineNum <= end) out.push(lines[i])
    }
  }
  return okWith(out.length > 0 ? out.join('\n') + '\n' : '', r)
}

// Split the script on `;` and parse each segment as an `X,Yp` (or
// `Xp`) command. Empty segments are silently skipped so leading,
// trailing, or doubled `;` don't blow up — GNU is lenient here and
// callers occasionally template the separator (e.g. joining a
// dynamic list of ranges).
function parseScript(script) {
  const ranges = []
  for (const seg of script.split(';')) {
    if (seg === '') continue
    const m = SCRIPT.exec(seg)
    if (!m) return { error: unsupported() }
    const start = Number(m[1])
    const end = m[2] === undefined ? start : Number(m[2])
    // `\d+` matches "0", so the start-must-be-positive check is
    // explicit rather than regex-implicit. Once start >= 1 and end
    // >= start, end >= 1 falls out. GNU treats `5,3p` as a no-op;
    // we surface the error instead to catch obvious typos.
    if (start < 1) return { error: err('sed: line numbers must be >= 1') }
    if (end < start) return { error: err(`sed: reversed range: ${start},${end}`) }
    ranges.push({ start, end })
  }
  return { ranges }
}

function unsupported() {
  return err("sed: only `-n 'X[,Y]p'` (optionally `;`-joined into multi-range scripts) is supported")
}
