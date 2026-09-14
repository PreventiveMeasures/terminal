// Rejected hunks, written back out the way patch.c abort_hunk_unified and
// abort_hunk_context write them: unified when the patch was unified, context
// otherwise, with the line numbers shifted by what the hunks before them
// changed, so the rejects can be applied by hand where they were meant to go.

const NO_NEWLINE = '\n\\ No newline at end of file\n'
// GNU writes an incomplete line and nothing after it; the marker here says
// what the reject means instead of running two lines together.
const line = (prefix, text) => prefix + text + (text.endsWith('\n') ? '' : NO_NEWLINE)

export function createReject(header, format, reverse) {
  let text = ''
  const headerLine = (tag, side) => `${tag} ${header.names[side] ?? '/dev/null'}${header.timestrs[side] ?? ''}\n`
  const index = header.names.index === null ? '' : `Index: ${header.names.index}\n`
  const sides = reverse ? ['new', 'old'] : ['old', 'new']
  return {
    get text() { return text },
    add(hunk, first, outOffset) {
      if (format === 'unified') {
        if (first) text += index + headerLine('---', sides[0]) + headerLine('+++', sides[1])
        text += unifiedReject(hunk, outOffset)
      } else {
        if (first) text += index + headerLine('***', sides[0]) + headerLine('---', sides[1])
        text += contextReject(hunk, outOffset, format)
      }
    },
  }
}

// patch.c print_unidiff_range: an empty range names the line before it.
const unifiedRange = (start, count) => count === 0 ? `${start - 1},0` : count === 1 ? `${start}` : `${start},${count}`

function unifiedReject(hunk, outOffset) {
  const fresh = hunk.newLines, old = hunk.oldLines
  let out = `@@ -${unifiedRange(hunk.oldStart + outOffset, old.length)} +${unifiedRange(hunk.newStart + outOffset, fresh.length)} @@${hunk.fn ?? ''}\n`
  let ni = 0, oi = 0
  for (;; oi++, ni++) {
    for (; oi < old.length && old[oi].tag === '-'; oi++) out += line('-', old[oi].text)
    for (; ni < fresh.length && fresh[ni].tag === '+'; ni++) out += line('+', fresh[ni].text)
    if (oi >= old.length) break
    out += line(' ', old[oi].text)
  }
  return out
}

// `*** 3,5 ****` and `--- 3,6 ----` for a new-style context reject; a
// normal diff's rejects get the old style, `*** 3,5` and `--- 3,6 -----`.
function contextRange(first, count) {
  const last = first + count - 1
  return last < first ? '0' : last === first ? `${first}` : `${first},${last}`
}

function contextReject(hunk, outOffset, format) {
  const newStyle = format !== 'normal'
  const marks = hunk.marks ?? (format === 'normal' ? rawMarks(hunk) : normalizedMarks(hunk))
  let out = `***************${hunk.fn ?? ''}\n`
  out += `*** ${contextRange(hunk.oldStart + outOffset, hunk.oldLines.length)}${newStyle ? ' ****' : ''}\n`
  hunk.oldLines.forEach((l, i) => { out += line(marks.old[i] + ' ', l.text) })
  out += `--- ${contextRange(hunk.newStart + outOffset, hunk.newLines.length)}${newStyle ? ' ----' : ' -----'}\n`
  hunk.newLines.forEach((l, i) => { out += line(marks.new[i] + ' ', l.text) })
  return out
}

const rawMarks = (hunk) => ({ old: hunk.oldLines.map((l) => l.tag), new: hunk.newLines.map((l) => l.tag) })

// pch.c pch_normalize toward context format: a run of deletions met by a
// run of insertions is a change, marked `!` on both sides.
function normalizedMarks(hunk) {
  const fresh = hunk.newLines.map((l) => l.tag), old = hunk.oldLines.map((l) => l.tag)
  let ni = 0, oi = 0
  while (oi < old.length) {
    if (old[oi] === '-') {
      if (ni < fresh.length && fresh[ni] === '+') {
        do old[oi++] = '!'; while (oi < old.length && old[oi] === '-')
        do fresh[ni++] = '!'; while (ni < fresh.length && fresh[ni] === '+')
      } else do oi++; while (oi < old.length && old[oi] === '-')
    } else if (ni < fresh.length && fresh[ni] === '+') {
      do ni++; while (ni < fresh.length && fresh[ni] === '+')
    } else { oi++; ni++ }
  }
  return { old, new: fresh }
}
