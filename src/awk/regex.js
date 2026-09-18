// One parsed AST feeds a JS RegExp for boolean tests and a leftmost-longest
// NFA for match extents (sub/gsub/gensub, match, splitting). Cache by source
// and case mode because dynamic patterns and IGNORECASE can change per record.
// Case folding is spelt into the AST by the parser, from the locale's
// tables, so both matchers run case-sensitively.

import { AwkError } from './common.js'
import { EXTENDED_C, LOCALE, classTables } from '../locale.js'
import { parseEre, toJsSource } from './re-parse.js'
import { compileNfa, search } from './re.js'
import { stepAt } from '../unicode.js'

export { stepAt }

const CACHE = new Map()

export class AwkRegex {
  constructor(src, ignoreCase, warn, tables = classTables(LOCALE)) {
    const { ast, groups } = parseEre(src, warn, tables, ignoreCase)
    this.src = src
    this.ignoreCase = ignoreCase
    this.tables = tables
    this.groupCount = groups
    this.source = toJsSource(ast, tables)
    this.flags = 'su'
    try {
      this.js = new RegExp(this.source, this.flags)
    } catch (e) {
      throw new AwkError(`cannot compile regex /${src}/: ${e.message}`, null, 'regex engine limit')
    }
    this.ast = ast
    this.nfa = null
    this.capture = null
    this.captureShape = captureShape(ast)
  }

  test(s) { this.checkCase(s); return this.js.test(s) }

  // GNU's two matchers fold the Cyrillic Extended-C letters differently
  // (see EXTENDED_C), so a case-insensitive match over them is refused.
  checkCase(s) {
    if (this.ignoreCase && EXTENDED_C.test(s + this.src)) throw new AwkError('case-insensitive matching over Cyrillic Extended-C letters is not supported', null, 'locale-sensitive regex')
  }

  // Leftmost-longest match at or after `from`: { start, end } or null.
  search(s, from = 0) {
    this.checkCase(s)
    if (this.nfa === null) this.nfa = compileNfa(this.ast, this.tables)
    return search(this.nfa, s, from)
  }

  // Keep the original subject for assertions and constrain the end to
  // the NFA's match. Slicing the match would change ^, $, and boundaries.
  groups(s, start, end) {
    if (this.captureShape.unsafe) throw new AwkError('capture extraction across repeated or alternative groups is not supported', null, 'regex capture semantics')
    const capture = this.capture ??= new RegExp(this.source, this.flags + 'dy')
    capture.lastIndex = start
    let m = capture.exec(s)
    // The native match usually has the requested extent. POSIX alternatives
    // can be longer; constrain those matches without slicing their context.
    if (!m || m.index !== start || start + m[0].length !== end) {
      const remaining = Array.from(s.slice(end)).length
      const re = new RegExp(`(?:${this.source})(?=.{${remaining}}(?![^]))`, this.flags + 'dy')
      re.lastIndex = start
      m = re.exec(s)
    }
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

export function compileRegex(src, ignoreCase = false, warn = null, tables = classTables(LOCALE)) {
  const key = (ignoreCase ? 'i' : 'c') + tables.name + '\0' + src
  const cached = CACHE.get(key)
  if (cached) return cached
  if (CACHE.size >= 500) CACHE.clear()
  const re = new AwkRegex(src, ignoreCase, warn, tables)
  CACHE.set(key, re)
  return re
}

// Empty matches delimit neither RS records nor FS fields.
export function nonEmptyMatch(str, re, from) {
  for (;;) {
    const match = re.search(str, from)
    if (!match || match.start !== match.end) return match
    if (match.end >= str.length) return null
    from = match.end + stepAt(str, match.end)
  }
}

export function splitByRegex(str, re) {
  const out = []
  let pos = 0
  for (;;) {
    const match = nonEmptyMatch(str, re, pos)
    if (!match) break
    out.push(str.slice(pos, match.start))
    pos = match.end
  }
  out.push(str.slice(pos))
  return out
}

// sub/gsub/gensub share empty-match handling: an empty match immediately
// after a match is skipped, except gensub with a numeric selector counts it.
// replace(start, end, index) returns text or null to keep the match unchanged.
// Modes: first (sub), global (gsub/gensub "g"), nth (numeric gensub).
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
