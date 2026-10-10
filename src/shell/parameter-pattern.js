import { compileGlob, globPattern, hasExtglob } from '../glob.js'
import { UnsupportedError } from '../unsupported.js'

const MAX_MATCH_WORK = 16_000_000
const error = (message) => new UnsupportedError('feature', '${', message)

export function trimParameter(value, word, operator) {
  if (hasExtglob(word)) throw error('extended glob patterns in parameter expansion are not supported')
  const pattern = globPattern({ value: word.value, mask: word.mask ?? null })
  const prefix = operator[0] === '#'
  const literal = literalPattern(pattern)
  if (literal !== null) {
    if (prefix) return value.startsWith(literal) ? value.slice(literal.length) : value
    return value.endsWith(literal) ? value.slice(0, value.length - literal.length) : value
  }
  const re = compileGlob(pattern, { bash: true })
  const longest = operator.length === 2
  const backward = prefix === longest
  let at = backward ? value.length : 0, work = 0
  while (at >= 0 && at <= value.length) {
    const candidate = prefix ? value.slice(0, at) : value.slice(at)
    work += candidate.length + pattern.length
    if (work > MAX_MATCH_WORK) throw error('parameter pattern removal exceeds the matching work limit')
    if (re.test(candidate)) return prefix ? value.slice(at) : value.slice(0, at)
    at = advance(value, at, backward)
  }
  return value
}

export function replaceParameter(value, word, replacement, global) {
  let anchor = ''
  if (!global && /^[#%]/u.test(word.value) && (!word.mask || word.mask[0] === '0')) {
    anchor = word.value[0]
    word = { value: word.value.slice(1), mask: word.mask?.slice(1) ?? null }
  }
  if (hasExtglob(word)) throw error('extended glob patterns in parameter expansion are not supported')
  const pattern = globPattern({ value: word.value, mask: word.mask ?? null })
  const state = { work: 0 }
  const render = replacementRenderer(replacement, state)
  if (!pattern) return anchor === '#' ? render('') + value : anchor === '%' ? value + render('') : value
  // Bash's search prefilter treats a lone trailing backslash differently
  // across anchor and locale modes; quoted literal backslashes are paired.
  if ((/\\+$/u.exec(pattern)?.[0].length ?? 0) % 2) {
    throw error('unescaped trailing backslashes in replacement patterns are not supported')
  }
  if (missized(pattern)) return value
  const literal = literalPattern(pattern)
  const find = literal === null ? globFinder(value, pattern, anchor, state) : literalFinder(value, literal, anchor)
  const out = []
  let from = 0
  do {
    const match = find(from)
    if (!match) break
    const [start, end] = match
    const inserted = render(value.slice(start, end))
    charge(state, start - from)
    out.push(value.slice(from, start), inserted)
    from = end
    if (!global) break
    if (start === end) {
      const next = advance(value, from, false)
      out.push(value.slice(from, next))
      from = next
    }
  } while (from < value.length)
  out.push(value.slice(from))
  return out.join('')
}

// Bash 5.2 sizes a replacement pattern with no `*` before matching it, and
// tries only substrings of that size. Its sizing (umatchlen) ends a bracket
// expression at the first `]` after the character it takes for granted, so
// `[!]]` and `[^]a]` size as a bracket and then more characters: every
// substring tried is longer than anything the pattern matches, and it
// matches nothing at all. A `*` ahead of the size being fixed leaves the
// pattern to match as any other.
function missized(pattern) {
  let missed = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') i++
    else if (c === '*') return false
    else if (c === '[') {
      if ((pattern[i + 1] === '!' || pattern[i + 1] === '^') && pattern[i + 2] === ']') missed = true
      i = bracketEnd(pattern, i) - 1
    }
  }
  return missed
}

// Where umatchlen's reading of a bracket expression ends: past its first
// character, escapes and `[:…:]` classes, at the next `]` — or at the end
// of a pattern that never closes it.
function bracketEnd(pattern, open) {
  let j = open + 1
  let c = pattern[j++]
  let inside = null
  do {
    if (c === undefined) return pattern.length
    if (c === '\\') {
      if (pattern[j] === undefined || pattern[++j] === undefined) return pattern.length
    } else if (c === '[' && /[:.=]/u.test(pattern[j] ?? '')) inside = pattern[j++]
    else if (inside !== null && c === inside && pattern[j] === ']') { j++; inside = null }
  } while ((c = pattern[j++]) !== ']')
  return j
}

function literalFinder(value, pattern, anchor) {
  return (from) => {
    const at = anchor === '%' ? value.length - pattern.length : value.indexOf(pattern, from)
    if (at < from || (anchor === '#' && at !== 0) || value.slice(at, at + pattern.length) !== pattern) return null
    return [at, at + pattern.length]
  }
}

function globFinder(value, pattern, anchor, state) {
  const re = compileGlob(pattern, { bash: true })
  return (from) => {
    for (let start = from; start <= value.length; start = advance(value, start, false)) {
      for (let end = value.length; end >= start; end = advance(value, end, true)) {
        charge(state, end - start + pattern.length)
        if (re.test(value.slice(start, end))) return [start, end]
        if (anchor === '%') break
      }
      if (anchor === '#') break
    }
    return null
  }
}

function charge(state, amount) {
  state.work += amount
  if (state.work > MAX_MATCH_WORK) throw error('parameter replacement exceeds the matching work limit')
}

function replacementRenderer(word, state) {
  let source = ''
  for (let i = 0; i < word.value.length; i++) {
    const c = word.value[i]
    if (word.mask?.[i] !== undefined && word.mask[i] !== '0' && (c === '&' || c === '\\')) source += '\\'
    source += c
  }
  return (matched) => {
    const out = []
    for (let i = 0; i < source.length; i++) {
      const c = source[i]
      const piece = c === '\\' && /[&\\]/u.test(source[i + 1] ?? '') ? source[++i] : c === '&' ? matched : c
      charge(state, piece.length)
      out.push(piece)
    }
    return out.join('')
  }
}

function advance(value, at, backward) {
  const next = at + (backward ? -1 : 1)
  if (next > 0 && next < value.length && /[\uDC00-\uDFFF]/u.test(value[next]) && /[\uD800-\uDBFF]/u.test(value[next - 1])) {
    return next + (backward ? -1 : 1)
  }
  return next
}

function literalPattern(pattern) {
  let value = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\' && i + 1 < pattern.length) value += pattern[++i]
    else if (/[*?[]/u.test(c)) return null
    else value += c
  }
  return value
}
