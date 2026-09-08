// Byte dumps share row grouping, repeat folding, and offset tracking. Stored
// strings are encoded as UTF-8; only printable ASCII appears in the gutter.

import { unsupported } from '../unsupported.js'
import { dumpInput } from './dump-input.js'
import { parseArgs } from '../args.js'
import { err, joinLines, okWith } from '../util.js'

const BYTES_PER_LINE = 16
// Full-line widths the partial last row pads out to. hexdump: 7-digit
// offset + space + eight 2-byte words (`XXXX` ×8 + 7 gaps = 39). xxd:
// the hex column is eight raw 2-byte groups (`XXXX` ×8 + 7 gaps = 39).
const HEXDUMP_ROW_WIDTH = 47
const XXD_HEX_WIDTH = 39

// hexdump uses little-endian words unless -C requests canonical byte output.
export function hexdump(stdin, tokens, ctx) {
  const { flags, values, positional } = parseArgs(tokens, { short: ['C', 'v'], valueShort: ['n', 's'] })
  if (positional.includes('-')) return unsupported('feature', 'hexdump', 'hyphen input operand', 'hexdump: a hyphen input operand is not supported; omit operands to read stdin')
  const sl = dumpInput('hexdump', positional, stdin, ctx, { skip: values.get('s'), len: values.get('n'), skipFlag: '-s', lenFlag: '-n' })
  if (sl.error) return sl.error
  return okWith(dump(sl.bytes, sl.start, flags.has('v'), flags.has('C') ? HEXDUMP_C : HEXDUMP), sl.r)
}

// od uses little-endian octal words, always emits an end offset, and rejects skips past EOF.
export function od(stdin, tokens, ctx) {
  const { flags, values, positional } = parseArgs(tokens, { short: ['v'], valueShort: ['j', 'N'] })
  if (!flags.size && !values.size && ((positional.length === 1 && /^\+\d/u.test(positional[0])) || (positional.length === 2 && /^\+?\d/u.test(positional[1])))) {
    return unsupported('feature', 'od', 'legacy offset operand', 'od: legacy offset operands are not supported; use -j OFFSET')
  }
  const sl = dumpInput('od', positional, stdin, ctx, { skip: values.get('j'), len: values.get('N'), skipFlag: '-j', lenFlag: '-N', skipPastEofErrors: true })
  if (sl.error) return sl.error
  return okWith(dump(sl.bytes, sl.start, flags.has('v'), OD), sl.r)
}

// xxd emits raw byte pairs without repeat folding or an end-offset row.
export function xxd(stdin, tokens, ctx) {
  const { values, positional } = parseArgs(tokens, { valueShort: ['s', 'l'] })
  if (positional.length > 2) return err('xxd: too many operands')
  if (positional.length === 2 && positional[1] !== '-') return unsupported('feature', 'xxd', 'output file', 'xxd: output files are not supported (filesystem is read-only)')
  const sl = dumpInput('xxd', positional.slice(0, 1), stdin, ctx, { skip: values.get('s'), len: values.get('l'), skipFlag: '-s', lenFlag: '-l' })
  if (sl.error) return sl.error
  return okWith(dump(sl.bytes, sl.start, false, XXD), sl.r)
}

// Only identical full rows fold to *. Trailer policy differs for empty input:
// od always prints one, hexdump requires a nonzero end offset, and xxd omits it.
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
  return joinLines(out)
}

const HEXDUMP = {
  compress: true,
  trailer: 'nonzero',
  addr: hexAddr7,
  row: (off, b) => (hexAddr7(off) + ' ' + leWords(b).map(hex4).join(' ')).padEnd(HEXDUMP_ROW_WIDTH),
}

const HEXDUMP_C = {
  compress: true,
  trailer: 'nonzero',
  addr: hexAddr8,
  row: canonicalRow,
}

const OD = {
  compress: true,
  trailer: 'always',
  addr: octAddr7,
  row: (off, b) => octAddr7(off) + ' ' + leWords(b).map(oct6).join(' '),
}

const XXD = {
  compress: false,
  trailer: 'never',
  row: (off, b) => `${hexAddr8(off)}: ${xxdGroups(b).join(' ').padEnd(XXD_HEX_WIDTH)}  ${gutter(b)}`,
}

function hexAddr7(n) { return n.toString(16).padStart(7, '0') }
function hexAddr8(n) { return n.toString(16).padStart(8, '0') }
function octAddr7(n) { return n.toString(8).padStart(7, '0') }

// Canonical (`hexdump -C`) row: 8-digit offset, two padded groups of
// eight 2-digit bytes, then a `|`-delimited ASCII gutter. Missing
// trailing bytes pad to blanks so the `|` column stays aligned.
function canonicalRow(off, row) {
  const cells = []
  for (let i = 0; i < BYTES_PER_LINE; i++) cells.push(i < row.length ? hex2(row[i]) : '  ')
  const left = cells.slice(0, 8).join(' ')
  const right = cells.slice(8).join(' ')
  return `${hexAddr8(off)}  ${left}  ${right}  |${gutter(row)}|`
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
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

const hex2 = (b) => b.toString(16).padStart(2, '0')
const hex4 = (w) => w.toString(16).padStart(4, '0')
const oct6 = (w) => w.toString(8).padStart(6, '0')
