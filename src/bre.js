import { readPosixClass } from './charclass.js'
import { UnsupportedError } from './unsupported.js'

// Callers validate GNU syntax and unsupported escapes before translation.
// A backslash in a bracket is a member, which the JS class spells `\\`.
//
// A repetition — `*`, `\+`, `\?` or `\{` — where an expression begins has
// nothing to repeat. GNU's two matchers say where that is differently:
// glibc's regex begins an expression afresh after every anchor, where the
// dfa's lexer (`laststart`) only does at the start, after `\(` and after
// `\|`, with anchors there leaving it so. A BRE reads such a repetition as
// the character it is, and where both agree that is all there is to it.
// With `grep` set — GNU grep's syntax rather than sed's, where `\{` there is
// an error — they disagree on a repetition right after an anchor that
// follows something else, `a\b*`, which the dfa applies to the anchor and
// glibc reads as a `*`. A word anchor sends the pattern to glibc, since the
// dfa cannot match one in a multibyte locale, but only for the lines the
// dfa's own reading — the anchor and the repetition taken for nothing —
// also selects; with nothing after them that is every line glibc selects,
// and glibc's reading stands. Any other is refused, and so is a `$` before
// a bare `)` or `|`, which the dfa takes for an anchor and glibc for a `$`.
export function breToEs(pattern, tables, grep = false) {
  const swap = '(){}+?|'
  let laststart = true
  let anchored = false
  let word = false
  let interval = false
  let groups = 0
  let out = ''
  // Whether the repetition ending at `end` repeats, or is the character.
  const repeats = (end) => {
    if (laststart) return false
    if (!anchored) return true
    if (!grep || (word && end === pattern.length)) return false
    throw new UnsupportedError('feature', 'regex repetition after an anchor', 'grep: a repetition directly after an anchor is read differently by GNU\'s two matchers, and is not supported')
  }
  const atom = () => { laststart = anchored = word = false }
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '[') {
      const bracket = bracketToEs(pattern, i, tables)
      out += bracket.source
      i = bracket.end
      atom()
      continue
    }
    if (c === '\\') {
      const next = pattern[++i]
      if (next === undefined) return { error: 'trailing backslash (\\)' }
      if (next === '{' && (!grep || repeats(-1))) {
        // An interval: its digits and comma pass as they are, and the `\}`
        // after them closes it.
        out += '{'; interval = true; atom()
        continue
      }
      if (next === '}' && interval) { out += '}'; interval = false; continue }
      if (next === '+' || next === '?') {
        out += repeats(i + 1) ? next : '\\' + next
        atom()
        continue
      }
      if (swap.includes(next)) {
        if (next === '(') groups++
        if (next === ')' && groups-- === 0) return { error: 'Unmatched ) or \\)' }
        out += next === '{' || (next === '}' && grep) ? '\\' + next : next
        atom()
        laststart = next === '(' || next === '|'
        continue
      }
      out += '^$\\.*[]/bBsSwW<>`\'123456789'.includes(next) ? '\\' + next : next
      if ('bB<>`\''.includes(next)) { anchored = true; word = 'bB<>'.includes(next) } else atom()
      continue
    }
    if (c === '*') {
      out += repeats(i + 1) ? '*' : '\\*'
      atom()
      continue
    }
    if (c === '^') {
      const anchor = caretIsAnchor(pattern, i)
      out += anchor ? '^' : '\\^'
      if (anchor) { anchored = true; word = false } else atom()
      continue
    }
    if (c === '$') {
      const anchor = i === pattern.length - 1 || (pattern[i + 1] === '\\' && (pattern[i + 2] === ')' || pattern[i + 2] === '|'))
      if (grep && !anchor && (pattern[i + 1] === ')' || pattern[i + 1] === '|') && i + 2 < pattern.length) {
        throw new UnsupportedError('feature', 'regex anchor', 'grep: a `$` before a bare `)` or `|` is read differently by GNU\'s two matchers, and is not supported')
      }
      out += anchor ? '$' : '\\$'
      if (anchor) { anchored = true; word = false } else atom()
      continue
    }
    out += swap.includes(c) || c === ']' ? '\\' + c : c
    atom()
  }
  return groups > 0 ? { error: 'Unmatched ( or \\(' } : { source: out }
}

