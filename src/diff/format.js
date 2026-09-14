// The three output styles, rendered from a change set the way GNU's
// normal.c and context.c render theirs. Given the same change set, the
// bytes are the same; the change set itself is what myers.js guarantees.

import { groupHunks } from './hunks.js'

// A line is printed as it is stored, terminator included; one without a
// terminator can only be a file's last, and says so on the next line.
const NO_NEWLINE = '\n\\ No newline at end of file\n'
const printLine = (prefix, line) => prefix + line + (line.endsWith('\n') ? '' : NO_NEWLINE)

// normal.c: `3c3`, `5a6,7`, `8,9d9`; an empty range prints the line before it.
function normalRange(start, end) {
  return end > start + 1 ? `${start + 1},${end}` : `${end > start ? start + 1 : start}`
}

export function formatNormal(a, b, blocks) {
  let out = ''
  for (const { a0, a1, b0, b1 } of blocks) {
    const letter = a0 === a1 ? 'a' : b0 === b1 ? 'd' : 'c'
    out += normalRange(a0, a1) + letter + normalRange(b0, b1) + '\n'
    for (let i = a0; i < a1; i++) out += printLine('< ', a[i])
    if (letter === 'c') out += '---\n'
    for (let i = b0; i < b1; i++) out += printLine('> ', b[i])
  }
  return out
}

// context.c print_unidiff_number_range: one line prints bare, an empty
// range prints the line before it with `,0`.
function unifiedRange(start, end) {
  if (end <= start) return `${start},0`
  return end === start + 1 ? `${start + 1}` : `${start + 1},${end - start}`
}

// `header` is the two label lines, already built; `fn(index)` names the
// function a hunk starting at that line falls in, or null.
export function formatUnified(a, b, blocks, { context, header, fn }) {
  let out = header
  for (const hunk of groupHunks(blocks, context, a.length, b.length)) {
    const name = fn ? fn(hunk.a0) : null
    out += `@@ -${unifiedRange(hunk.a0, hunk.a1)} +${unifiedRange(hunk.b0, hunk.b1)} @@${name === null ? '' : ' ' + name}\n`
    let ai = hunk.a0, bi = hunk.b0
    for (const { a0, a1, b1 } of hunk.blocks) {
      for (; ai < a0; ai++, bi++) out += printLine(' ', a[ai])
      for (; ai < a1; ai++) out += printLine('-', a[ai])
      for (; bi < b1; bi++) out += printLine('+', b[bi])
    }
    for (; ai < hunk.a1; ai++, bi++) out += printLine(' ', a[ai])
  }
  return out
}

// context.c print_context_number_range: first,last inclusive; a single
// line bare; an empty range as the line before it.
function contextRange(start, end) {
  if (end <= start) return `${start}`
  return end === start + 1 ? `${start + 1}` : `${start + 1},${end}`
}

export function formatContext(a, b, blocks, { context, header, fn }) {
  let out = header
  for (const hunk of groupHunks(blocks, context, a.length, b.length)) {
    const name = fn ? fn(hunk.a0) : null
    out += `***************${name === null ? '' : ' ' + name}\n`
    out += `*** ${contextRange(hunk.a0, hunk.a1)} ****\n`
    // A side with no changes of its own prints only its range line.
    if (hunk.blocks.some((block) => block.a0 < block.a1)) out += contextSide(a, hunk.a0, hunk.a1, hunk.blocks, 'a')
    out += `--- ${contextRange(hunk.b0, hunk.b1)} ----\n`
    if (hunk.blocks.some((block) => block.b0 < block.b1)) out += contextSide(b, hunk.b0, hunk.b1, hunk.blocks, 'b')
  }
  return out
}

// `! ` marks a line whose block both deletes and inserts; `- ` or `+ ` one
// whose block only does the one.
function contextSide(lines, from, to, blocks, side) {
  const end = side + '1', start = side + '0'
  const other = side === 'a' ? 'b' : 'a'
  let out = ''
  let i = from
  for (const block of blocks) {
    for (; i < block[start]; i++) out += printLine('  ', lines[i])
    const mark = block[other + '0'] < block[other + '1'] ? '! ' : side === 'a' ? '- ' : '+ '
    for (; i < block[end]; i++) out += printLine(mark, lines[i])
  }
  for (; i < to; i++) out += printLine('  ', lines[i])
  return out
}
