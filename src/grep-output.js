// Line selection and presentation shared by grep's output modes.
import { joinLines, ok, splitLines } from './util.js'

export const anyMatch = (res, line) => res.some((re) => re.test(line))
const noMatch = () => ({ stdout: '', stderr: '', exitCode: 1 })

// Default mode: print matching lines, optionally with context.
// Context-line prefix uses `-` as the field separator (e.g.
// `file-12-content`); matches use `:`. `--` separates non-adjacent
// context groups within a single file. -o emits matching substrings;
// with -v these can occur in context lines instead of selected lines.
export function grepRun(inputs, res, opts) {
  const blocks = []
  let matched = false
  for (const { name, content, recursive } of inputs) {
    const lines = splitLines(content)
    const fileBlock = grepFileBlock(lines, res, name, { ...opts, showName: opts.showName ?? recursive })
    if (fileBlock.matched) matched = true
    if (fileBlock.matched) blocks.push(fileBlock.lines)
  }
  const output = joinLines(blocks.flatMap((block, i) => i > 0 && opts.hasContext ? ['--', ...block] : block))
  return matched ? ok(output) : noMatch()
}

// Walks the file once, emitting each line as it is decided: a SELECTED
// line (one that matches, while the `-m` cap still has room), or a
// context line owed to an earlier selection.
//
// The `-m` cap lives here, in the selection step, rather than being
// applied by truncating the input beforehand. Truncation cannot express
// what GNU does: after the Nth selection it stops SELECTING but still
// prints that match's trailing context, and a line in that window which
// happens to match is printed as context (`-`) rather than as a match
// (`:`). Verified against GNU — `grep -n -m 1 -A 1 hit` over
// `hit/hit/x` gives `1:hit` then `2-hit`, where the same input without
// `-m` gives `1:hit` then `2:hit`.
function grepFileBlock(lines, res, name, opts) {
  const { invert, after, before, max, hasContext } = opts
  const out = []
  let matched = false
  let lastShown = -1
  let selected = 0
  let owedAfter = 0
  for (let i = 0; i < lines.length; i++) {
    const hit = anyMatch(res, lines[i]) !== invert
    const capped = max !== undefined && selected >= max
    if (hit && !capped) {
      matched = true
      selected++
      const start = Math.max(0, i - before)
      if (hasContext && lastShown >= 0 && start > lastShown + 1) out.push('--')
      // -o prints only the matched substrings, but still GROUPS by the
      // same context windows — `grep -o -A 1` separates non-adjacent
      // matches with `--` exactly as the line-printing form does — so
      // it shares all the bookkeeping and differs only in what it emits.
      for (let j = Math.max(start, lastShown + 1); j < i; j++) {
        out.push(...presentLine(lines[j], name, j + 1, res, opts, false))
      }
      out.push(...presentLine(lines[i], name, i + 1, res, opts, true))
      lastShown = i
      owedAfter = after
      continue
    }
    // Trailing context is emitted lazily, one line per iteration, so
    // nothing is ever printed ahead of `i` and a later matching line
    // still gets its own turn at the branch above.
    if (owedAfter > 0) {
      out.push(...presentLine(lines[i], name, i + 1, res, opts, false))
      lastShown = i
      owedAfter--
    }
  }
  return { lines: out, matched }
}

function presentLine(line, name, lineNum, res, opts, selected) {
  if (!opts.only) return [formatLine(line, name, lineNum, selected, opts)]
  return selected === opts.invert ? [] : extractMatches(line, name, lineNum, res, opts, selected)
}

function extractMatches(line, name, lineNum, res, opts, selected) {
  // Per-line global regex so we get every occurrence, not just
  // the first. With multiple -e regexes, gather matches from each,
  // sort by position (longer first at the same position), then
  // filter to non-overlapping leftmost-longest — matches grep `-o`
  // semantics where two patterns covering the same span emit one
  // hit, not two.
  // Zero-length matches (`\b`, `\(\)`, ``) are dropped — ugrep / GNU
  // skip them in `-o`, and they'd duplicate across multi-`-e` since
  // the cursor below can't advance past a length-0 match.
  const out = []
  let cursor = 0
  while (cursor < line.length) {
    let best = null
    for (const re of res) {
      let match
      if (re.extent) match = re.extent.search(line, cursor)
      else {
        const search = new RegExp(re.source, re.flags + 'g')
        search.lastIndex = cursor
        const m = search.exec(line)
        match = m ? { start: m.index, end: m.index + m[0].length } : null
      }
      if (match && (!best || match.start < best.start || (match.start === best.start && match.end > best.end))) best = match
    }
    if (!best) break
    if (best.end === best.start) { cursor = best.end + (line.codePointAt(best.end) > 0xFFFF ? 2 : 1); continue }
    out.push(formatLine(line.slice(best.start, best.end), name, lineNum, selected, opts))
    cursor = best.end
  }
  return out
}

function formatLine(text, name, lineNum, isMatch, opts) {
  const { showName, showLine } = opts
  const sep = isMatch ? ':' : '-'
  const parts = []
  // GNU convention: when -H (or any showName mode) hits stdin,
  // the prefix is the literal `(standard input)` so the user can
  // still pipe greps and tell pipeline lines apart from data.
  if (showName) parts.push(name ?? '(standard input)')
  if (showLine) parts.push(String(lineNum))
  return parts.length > 0 ? parts.join(sep) + sep + text : text
}

// -l prints filenames that have at least one matching line; -L
// inverts to filenames with zero matches. Stdin contributes as
// `(standard input)`, matching the convention formatLine and
// grepCount use under -H.
//
// Exit status follows GNU and is NOT tied to the listing: 0 iff some
// input had a selected line, 1 otherwise. So `grep -L` can print the
// un-matched files yet still exit 1 when nothing matched anywhere (a
// pattern absent from every file). For -l the two coincide — a listed
// file is, by definition, one that matched.
export function grepListFiles(inputs, res, invert, listNonMatching) {
  const out = []
  let anySelected = false
  for (const { name, content } of inputs) {
    const lines = splitLines(content)
    const hasMatch = lines.some((l) => anyMatch(res, l) !== invert)
    if (hasMatch) anySelected = true
    if (listNonMatching ? !hasMatch : hasMatch) {
      // Match the (standard input) convention from formatLine /
      // grepCount so `echo … | grep -l PATTERN` produces something
      // useful instead of silently dropping the stream.
      out.push(name ?? '(standard input)')
    }
  }
  return { stdout: joinLines(out), stderr: '', exitCode: anySelected ? 0 : 1 }
}

// -c prints per-file match counts. With showName, each line is
// `name:count`; without, just the count (e.g. when reading from
// stdin or a single explicit file). Exit 0 if any file matched.
export function grepCount(inputs, res, invert, showName) {
  const lines = []
  let anyMatched = false
  for (const { name, content, recursive } of inputs) {
    const fileLines = splitLines(content)
    let count = 0
    for (const l of fileLines) if (anyMatch(res, l) !== invert) count++
    if (count > 0) anyMatched = true
    // Mirror the stdin-label convention from formatLine so
    // `echo … | grep -Hc PATTERN` produces `(standard input):N`
    // rather than a bare count that's indistinguishable from the
    // single-file no-prefix case.
    if (showName ?? recursive) lines.push(`${name ?? '(standard input)'}:${count}`)
    else lines.push(String(count))
  }
  if (lines.length === 0) return noMatch()
  return { stdout: joinLines(lines), stderr: '', exitCode: anyMatched ? 0 : 1 }
}
