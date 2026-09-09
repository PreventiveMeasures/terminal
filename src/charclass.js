// C-locale POSIX character classes shared by regex, glob, and tr parsers.
// 'word' is a GNU extension for letters, digits, and underscore.
export const POSIX_CLASSES = {
  __proto__: null,
  alpha: 'A-Za-z',
  digit: '0-9',
  alnum: '0-9A-Za-z',
  upper: 'A-Z',
  lower: 'a-z',
  space: ' \\t\\n\\v\\f\\r',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  xdigit: '0-9A-Fa-f',
  cntrl: '\\x00-\\x1F\\x7F',
  print: '\\x20-\\x7E',
  graph: '\\x21-\\x7E',
  word: '0-9A-Za-z_',
}

// ERE matching consumes numeric ranges; derive them from the same class bodies.
export const POSIX_RANGES = { __proto__: null }
for (const [name, body] of Object.entries(POSIX_CLASSES)) {
  const re = new RegExp(`[${body}]`, 'u')
  const ranges = []
  for (let code = 0; code < 128; code++) {
    if (!re.test(String.fromCodePoint(code))) continue
    const last = ranges.at(-1)
    if (last && last[1] === code - 1) last[1] = code
    else ranges.push([code, code])
  }
  POSIX_RANGES[name] = ranges
}

// GNU's RE_DUP_MAX. An interval bound above it is rejected outright
// ("Regular expression too big"), not treated as a pattern that happens
// never to match.
export const MAX_INTERVAL = 32767

export function checkInterval(min, max) {
  if (min > MAX_INTERVAL || (max !== undefined && max > MAX_INTERVAL)) throw new Error('Regular expression too big')
}

// Validate a bracket expression the way GNU's matcher does, so a pattern
// it rejects fails here too instead of quietly matching something else.
// POSIX leaves `[a-c-e]` undefined and GNU calls it an error; a `[:` that
// never closes, or that names no known class, is an error rather than a
// set of literal characters. Messages are GNU's, for callers that report
// them verbatim. Escapes are consumed as single items, matching how the
// BRE and ERE translators read a class.
export function validateBracket(pattern, start) {
  let i = start + 1
  if (pattern[i] === '^') i++
  let first = true
  let ranged = false
  while (i < pattern.length) {
    const c = pattern[i]
    // `]` is an ordinary member only in the first position.
    if (c === ']' && !first) return i
    first = false
    if (c === '[' && ':.='.includes(pattern[i + 1] ?? '')) {
      const kind = pattern[i + 1]
      const close = pattern.indexOf(kind + ']', i + 2)
      if (close === -1) throw new Error('Unmatched [, [^, [:, [., or [=')
      if (kind === ':' && !(pattern.slice(i + 2, close) in POSIX_CLASSES)) throw new Error('Invalid character class name')
      i = close + 2
      // A character class or an equivalence class names a set, so it is
      // not a range endpoint: a `-` after one reads exactly as a `-`
      // after a completed range does, an error unless it is the last
      // member. `[[:alpha:]-z]` is rejected, `[[:alpha:]-]` is not. A
      // collating element names one character and is an ordinary member.
      ranged = kind !== '.'
      continue
    }
    // A `-` directly after a completed range has no reading: GNU rejects
    // it unless it is the last member, where it is an ordinary character.
    if (c === '-' && ranged && i + 1 < pattern.length && pattern[i + 1] !== ']') throw new Error('Invalid range end')
    const width = c === '\\' && i + 1 < pattern.length ? 2 : 1
    const after = pattern[i + width]
    if (after === '-' && pattern[i + width + 1] !== undefined && pattern[i + width + 1] !== ']') {
      const endAt = i + width + 1
      const opens = pattern[endAt] === '[' ? pattern[endAt + 1] : undefined
      // ...nor the far end of one: `[a-[:digit:]]`. A collating element
      // may close the range, and is consumed whole so the scan stays in
      // step: `[a-[.z.]]`.
      if (opens === ':' || opens === '=') throw new Error('Invalid range end')
      const close = opens === '.' ? pattern.indexOf('.]', endAt + 2) : -1
      if (opens === '.' && close === -1) throw new Error('Unmatched [, [^, [:, [., or [=')
      i = close === -1 ? endAt + (pattern[endAt] === '\\' ? 2 : 1) : close + 2
      ranged = true
      continue
    }
    i += width
    ranged = false
  }
  throw new Error('Unmatched [, [^, [:, [., or [=')
}

// Read [:name:] and return its regex body and ending offset.
// Glob parsing treats unknown classes as empty sets; other callers reject them.
export function readPosixClass(s, i, opts = {}) {
  const m = /^\[:([a-z]+):\]/u.exec(s.slice(i))
  if (!m) return null
  const body = POSIX_CLASSES[m[1]]
  if (body === undefined) {
    if (opts?.unknown !== 'empty') throw new Error(`invalid character class \`[:${m[1]}:]\``)
    return { body: '', end: i + m[0].length }
  }
  return { body, end: i + m[0].length }
}