// A bracket expression from its `[`, as a JS class, and where it ends: a
// backslash in it is a member, and a class name is spelt out from the
// locale's tables.
function bracketToEs(pattern, start, tables) {
  let i = start + 1
  let out = '['
  if (pattern[i] === '^') { out += '^'; i++ }
  // The first ] is a member, including immediately after negation.
  if (pattern[i] === ']') { out += '\\]'; i++ }
  for (; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '[' && (pattern[i + 1] === '.' || pattern[i + 1] === '=')) throw new UnsupportedError('feature', 'regex collating or equivalence class', 'grep: collating and equivalence classes are not supported')
    const cls = c === '[' ? readPosixClass(pattern, i, { classes: tables }) : null
    if (cls) { out += cls.body; i = cls.end - 1; continue }
    if (c === ']') return { source: out + ']', end: i }
    out += c === '\\' ? '\\\\' : c
  }
  return { source: out, end: pattern.length }
}

// POSIX BRE: `^` is an anchor at pos 0 or immediately after `\(` /
// `\|` (GNU group / alternation extension). Elsewhere it's literal.
function caretIsAnchor(pattern, i) {
  if (i === 0) return true
  if (i < 2 || pattern[i - 2] !== '\\' || (pattern[i - 1] !== '(' && pattern[i - 1] !== '|')) return false
  let escapes = 0
  for (let j = i - 3; j >= 0 && pattern[j] === '\\'; j--) escapes++
  return escapes % 2 === 0
}

// Canonical ERE: a reference must follow its closed group. JS also allows
// absent groups to match empty text, whereas GNU requires participation.
// Return whether a valid reference needs capture semantics JS cannot preserve.
export function validateBackreferences(source) {
  if (!/\\[1-9]/u.test(source)) return false
  const closed = new Set(), stack = [], unstable = new Set()
  let bracket = false, captures = 0, conditional = false
  let atomGroups = [], guaranteed = new Set()
  let nullable = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '\\') {
      const next = source[++i]
      if (!bracket && /[1-9]/u.test(next ?? '')) {
        const id = Number(next)
        if (!closed.has(id)) throw new Error('Invalid back reference')
        if (!guaranteed.has(id) || unstable.has(id)) conditional = true
      }
      atomGroups = []
      continue
    }
    if (bracket) { if (c === ']') bracket = false; continue }
    if (c === '[') { bracket = true; atomGroups = []; continue }
    if (c === '(') {
      stack.push({ id: ++captures, entry: new Set(guaranteed), branches: [], start: i })
      atomGroups = []
    } else if (c === '|') {
      const group = stack.at(-1)
      if (group) group.branches.push(guaranteed)
      guaranteed = new Set(group?.entry)
      atomGroups = []
    } else if (c === ')') {
      const group = stack.pop()
      if (!group) continue
      guaranteed = group.branches.reduce((all, branch) => all.intersection(branch), guaranteed)
      guaranteed.add(group.id)
      closed.add(group.id)
      atomGroups = [...guaranteed.difference(group.entry)]
      nullable = nullableGroup(source.slice(group.start, i + 1))
    } else if (c === '*' || c === '?' || c === '+') {
      if (c !== '?' && nullable) for (const id of atomGroups) unstable.add(id)
      if (c !== '+') for (const id of atomGroups) guaranteed.delete(id)
    } else if (c === '{') {
      const interval = /^\{(\d*)(?:,(\d*))?\}/u.exec(source.slice(i))
      if (interval) {
        if (Number(interval[1]) === 0) guaranteed = guaranteed.difference(new Set(atomGroups))
        const max = interval[2] === undefined ? Number(interval[1]) : interval[2] === '' ? Infinity : Number(interval[2])
        if (nullable && max > 1) atomGroups.forEach((id) => unstable.add(id))
        i += interval[0].length - 1
      } else atomGroups = []
    } else atomGroups = []
  }
  return conditional
}

function nullableGroup(source) {
  // Invalid standalone backreferences or GNU-only syntax prevent a proof.
  // Repeated nullable captures otherwise retain different final empty values.
  try { return new RegExp(`^(?:${source})$`, 'su').test('') } catch { return true }
}
