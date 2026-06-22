// `hexdump` — a canonical hex + ASCII view of file (or stdin) bytes.
// Its own module (like grep/find/sed) rather than a slice of
// extra-commands.js, which is already near the per-file line cap.
//
// DELIBERATE DEFAULT: util-linux `hexdump` with no format flag prints
// the two-byte "%04x" view, whose digit order follows the HOST's byte
// order — `he` shows as `6568` on a little-endian box, `6865` on a
// big-endian one. That non-determinism is wrong for a virtual terminal
// meant to behave identically everywhere, and the two-byte view is
// rarely the one anyone actually wants. So bare `hexdump` here emits the
// CANONICAL layout — the same one `hexdump -C` produces:
//
//   00000000  68 65 6c 6c 6f 0a                                 |hello.|
//   00000006
//
// `-C` is still accepted (it selects the format that's already the
// default) so muscle-memory invocations work unchanged.
//
// Bytes come from the UTF-8 encoding of the stored text, matching how
// `wc -c` counts — `é` is two bytes (c3 a9), both shown as `.` in the
// ASCII gutter since they fall outside the printable 0x20–0x7e range.

import { parseArgs } from './parse.js'
import { okWith, parseNonNegativeInt, readContent } from './util.js'

const enc = new TextEncoder()

// `-C` (canonical) is the default, so it's declared only so the flag is
// accepted — it doesn't change behavior. `-v` disables the `*` run
// compression; `-n LENGTH` caps how many bytes are shown; `-s SKIP`
// drops leading bytes and starts the offset column at SKIP.
export function hexdump(stdin, tokens, ctx) {
  const { flags, values, positional } = parseArgs(tokens, {
    short: ['C', 'v'],
    valueShort: ['n', 's'],
  })
  const r = readContent('hexdump', positional, stdin, ctx)
  let bytes = enc.encode(r.content)
  let start = 0
  if (values.has('s')) {
    const s = parseNonNegativeInt(values.get('s'), 'hexdump: -s')
    if (s.error) return s.error
    start = s.value
    bytes = bytes.subarray(start)
  }
  if (values.has('n')) {
    const n = parseNonNegativeInt(values.get('n'), 'hexdump: -n')
    if (n.error) return n.error
    bytes = bytes.subarray(0, n.value)
  }
  return okWith(formatCanonical(bytes, start, flags.has('v')), r)
}

// Walk the bytes 16 at a time. With no bytes (empty input, or -s past
// EOF, or -n 0) hexdump emits nothing at all — not even the trailing
// offset line — so short-circuit to ''. Otherwise every full line that
// repeats the one before it collapses to a single `*` (unless -v), and
// a final line prints the end offset alone.
function formatCanonical(bytes, start, verbose) {
  if (bytes.length === 0) return ''
  const out = []
  let prev = null
  let starred = false
  for (let off = 0; off < bytes.length; off += 16) {
    const line = bytes.subarray(off, off + 16)
    if (!verbose && prev !== null && line.length === 16 && bytesEqual(line, prev)) {
      if (!starred) { out.push('*'); starred = true }
    } else {
      out.push(canonLine(start + off, line))
      starred = false
    }
    prev = line
  }
  out.push(offset(start + bytes.length))
  return out.join('\n') + '\n'
}

// One canonical row: 8-digit hex offset, two padded groups of eight
// 2-digit bytes, then the printable-ASCII gutter. Missing trailing
// bytes on the final row pad to blanks so the `|` column stays aligned;
// the gutter only covers bytes that are actually present.
function canonLine(off, line) {
  const cells = []
  for (let i = 0; i < 16; i++) cells.push(i < line.length ? hex2(line[i]) : '  ')
  const left = cells.slice(0, 8).join(' ')
  const right = cells.slice(8).join(' ')
  let ascii = ''
  for (const b of line) ascii += b >= 0x20 && b <= 0x7e ? String.fromCodePoint(b) : '.'
  return `${offset(off)}  ${left}  ${right}  |${ascii}|`
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

const offset = (n) => n.toString(16).padStart(8, '0')
const hex2 = (b) => b.toString(16).padStart(2, '0')
