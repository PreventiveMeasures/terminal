// Line selection and presentation shared by grep's output modes.
import { joinLines, ok, splitLines } from '../util.js'
import { UnsupportedError } from '../unsupported.js'

export const anyMatch = (res, line) => res.some((re) => re.test(line))
export const noMatch = () => ({ stdout: '', stderr: '', exitCode: 1 })

// Stop at the selection limit without splitting the unvisited suffix.
// A final newline ends its line; it does not create another empty line.
export function countMatches(content, res, invert, max) {
  let count = 0
  if (max === Infinity) {
    // Native splitting is faster for uncapped counts across many small files.
    for (const line of splitLines(content)) if (anyMatch(res, line) !== invert) count++
    return count
  }
  let start = 0
  while (start < content.length && count < max) {
    let end = content.indexOf('\n', start)
    if (end < 0) end = content.length
    if (anyMatch(res, content.slice(start, end)) !== invert) count++
    start = end + 1
  }
  return count
}

// Default mode: print matching lines, optionally with context.
// Context-line prefix uses `-` as the field separator (e.g.
// `file-12-content`); matches use `:`. `--` separates non-adjacent
// context groups within a single file. -o emits matching substrings;
// with -v these can occur in context lines instead of selected lines.
export function grepRun(inputs, res, opts) {
  const out = []
  let matched = false
  for (const { name, content, recursive } of inputs) {
    const fileOpts = { ...opts, showName: opts.showName ?? recursive, separate: matched && opts.hasContext }
    if (grepFileBlock(splitLines(content), res, name, fileOpts, out)) matched = true
  }
  return matched ? ok(joinLines(out)) : noMatch()
}

// The match cap stops selections, not trailing context. A later match inside
// that context is printed with - rather than : once the cap is reached.
function grepFileBlock(lines, res, name, opts, out) {
  const { invert, after, before, max, hasContext } = opts
  let lastShown = -1
  let selected = 0
  let owedAfter = 0
  for (let i = 0; i < lines.length; i++) {
    if (selected === max && owedAfter === 0) break
    const hit = anyMatch(res, lines[i]) !== invert
    const capped = max !== undefined && selected >= max
    if (hit && !capped) {
      selected++
      if (selected === 1 && opts.separate) out.push('--')
      const start = Math.max(0, i - before)
      if (hasContext && lastShown >= 0 && start > lastShown + 1) out.push('--')
      // -o shares context grouping even though it emits only matching substrings.
      for (let j = Math.max(start, lastShown + 1); j < i; j++) {
        presentLine(lines[j], name, j + 1, res, opts, false, out)
      }
      presentLine(lines[i], name, i + 1, res, opts, true, out)
      lastShown = i
      owedAfter = after
      continue
    }
    if (owedAfter > 0) {
      presentLine(lines[i], name, i + 1, res, opts, false, out)
      lastShown = i
      owedAfter--
    }
  }
  return selected > 0
}

function presentLine(line, name, lineNum, res, opts, selected, out) {
  if (!opts.only) { out.push(formatLine(line, name, lineNum, selected, opts)); return }
  if (selected === opts.invert) return
  // Across patterns, choose the leftmost-longest nonoverlapping match each time.
  // Skip zero-length matches while advancing by a full code point.
  let cursor = 0
  while (cursor < line.length) {
    let best = null
    for (const re of res) {
      let match
      if (re.extent) match = re.extent.search(line, cursor)
      else {
        const search = re.scan ??= new RegExp(re.source, re.flags + 'g')
        search.lastIndex = cursor
        const m = search.exec(line)
        if (m && m[0] === '' && re.pcre) throw new UnsupportedError('feature', 'PCRE empty match extent', 'only-matching with empty PCRE matches is not supported')
        match = m ? { start: m.index, end: m.index + m[0].length } : null
      }
      if (match && (!best || match.start < best.start || (match.start === best.start && match.end > best.end))) best = match
    }
    if (!best) break
    if (best.end === best.start) { cursor = best.end + (line.codePointAt(best.end) > 0xFFFF ? 2 : 1); continue }
    out.push(formatLine(line.slice(best.start, best.end), name, lineNum, selected, opts))
    cursor = best.end
  }
}

function formatLine(text, name, lineNum, isMatch, opts) {
  const sep = isMatch ? ':' : '-'
  return (opts.showName ? (name ?? '(standard input)') + sep : '') + (opts.showLine ? lineNum + sep : '') + text
}

// -L lists files without selections, but status still reports any selected input.
export function grepSummary(inputs, res, { mode, invert, showName, max = Infinity }) {
  const out = []
  let anySelected = false
  const limit = mode === 'c' ? max : Math.min(1, max)
  for (const { name, content, recursive } of inputs) {
    const count = countMatches(content, res, invert, limit)
    if (count > 0) anySelected = true
    const label = name ?? '(standard input)'
    if (mode === 'c') out.push((showName ?? recursive) ? label + ':' + count : String(count))
    else if ((count > 0) === (mode === 'l')) out.push(label)
  }
  return { stdout: joinLines(out), stderr: '', exitCode: anySelected ? 0 : 1 }
}
