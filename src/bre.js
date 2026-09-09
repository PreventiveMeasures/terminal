import { readPosixClass } from './charclass.js'
import { UnsupportedError } from './unsupported.js'

// Callers validate GNU syntax and unsupported escapes before translation.
export function breToEs(pattern) {
  const swap = '(){}+?|'
  let canRepeat = false, groups = 0, inClass = false, out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (inClass) {
      if (c === '[' && (pattern[i + 1] === '.' || pattern[i + 1] === '=')) throw new UnsupportedError('feature', 'regex collating or equivalence class', 'grep: collating and equivalence classes are not supported')
      if (c === '[') {
        const cls = readPosixClass(pattern, i)
        if (cls) { out += cls.body; i = cls.end - 1; continue }
      }
      out += c
      if (c === ']') { inClass = false; canRepeat = true }
      continue
    }
    if (c === '[') {
      out += c; inClass = true
      if (pattern[i + 1] === '^') { out += '^'; i++ }
      // The first ] is a member, including immediately after negation.
      if (pattern[i + 1] === ']') { out += '\\]'; i++ }
      continue
    }
    if (c === '\\') {
      const next = pattern[++i]
      if (next === undefined) return { error: 'trailing backslash (\\)' }
      if (swap.includes(next)) {
        if ((next === '+' || next === '?') && !canRepeat) {
          out += '\\' + next; canRepeat = true; continue
        }
        if (next === '(') groups++
        if (next === ')' && groups-- === 0) return { error: 'Unmatched ) or \\)' }
        if (next === '(' || next === '|') canRepeat = false
        if (next === ')' || next === '}') canRepeat = true
        out += next
      } else {
        out += '^$\\.*[]/bBsSwW<>`\'123456789'.includes(next) ? '\\' + next : next
        canRepeat = !'bB<>`\''.includes(next)
      }
      continue
    }
    if (c === '*') { out += canRepeat ? '*' : '\\*'; canRepeat = true; continue }
    if (c === '^') {
      canRepeat = !caretIsAnchor(pattern, i)
      out += canRepeat ? '\\^' : '^'
      continue
    }
    if (c === '$') {
      canRepeat = !(i === pattern.length - 1 || (pattern[i + 1] === '\\' && (pattern[i + 2] === ')' || pattern[i + 2] === '|')))
      out += canRepeat ? '\\$' : '$'
      continue
    }
    out += swap.includes(c) ? '\\' + c : c
    canRepeat = true
  }
  return groups > 0 ? { error: 'Unmatched ( or \\(' } : { source: out }
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
