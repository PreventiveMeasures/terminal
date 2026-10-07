import { err, readFilesFor, splitLines } from '../util.js'

// GNU's word for a command line it cannot run.
export const GREP_USAGE = "Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n"

// The patterns a search was given, read as GNU reads its options: in order,
// each taken when it is met, and the first one GNU cannot take ending the
// run there — `check` answers for the options that are not patterns. GNU
// keeps one copy of a pattern given twice, and says where each came from
// when glibc rejects it: nowhere for one given on the command line, and
// `FILE:LINE: ` for one read from a file.
export function grepPatterns(parsed, stdin, ctx, check = () => null) {
  const rest = parsed.positional
  const patterns = new Map()
  let given = false
  const add = (pattern, origin) => { if (!patterns.has(pattern)) patterns.set(pattern, origin) }
  for (const entry of parsed.order) {
    const { name, value } = entry
    if (name !== 'e' && name !== 'f') {
      const error = check(entry)
      if (error) return { error }
      continue
    }
    given = true
    if (name === 'e') {
      for (const pattern of value.split('\n')) add(pattern, '')
      continue
    }
    const r = readFilesFor('grep', [value], ctx, stdin)
    // Pattern-file failures are fatal even with -s; it suppresses input errors only.
    if (r.failed) return { error: err(r.stderr, 2) }
    const input = r.inputs[0]
    splitLines(input.content).forEach((pattern, line) => add(pattern, `${value}:${line + 1}: `))
    if (input.shared) stdin = ''
  }
  if (!given) {
    if (!rest.length) return null
    for (const pattern of rest[0].split('\n')) add(pattern, '')
    return { patterns: [...patterns.keys()], origins: [...patterns.values()], rest: rest.slice(1), stdin }
  }
  return { patterns: [...patterns.keys()], origins: [...patterns.values()], rest, stdin }
}
