import { err, readFilesFor, splitLines } from '../util.js'

export function grepPatterns(parsed, stdin, ctx) {
  const sources = parsed.order.filter((o) => ['e', 'f', 'file'].includes(o.name))
  const rest = parsed.positional
  if (sources.length === 0) {
    return rest.length ? { patterns: rest[0].split('\n'), rest: rest.slice(1), stdin } : null
  }
  const patterns = new Set()
  for (const { name, value } of sources) {
    if (name === 'e') {
      for (const pattern of value.split('\n')) patterns.add(pattern)
      continue
    }
    const r = readFilesFor('grep', [value], ctx, stdin)
    // Pattern-file failures are fatal even with -s; it suppresses input errors only.
    if (r.failed) return { error: err(r.stderr, 2) }
    const input = r.inputs[0]
    for (const pattern of splitLines(input.content)) patterns.add(pattern)
    if (input.shared) stdin = ''
  }
  return { patterns: [...patterns], rest, stdin }
}
