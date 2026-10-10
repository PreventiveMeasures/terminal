// Arrays kept the way gawk 5.2 keeps them, because `for (k in a)` walks an
// array in the order its storage happens to hold the elements, and programs
// print in that order. gawk picks a representation from the first subscript
// an empty array receives: a non-negative integer makes a "cint" array (the
// integers in power-of-two blocks, walked in ascending order), a negative
// integer an "int" hash table, anything else a "str" hash table (the two
// tables are ./hashed.js). A cint or int array keeps the subscripts it
// cannot take in a second array of its own (the "xarray"), walked first; an
// array that empties goes back to having no representation, and one whose
// own part empties becomes its xarray. The sizes and thresholds below are
// gawk's (cint_array.c), so the walk is too.

import { intExists, intList, intLookup, intRemove, isInteger, node, promote, reset, strExists, strList, strLookup, strRemove } from './hashed.js'

export { subscript } from './hashed.js'

const NHAT = 10
const THRESHOLD = 2 ** (NHAT + 1)

const isUinteger = (sub) => isInteger(sub) && sub.int >= 0

function lookup(n, sub) {
  switch (n.type) {
    case 'str': return strLookup(n, sub)
    case 'int': return intLookup(n, sub)
    case 'cint': return cintLookup(n, sub)
    default:
      // null_lookup: cint, then int, then str takes the first subscript.
      n.type = isUinteger(sub) ? 'cint' : isInteger(sub) ? 'int' : 'str'
      return lookup(n, sub)
  }
}

function exists(n, sub) {
  if (n.type === 'str') return strExists(n, sub)
  if (n.type === 'int') return intExists(n, sub)
  if (n.type === 'cint') return cintExists(n, sub)
}

function remove(n, sub) {
  if (n.type === 'str') return strRemove(n, sub)
  if (n.type === 'int') return intRemove(n, sub)
  return n.type === 'cint' && cintRemove(n, sub)
}

function list(n, out) {
  if (n.type === 'str') strList(n, out)
  else if (n.type === 'int') intList(n, out)
  else if (n.type === 'cint') cintList(n, out)
  return out
}

// ---- cint: non-negative integers in power-of-two blocks, walked in
// ascending order. Only the leaf arrays' total size matters to anything
// observable: a subscript that would leave too much of it unused goes to the
// xarray instead.

// 1 + floor(log2 k), with one block for everything below 2^NHAT.
function cintHash(k) {
  const r = 31 - Math.clz32(k)
  return k === 0 || r < NHAT ? NHAT : r + 1
}

// The leaf array holding k: its first subscript and its size. A block of
// 2^m subscripts is a HAT of 2^n leaves of 2^n, n = ceil(m / 2), split again
// while n is above NHAT.
function leafOf(k) {
  let m = cintHash(k) - 1
  let base = 0
  if (m < NHAT) m = NHAT
  else base = 2 ** m
  for (;;) {
    const n = (m + 1) >> 1
    const size = 2 ** n
    base += size * Math.floor((k - base) / size)
    if (n <= NHAT) return { base, size }
    m = n
  }
}

function cintLookup(n, sub) {
  if (n.d === null) n.d = { ints: new Map(), leaves: new Map(), capacity: 0 }
  const { d } = n
  let k = -1
  if (isUinteger(sub)) {
    k = sub.int
    const found = d.ints.get(k)
    if (found !== undefined) return found
  }
  let xn = n.x
  if (xn !== null) {
    const found = exists(xn, sub)
    if (found !== undefined) return found
  }
  if (k >= 0) {
    let li = Math.max(cintHash(k) - 1, NHAT)
    while (li >= NHAT) li = (li + 1) >> 1
    const own = xn === null ? n.size : n.size - xn.size
    if (d.capacity + 2 ** li - own <= THRESHOLD) {
      n.size++
      const { base, size } = leafOf(k)
      const count = d.leaves.get(base) ?? 0
      if (count === 0) d.capacity += size
      d.leaves.set(base, count + 1)
      const entry = { value: undefined }
      d.ints.set(k, entry)
      return entry
    }
  }
  n.size++
  if (xn === null) {
    xn = n.x = node()
    xn.type = isInteger(sub) ? 'int' : 'str'
  }
  return lookup(xn, sub)
}

function cintExists(n, sub) {
  if (isUinteger(sub)) {
    const found = n.d.ints.get(sub.int)
    if (found !== undefined) return found
  }
  return n.x === null ? undefined : exists(n.x, sub)
}

function cintRemove(n, sub) {
  if (n.size === 0) return false
  const { d } = n
  const xn = n.x
  if (isUinteger(sub) && d.ints.delete(sub.int)) {
    const { base, size } = leafOf(sub.int)
    const count = d.leaves.get(base) - 1
    if (count === 0) { d.leaves.delete(base); d.capacity -= size } else d.leaves.set(base, count)
    n.size--
    if (xn === null && n.size === 0) reset(n)
    else if (xn !== null && n.size === xn.size) promote(n, xn)
    return true
  }
  if (xn === null || !remove(xn, sub)) return false
  if (xn.size === 0) n.x = null
  n.size--
  return true
}

function cintList(n, out) {
  if (n.x !== null) list(n.x, out)
  const ints = Array.from(n.d.ints.keys()).sort((a, b) => a - b)
  for (const k of ints) out.push(String(k))
}

// An awk array, named for the variable it was made for. Elements are
// { value } cells: `lookup` finds or creates one (as referencing an
// element does), `get` only finds one.
export class AwkArray {
  constructor(vname) { this.root = node(); this.vname = vname }
  get size() { return this.root.size }
  lookup(sub) { return lookup(this.root, sub) }
  get(sub) { return exists(this.root, sub) }
  has(sub) { return exists(this.root, sub) !== undefined }
  remove(sub) { return remove(this.root, sub) }
  clear() { reset(this.root) }
  // The subscripts in gawk's `for (k in a)` order, each as the value the
  // loop variable takes: a string, or input text that keeps its type.
  keys() { return list(this.root, []) }
}
