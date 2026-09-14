// From a change set to what the context formats print: hunks, each a run of
// changes close enough to share context lines. GNU merges two changes into
// one hunk when the unchanged lines between them number at most twice the
// context (context.c find_hunk), so their context lines would touch.

export function groupHunks(blocks, context, aLength, bLength) {
  const hunks = []
  let i = 0
  while (i < blocks.length) {
    let j = i
    while (j + 1 < blocks.length && blocks[j + 1].a0 - blocks[j].a1 <= 2 * context) j++
    const first = blocks[i], last = blocks[j]
    hunks.push({
      blocks: blocks.slice(i, j + 1),
      a0: Math.max(0, first.a0 - context), a1: Math.min(aLength, last.a1 + context),
      b0: Math.max(0, first.b0 - context), b1: Math.min(bLength, last.b1 + context),
    })
    i = j + 1
  }
  return hunks
}

// -p: the last line before the hunk that looks like the start of a
// function, as GNU's default `^[[:alpha:]$_]` sees it, cut to 40 bytes with
// trailing blanks dropped (context.c find_function, print_context_function).
const FUNCTION_START = /^[A-Za-z$_]/u

export function functionLine(lines, before, encode, decode) {
  for (let i = before - 1; i >= 0; i--) {
    if (!FUNCTION_START.test(lines[i])) continue
    const bytes = encode(lines[i].replace(/\n$/u, ''))
    let end = Math.min(40, bytes.length)
    while (end > 0 && isSpaceByte(bytes[end - 1])) end--
    return decode(bytes.subarray(0, end))
  }
  return null
}

const isSpaceByte = (byte) => byte === 32 || (byte >= 9 && byte <= 13)
