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
    this.anchored = null
  }

  test(s) { return this.js.test(s) }

  // Leftmost-longest match at or after `from`: { start, end } or null.
  search(s, from = 0) {
    if (this.nfa === null) this.nfa = compileNfa(this.ast, this.ignoreCase)
    return search(this.nfa, s, from)
  }

  // Capture groups for a match whose extent is already known: the JS
  // regex, anchored to exactly that span, assigns the groups. Entry 0 is
  // the whole match; a group that did not take part is undefined.
  groups(s, start, end) {
    if (this.anchored === null) this.anchored = new RegExp(`^(?:${this.source})$`, this.flags + 'd')
    const m = this.anchored.exec(s.slice(start, end))
    if (!m) return [{ text: s.slice(start, end), start, end }]
    return m.indices.map((span, i) => (span === undefined ? undefined : { text: m[i], start: start + span[0], end: start + span[1] }))
  }
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
