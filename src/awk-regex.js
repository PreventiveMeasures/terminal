// Compiled awk regexes. Every pattern — literal or dynamic — is parsed
// once (awk-re-parse.js) and serves two matchers: a JS RegExp for the
// yes/no tests, where its leftmost-first answer is the right answer
// and native speed matters on a pattern-per-record hot path, and a
// leftmost-longest NFA (awk-re.js) for every operation that needs the
// EXTENT of a match — sub, gsub, gensub, match, split, FS, RS, FPAT.
// The two engines share one AST, so they accept the same language.
//
// Instances are cached by source and case mode: IGNORECASE can flip at
// run time, and a dynamic regex built in the main loop would otherwise
// recompile per record.

import { AwkError } from './awk-common.js'
import { parseEre, toJsSource } from './awk-re-parse.js'
import { compileNfa, search } from './awk-re.js'

const CACHE = new Map()

export class AwkRegex {
  constructor(src, ignoreCase, warn) {
    const { ast, groups } = parseEre(src, warn)
    this.src = src
    this.ignoreCase = ignoreCase
    this.groupCount = groups
    this.source = toJsSource(ast)
    this.flags = ignoreCase ? 'siu' : 'su'
    try {
      this.js = new RegExp(this.source, this.flags)
    } catch (e) {
      throw new AwkError(`invalid regex /${src}/: ${e.message}`)
    }
    this.ast = ast
    this.nfa = null
    this.captureShape = captureShape(ast)
  }

  test(s) { this.checkLocale(s); return this.js.test(s) }

  checkLocale(s) {
    if (this.src.includes('[:') && [...s].some((c) => c.codePointAt(0) > 127)) throw new AwkError('POSIX character classes on non-ASCII input require locale support', null, 'locale-sensitive character classes')
  }

  // Leftmost-longest match at or after `from`: { start, end } or null.
  search(s, from = 0) {
    this.checkLocale(s)
    if (this.nfa === null) this.nfa = compileNfa(this.ast, this.ignoreCase)
    return search(this.nfa, s, from)
  }

  // Keep the original subject for assertions and constrain the end to
  // the NFA's match. Slicing the match would change ^, $, and boundaries.
  groups(s, start, end) {
    if (this.captureShape.unsafe) throw new AwkError('capture extraction across repeated or alternative groups is not supported', null, 'regex capture semantics')
    const remaining = Array.from(s.slice(end)).length
    const re = new RegExp(`(?:${this.source})(?=.{${remaining}}(?![^]))`, this.flags + 'dy')
    re.lastIndex = start
    const m = re.exec(s)
    if (!m) throw new AwkError('capture extraction for this match is not supported', null, 'regex capture semantics')
    return m.indices.map((span, i) => (span === undefined ? undefined : { text: m[i], start: span[0], end: span[1] }))
  }
}

// JS resets captures omitted by a later repetition; GNU retains them.
// Alternative branches containing captures also use different tie rules.
// Extent-only operations remain supported for these patterns.
function captureShape(node) {
  const children = node.nodes ?? (node.node ? [node.node] : [])
  const shapes = children.map(captureShape)
  const groups = shapes.reduce((n, s) => n + s.groups, node.type === 'group' ? 1 : 0)
  const nullable = node.type === 'assert' || ((node.type === 'group' || node.type === 'cat') && shapes.every((s) => s.nullable)) || (node.type === 'alt' && shapes.some((s) => s.nullable)) || (node.type === 'rep' && (node.min === 0 || shapes[0].nullable))
  const repeated = node.type === 'rep' && (node.max === null || node.max > 1) && (groups > 1 || (groups > 0 && shapes[0].nullable))
  return { groups, nullable, unsafe: repeated || (node.type === 'alt' && groups > 0) || shapes.some((s) => s.unsafe) }
}

export function compileRegex(src, ignoreCase = false, warn = null) {
  const key = (ignoreCase ? 'i' : 'c') + src
  const cached = CACHE.get(key)
  if (cached) return cached
  if (CACHE.size >= 500) CACHE.clear()
  const re = new AwkRegex(src, ignoreCase, warn)
  CACHE.set(key, re)
  return re
}

// One UTF-16 step at `at`: 2 across a surrogate pair, else 1.
export function stepAt(s, at) {
  return s.codePointAt(at) > 0xFFFF ? 2 : 1
}

// Split `str` at every NON-empty match of `re`; empty matches are not
// separators (gawk: `split("abc", a, /x*/)` is one field).
export function splitByRegex(str, re) {
  const out = []
  let pos = 0
  let last = 0
  while (pos <= str.length) {
    const m = re.search(str, pos)
    if (!m) break
    if (m.start === m.end) {
      if (m.end >= str.length) break
      pos = m.end + stepAt(str, m.end)
      continue
    }
    out.push(str.slice(last, m.start))
    last = m.end
    pos = m.end
  }
  out.push(str.slice(last))
  return out
}

// The substitution loop behind sub, gsub and gensub, with the POSIX
// rule for empty matches: an empty match immediately after the previous
// match is not a match (`gsub(/b*/, "-", "abc")` is `-a-c-`, not
// `-a--c-`), and an empty match elsewhere replaces nothing but still
// counts. `replace(start, end, index)` returns the replacement text for
// the index-th match (1-based) or null to leave it as it was. `mode` is
// 'first' (sub), 'global' (gsub, gensub "g") or 'nth' (gensub with a
// number), where gawk counts every empty match, skip rule or not.
export function substituteAll(str, re, replace, mode) {
  const global = mode !== 'first'
  const n = str.length
  let out = ''
  let pos = 0
  let lastEnd = -1
  let count = 0
  while (pos <= n) {
    const m = re.search(str, pos)
    if (!m) break
    const empty = m.start === m.end
    if (empty && m.start === lastEnd && mode !== 'nth') {
      if (m.start >= n) break
      const step = stepAt(str, m.start)
      out += str.slice(pos, m.start + step)
      pos = m.start + step
      continue
    }
    count++
    const text = replace(m.start, m.end, count)
    out += str.slice(pos, m.start) + (text === null ? str.slice(m.start, m.end) : text)
    lastEnd = m.end
    if (empty) {
      if (m.end >= n) { pos = n; break }
      const step = stepAt(str, m.end)
      out += str.slice(m.end, m.end + step)
      pos = m.end + step
    } else pos = m.end
    if (!global) break
  }
  return { out: out + str.slice(pos), count }
}
