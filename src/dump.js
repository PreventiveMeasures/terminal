// Byte-dump commands — `hexdump`, plus `od` and `xxd` as hidden
// variants — sharing one engine. Each tool is just a FORMAT SPEC
// (offset radix/width, how a row of bytes renders, whether repeated
// rows fold to `*`, whether a trailing offset line prints) fed to the
// same read → slice → group → render pipeline.
//
// Formats were checked byte-for-byte against the real tools
// (util-linux hexdump 2.39.3, GNU coreutils od, xxd 2023-10-25):
//
//   hexdump file        0000000 6568 6c6c 0a6f                         (2-byte LE hex)
//   hexdump -C file     00000000  68 65 6c 6c 6f 0a    |hello.|        (canonical)
//   od file             0000000 062550 066154 005157                   (2-byte LE octal)
//   xxd file            00000000: 6865 6c6c 6f0a       hello.          (raw 2-byte hex)
//
// Bytes come from the UTF-8 encoding of the stored text, matching how
// `wc -c` counts — `é` is two bytes (c3 a9), each shown as `.` in any
// ASCII gutter since they fall outside the printable 0x20–0x7e range.

import { parseArgs } from './parse.js'
import { okWith, parseNonNegativeInt, readContent } from './util.js'

const enc = new TextEncoder()
const BYTES_PER_LINE = 16

// hexdump's bare default. Two-byte little-endian hex words (`he` →
// `6568`), a 7-digit hex offset, and every data row padded to the
// full-line width (47) — exactly what util-linux prints. `-C` opts
// into the canonical layout; `-v` defeats `*` folding; `-n`/`-s` cap
// and skip bytes (real hexdump rejects `-s` on a pipe, but our stdin
// is in-memory so it works uniformly).
export function hexdump(stdin, tokens, ctx) {
  const { flags, values, positional } = parseArgs(tokens, { short: ['C', 'v'], valueShort: ['n', 's'] })
  const sl = slice('hexdump', positional, stdin, ctx, values.get('s'), values.get('n'), '-s', '-n')
  if (sl.error) return sl.error
  return okWith(dump(sl.bytes, sl.start, flags.has('v'), flags.has('C') ? HEXDUMP_C : HEXDUMP), sl.r)
}

// od's default: two-byte little-endian OCTAL words, an octal offset,
// and — unlike hexdump — a trailing offset line even for empty input
// and no per-row padding. `-v` defeats folding; `-j`/`-N` skip/limit.
export function od(stdin, tokens, ctx) {
  const { flags, values, positional } = parseArgs(tokens, { short: ['v'], valueShort: ['j', 'N'] })
  const sl = slice('od', positional, stdin, ctx, values.get('j'), values.get('N'), '-j', '-N')
  if (sl.error) return sl.error
  return okWith(dump(sl.bytes, sl.start, flags.has('v'), OD), sl.r)
}

// xxd's default: raw (non-swapped) two-byte hex groups, an 8-digit
// hex offset followed by `:`, a plain ASCII gutter, and — unlike
// hexdump/od — no `*` folding and no trailing offset line. `-s`/`-l`
// skip/limit.
export function xxd(stdin, tokens, ctx) {
  const { values, positional } = parseArgs(tokens, { valueShort: ['s', 'l'] })
  const sl = slice('xxd', positional, stdin, ctx, values.get('s'), values.get('l'), '-s', '-l')
  if (sl.error) return sl.error
  return okWith(dump(sl.bytes, sl.start, false, XXD), sl.r)
}

// Read the inputs, encode to bytes, then skip/limit. Skip clamps to the
// content length so `-s` past EOF reads zero bytes while the offset
// column still lands at the clamped position (matching hexdump). The
// `r` carries readContent's partial-failure stderr/exit for okWith.
function slice(cmd, files, stdin, ctx, skipStr, lenStr, skipFlag, lenFlag) {
  const r = readContent(cmd, files, stdin, ctx)
  const all = enc.encode(r.content)
  let start = 0
  if (skipStr !== undefined) {
    const s = parseNonNegativeInt(skipStr, `${cmd}: ${skipFlag}`)
    if (s.error) return { error: s.error }
    start = Math.min(s.value, all.length)
  }
  let bytes = all.subarray(start)
  if (lenStr !== undefined) {
    const n = parseNonNegativeInt(lenStr, `${cmd}: ${lenFlag}`)
    if (n.error) return { error: n.error }
    bytes = bytes.subarray(0, n.value)
  }
  return { bytes, start, r }
}

