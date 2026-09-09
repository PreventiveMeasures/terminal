// POSIX leftmost-longest matching for operations that need match extents.
// A Thompson NFA carries each thread's start offset and keeps threads in start
// order, searching until no thread can beat the best match. Work is linear in
// text length times pattern size, without backtracking.
// States use next for consuming edges and x/y for split edges.

import { AwkError } from './common.js'
import { codePointSize } from '../unicode.js'

const MAX_STATES = 50_000

const isWordCode = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || c === 95 || (c >= 97 && c <= 122)

function caseVariants(code) {
  const ch = String.fromCodePoint(code)
  return [code, ch.toLowerCase().codePointAt(0), ch.toUpperCase().codePointAt(0)]
}

function setTest(items, negate, ignoreCase) {
  const inSet = (c) => {
    for (let k = 0; k < items.length; k++) if (c >= items[k][0] && c <= items[k][1]) return true
    return false
  }
  if (!ignoreCase) return negate ? (c) => !inSet(c) : inSet
  const folded = (c) => caseVariants(c).some(inSet)
  return negate ? (c) => !folded(c) : folded
}

export function compileNfa(ast, ignoreCase) {
  const states = []
  const push = (s) => {
    if (states.length >= MAX_STATES) throw new AwkError('regex too large', null, 'regex state limit')
    states.push(s)
    return states.length - 1
  }
  // Continuation style: compile `node` so that it continues at `next`,
  // returning the entry state.
  function comp(node, next) {
    switch (node.type) {
      case 'char': return push({ op: 'char', codes: ignoreCase ? caseVariants(node.code) : [node.code], next })
      case 'any': return push({ op: 'any', next })
      case 'set': return push({ op: 'set', test: setTest(node.items, node.negate, ignoreCase), next })
      case 'assert': return push({ op: 'assert', kind: node.kind, next })
      case 'group': return comp(node.node, next)
      case 'cat': {
        let cur = next
        for (let k = node.nodes.length - 1; k >= 0; k--) cur = comp(node.nodes[k], cur)
        return cur
      }
      case 'alt': {
        const entries = node.nodes.map((n) => comp(n, next))
        let cur = entries.at(-1)
        for (let k = entries.length - 2; k >= 0; k--) cur = push({ op: 'split', x: entries[k], y: cur })
        return cur
      }
      case 'rep': return repeat(node, next)
      default: throw new AwkError(`internal: unknown regex node ${node.type}`)
    }
  }
  // X{min,max}: `min` copies of X, then either a loop (unbounded) or
  // `max - min` nested optional copies.
  function repeat(node, next) {
    let cur = next
    if (node.max === null) {
      const loop = push({ op: 'split', x: -1, y: next })
      states[loop].x = comp(node.node, loop)
      cur = loop
    } else {
      for (let k = node.max - node.min; k > 0; k--) cur = push({ op: 'split', x: comp(node.node, cur), y: next })
    }
    for (let k = 0; k < node.min; k++) cur = comp(node.node, cur)
    return cur
  }
  const start = comp(ast, push({ op: 'match' }))
  // A nonempty ASCII character chain has one fixed extent. Compile the full
  // NFA first so even these patterns retain the normal state-limit diagnostic.
  let literal = '', pc = start
  while (states[pc].op === 'char' && states[pc].codes.length === 1 && states[pc].codes[0] < 128) {
    literal += String.fromCodePoint(states[pc].codes[0])
    pc = states[pc].next
  }
  if (states[pc].op !== 'match' || literal === '') literal = null
  return { states, start, literal, gen: new Int32Array(states.length).fill(-1), stamp: 0 }
}

function codeBefore(str, at) {
  if (at <= 0) return -1
  const low = str.codePointAt(at - 1)
  if (low >= 0xDC00 && low <= 0xDFFF && at >= 2) return str.codePointAt(at - 2)
  return low
}

function checkAssert(kind, str, at) {
  if (kind === '^') return at === 0
  if (kind === '$') return at === str.length
  const before = isWordCode(codeBefore(str, at))
  const here = at < str.length && isWordCode(str.codePointAt(at))
  if (kind === 'y') return before !== here
  if (kind === 'B') return before === here
  if (kind === '<') return !before && here
  return before && !here
}

function consumes(s, code) {
  if (s.op === 'char') return s.codes.includes(code)
  if (s.op === 'any') return true
  return s.test(code)
}

// The leftmost-longest match of `nfa` in `str` at or after `from`, as
// { start, end } (code unit offsets, end exclusive), or null.
export function search(nfa, str, from) {
  if (nfa.literal !== null && Number.isInteger(from) && from >= 0 && from <= str.length && !Object.is(from, -0)) {
    const start = str.indexOf(nfa.literal, from)
    return start < 0 ? null : { start, end: start + nfa.literal.length }
  }
  const { states, gen } = nfa
  const n = str.length
  // Follow epsilon edges from `pc`, adding the consuming states reached
  // to `list`. `gen` marks states already on the list for this
  // generation: the first arrival wins, and lists are kept in start
  // order, so that is the thread with the earliest start. Flat pc/start
  // pairs avoid allocating a thread object for every state and character.
  const stack = []
  const add = (list, pc0, start, at, stamp) => {
    stack.push(pc0)
    while (stack.length > 0) {
      const pc = stack.pop()
      if (gen[pc] === stamp) continue
      gen[pc] = stamp
      const s = states[pc]
      if (s.op === 'split') stack.push(s.y, s.x)
      else if (s.op === 'assert') { if (checkAssert(s.kind, str, at)) stack.push(s.next) }
      else list.push(pc, start)
    }
  }
  let clist = []
  let nlist = []
  let best = null
  let pos = from
  let stampC = ++nfa.stamp
  for (;;) {
    // New attempts start at every position until something has matched.
    if (best === null) add(clist, nfa.start, pos, pos, stampC)
    const code = pos < n ? str.codePointAt(pos) : -1
    const step = codePointSize(code)
    if (clist.length === 0) {
      if (best !== null || pos >= n) break
      pos += step
      stampC = ++nfa.stamp
      continue
    }
    const stampN = ++nfa.stamp
    for (let i = 0; i < clist.length; i += 2) {
      const pc = clist[i], start = clist[i + 1]
      if (best !== null && start > best.start) continue
      const s = states[pc]
      if (s.op === 'match') {
        if (best === null || start < best.start || (start === best.start && pos > best.end)) best = { start, end: pos }
        continue
      }
      if (code !== -1 && consumes(s, code)) add(nlist, s.next, start, pos + step, stampN)
    }
    clist.length = 0
    ;[clist, nlist] = [nlist, clist]
    stampC = stampN
    if (pos >= n) break
    pos += step
  }
  return best
}
