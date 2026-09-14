import { UnsupportedError } from '../unsupported.js'

// Preserve empty quoted fragments through brace expansion and assignment
// slicing. Their positions matter: $x"" keeps a final empty field even
// when x ends in a field separator.
export function sliceWord(w, start = 0, end = w.value.length) {
  return {
    value: w.value.slice(start, end),
    mask: w.mask === null ? null : w.mask.slice(start, end),
    ...(w.empty ? { empty: w.empty.filter((i) => i >= start && i <= end).map((i) => i - start) } : {}),
  }
}

// An assignment prefix is recognized only when both its name and '=' are bare.
export function assignmentOf(w) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(w.value)
  if (!match || (w.mask !== null && /[12]/u.test(w.mask.slice(0, match[0].length)))) return null
  if (w.empty?.some((i) => i < match[0].length)) return null
  return { name: match[1], end: match[0].length }
}

const maskAt = (w, i) => (w.mask === null ? '0' : w.mask[i])

// Where a `~` stands for the home directory, by bash's rule for a tilde
// prefix: one opens a word, or an assignment component after `=` or a bare
// `:`; nothing in it may be quoted, since a quote anywhere leaves the text
// alone; and it ends at the first bare `/`, at a bare `:` inside an
// assignment, or with the word. Anything written between the `~` and that end
// names a user or the directory stack, and this shell has neither — bash
// expands `~alice`, so reading it as the text it is would answer a different
// question than the one asked.
export function homePrefixes(w, assignmentValue = false) {
  const marks = new Set()
  if (!w.value.includes('~')) return marks
  const v = w.value
  const bare = (i) => maskAt(w, i) === '0'
  const eqLen = assignmentValue ? null : assignmentOf(w)?.end ?? null
  const inValue = (i) => assignmentValue === true || (eqLen !== null && i >= eqLen)
  for (let i = 0; i < v.length; i++) {
    const opens = i === 0 || i === eqLen || (inValue(i) && v[i - 1] === ':' && bare(i - 1))
    const assignment = inValue(i) || assignmentValue === 'parameterAssign'
    if (!opens || v[i] !== '~' || !bare(i) || !unquotedTilde(w, i, assignment)) continue
    const n = v[i + 1]
    if (n && n !== '/' && n !== ':' && bare(i + 1)) throw new UnsupportedError('feature', 'tilde prefix', 'named-user and directory-stack tilde prefixes are not supported')
    if (n === undefined || (bare(i + 1) && (n === '/' || (n === ':' && assignment)))) marks.add(i)
  }
  return marks
}

function unquotedTilde(w, start, assignment) {
  // Empty quotes also inhibit expansion: ~''/x and ''~/x are literal paths.
  for (let i = start; i <= w.value.length; i++) {
    if (w.empty?.includes(i)) return false
    if (i === w.value.length) return true
    if (maskAt(w, i) !== '0') return false
    if (w.value[i] === '/' || (assignment && w.value[i] === ':')) return true
  }
  return true
}

export function concatWords(...words) {
  let value = ''
  let mask = ''
  const empty = []
  for (const w of words) {
    for (const i of w.empty ?? []) empty.push(value.length + i)
    value += w.value
    mask += w.mask ?? '0'.repeat(w.value.length)
  }
  return { value, mask: words.every((w) => w.mask === null) ? null : mask, ...(empty.length ? { empty } : {}) }
}