// The shared engine. Walk the bytes a row at a time, folding runs of
// identical full rows to a single `*` (when the spec compresses and -v
// is off), then append the end-offset line per the spec's trailer rule:
//   'always' (od)       — print it even when nothing else was emitted
//   'nonzero' (hexdump) — print it unless the end offset is 0 (so empty
//                         input yields no output, but `-s` past EOF
//                         still shows the clamped offset)
//   'never' (xxd)       — no trailer at all
function dump(bytes, start, verbose, spec) {
  const out = []
  let prev = null
  let starred = false
  for (let off = 0; off < bytes.length; off += BYTES_PER_LINE) {
    const row = bytes.subarray(off, off + BYTES_PER_LINE)
    if (spec.compress && !verbose && prev !== null && row.length === BYTES_PER_LINE && sameBytes(row, prev)) {
      if (!starred) { out.push('*'); starred = true }
    } else {
      out.push(spec.row(start + off, row))
      starred = false
    }
    prev = row
  }
  const end = start + bytes.length
  if (spec.trailer === 'always' || (spec.trailer === 'nonzero' && end > 0)) out.push(spec.addr(end))
  return out.length === 0 ? '' : out.join('\n') + '\n'
}

const HEXDUMP = {
  compress: true,
  trailer: 'nonzero',
  addr: (n) => n.toString(16).padStart(7, '0'),
  row: (off, b) => (HEXDUMP.addr(off) + ' ' + leWords(b).map(hex4).join(' ')).padEnd(47),
}

const HEXDUMP_C = {
  compress: true,
  trailer: 'nonzero',
  addr: (n) => n.toString(16).padStart(8, '0'),
  row: (off, b) => canonicalRow(off, b),
}

const OD = {
  compress: true,
  trailer: 'always',
  addr: (n) => n.toString(8).padStart(7, '0'),
  row: (off, b) => OD.addr(off) + ' ' + leWords(b).map(oct6).join(' '),
}

const XXD = {
  compress: false,
  trailer: 'never',
  addr: (n) => n.toString(16).padStart(8, '0'),
  row: (off, b) => `${XXD.addr(off)}: ${xxdGroups(b).join(' ').padEnd(39)}  ${gutter(b)}`,
}

// Canonical (`hexdump -C`) row: 8-digit offset, two padded groups of
// eight 2-digit bytes, then a `|`-delimited ASCII gutter. Missing
// trailing bytes pad to blanks so the `|` column stays aligned.
function canonicalRow(off, row) {
  const cells = []
  for (let i = 0; i < BYTES_PER_LINE; i++) cells.push(i < row.length ? hex2(row[i]) : '  ')
  const left = cells.slice(0, 8).join(' ')
  const right = cells.slice(8).join(' ')
  return `${HEXDUMP_C.addr(off)}  ${left}  ${right}  |${gutter(row)}|`
}

// Little-endian 2-byte words (hexdump/od grouping): bytes b0,b1 read as
// b0 | b1<<8. A lone trailing byte becomes the low half of a 0-padded
// word (`6c` → `006c` / `000154`).
function leWords(row) {
  const words = []
  for (let i = 0; i < row.length; i += 2) {
    words.push(i + 1 < row.length ? row[i] | (row[i + 1] << 8) : row[i])
  }
  return words
}

// xxd grouping: raw byte pairs, NOT byte-swapped (`he` → `6865`); a
// lone trailing byte renders as a single 2-digit group.
function xxdGroups(row) {
  const groups = []
  for (let i = 0; i < row.length; i += 2) {
    groups.push(hex2(row[i]) + (i + 1 < row.length ? hex2(row[i + 1]) : ''))
  }
  return groups
}

function gutter(row) {
  let s = ''
  for (const b of row) s += b >= 0x20 && b <= 0x7e ? String.fromCodePoint(b) : '.'
  return s
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

const hex2 = (b) => b.toString(16).padStart(2, '0')
const hex4 = (w) => w.toString(16).padStart(4, '0')
const oct6 = (w) => w.toString(8).padStart(6, '0')
