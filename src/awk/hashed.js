// gawk's two hash tables (str_array.c and int_array.c), kept as gawk keeps
// them so that ./array.js can walk them in gawk's order: the same hash
// functions, the same prime table sizes and growth points, the same chain
// orders. A str table holds strings in chains, newest first; an int table
// holds 32-bit integers two to a bucket, and the subscripts it cannot take
// in a str table of its own (its "xarray"), walked first.
//
// A subscript is { key, int, v }: the string the element is named by, the
// integer gawk's is_integer() reads it as (null when it reads none), and the
// value it was computed from — whose type decides, for a str table, what a
// `for (k in a)` loop variable gets back. A table is a node { type, size,
// x, d }: its kind, its element count (its xarray's included), its xarray,
// and its own storage.

import { StrNum, forcedNumeric, numberedString } from './value.js'
import { encodeUtf8Loose } from '../util.js'

const CHAIN_MAX = 2
const SIZES = [
  13, 127, 1021, 8191, 16381, 32749, 65497, 131101, 262147, 524309, 1048583, 2097169,
  4194319, 8388617, 16777259, 33554467, 67108879, 134217757, 268435459, 536870923, 1073741827,
]

const INT32_MIN = -(2 ** 31)
const INT32_MAX = 2 ** 31 - 1
const STANDARD_INTEGER = /^(?:0|-?[1-9][0-9]*)$/u

// gawk's is_integer(): a value whose number is a whole 32-bit value and
// whose text is spelt exactly as `%ld` would print it. A string not yet
// read as a number is judged by its text; an uninitialized value is no
// integer at all.
export function integerOf(v, key) {
  const n = typeof v === 'number' ? v : v instanceof StrNum ? v.number : undefined
  if (n !== undefined) {
    if (!Number.isInteger(n) || n < INT32_MIN || n > INT32_MAX) return null
    return typeof v === 'number' || STANDARD_INTEGER.test(key) ? n + 0 : null
  }
  if (typeof v !== 'string' && !(v instanceof StrNum)) return null
  if (!STANDARD_INTEGER.test(key)) return null
  const k = Number(key)
  return k >= INT32_MIN && k <= INT32_MAX ? k : null
}

export const subscript = (v, key) => ({ key, int: integerOf(v, key), v })

// Asking whether input text is an integer settles its type the way any
// numeric use does: gawk then holds it as a number, so a str table copies
// it as a plain string rather than as the input it came from.
export function isInteger(sub) {
  if (sub.int === null) return false
  if (sub.v instanceof StrNum) sub.v.number ??= sub.int
  return true
}

export const node = () => ({ type: null, size: 0, x: null, d: null })

export function reset(n) {
  n.type = null; n.size = 0; n.x = null; n.d = null
}

// `*symbol = *xn`: a table whose own part emptied becomes its xarray.
export function promote(n, xn) {
  n.type = xn.type; n.size = xn.size; n.x = xn.x; n.d = xn.d
}

// Arithmetic on an unsigned 32-bit register, as gawk's hashes do it.
const u32 = new Uint32Array(1)

// The next prime size; the old buckets, or true for a new table, or false
// once the largest size is reached.
function grow(d) {
  const old = d.buckets
  const newSize = SIZES.find((size) => size > d.arraySize)
  if (newSize === undefined) { d.maxed = true; return false }
  d.buckets = Array.from({ length: newSize }, () => null)
  d.arraySize = newSize
  return old === null ? true : old
}

// ---- str

// gawk's awk_hash (sdbm) over the subscript's UTF-8 bytes, each a signed
// char.
function strHash(s) {
  u32[0] = 0
  for (const ch of s) {
    const code = ch.codePointAt(0)
    if (code < 0x80) u32[0] = Math.imul(u32[0], 65599) + code
    else for (const byte of encodeUtf8Loose(ch)) u32[0] = Math.imul(u32[0], 65599) + byte - 256
  }
  return u32[0]
}

export function strLookup(n, sub) {
  if (n.d === null) {
    n.d = { buckets: null, arraySize: 0, maxed: false, names: new Map() }
    grow(n.d)
    n.size = 0
  }
  const { d } = n
  const found = d.names.get(sub.key)
  if (found !== undefined) return found
  n.size++
  const code = strHash(sub.key)
  if (!d.maxed && Math.floor(n.size / d.arraySize) > CHAIN_MAX) strGrow(d)
  const h = code % d.arraySize
  const entry = { value: undefined, name: sub.key, code, key: keyOf(sub), next: d.buckets[h] }
  d.buckets[h] = entry
  d.names.set(sub.key, entry)
  return entry
}

// What `for (k in a)` hands back for a str table's key. A number, an
// uninitialized value, or input text already read as a number is kept as a
// plain string — one that still converts to the number it was made from,
// where its text does not spell that — and other input keeps its input type
// (null here: a fresh numeric string each time).
function keyOf(sub) {
  const { v, key } = sub
  if (v instanceof StrNum) {
    if (v.numeric === false) return numberedString(key, v.number)
    return forcedNumeric(v) ? key : null
  }
  return typeof v === 'number' && Number(key) !== v ? numberedString(key, v) : key
}

function strGrow(d) {
  const old = grow(d)
  if (typeof old === 'boolean') return
  for (const head of old) {
    for (let e = head, next; e !== null; e = next) {
      next = e.next
      const h = e.code % d.arraySize
      e.next = d.buckets[h]
      d.buckets[h] = e
    }
  }
}

export const strExists = (n, sub) => (n.size === 0 ? undefined : n.d.names.get(sub.key))

export function strRemove(n, sub) {
  if (n.size === 0) return false
  const { d } = n
  const entry = d.names.get(sub.key)
  if (entry === undefined) return false
  const h = entry.code % d.arraySize
  if (d.buckets[h] === entry) d.buckets[h] = entry.next
  else {
    let prev = d.buckets[h]
    while (prev.next !== entry) prev = prev.next
    prev.next = entry.next
  }
  d.names.delete(sub.key)
  if (--n.size === 0) reset(n)
  return true
}

export function strList(n, out) {
  for (const head of n.d.buckets) {
    for (let e = head; e !== null; e = e.next) out.push(e.key ?? new StrNum(e.name))
  }
}

// ---- int

// The final mix of Paul Hsieh's SuperFastHash, on the value as a uint32.
function intHash(k, size) {
  u32[0] = k
  u32[0] ^= u32[0] << 3
  u32[0] += u32[0] >>> 5
  u32[0] ^= u32[0] << 4
  u32[0] += u32[0] >>> 17
  u32[0] ^= u32[0] << 25
  u32[0] += u32[0] >>> 6
  return u32[0] % size
}

function intFind(d, k) {
  for (let b = d.buckets[intHash(k, d.arraySize)]; b !== null; b = b.next) {
    if (b.nums[0] === k) return b.vals[0]
    if (b.count === 2 && b.nums[1] === k) return b.vals[1]
  }
}

// Only a chain's first bucket can have room; a full one gets a new head.
function intInsert(d, k, entry) {
  const h = intHash(k, d.arraySize)
  let b = d.buckets[h]
  if (b === null || b.count === 2) {
    b = { nums: [0, 0], vals: [null, null], count: 0, next: d.buckets[h] }
    d.buckets[h] = b
  }
  b.nums[b.count] = k
  b.vals[b.count++] = entry
  return entry
}

// What an int table cannot take goes to its xarray, which (taking only
// non-integers) is always a str table.
export function intLookup(n, sub) {
  if (!isInteger(sub)) {
    if (n.x === null) {
      n.x = node()
      n.x.type = 'str'
    } else {
      const found = strExists(n.x, sub)
      if (found !== undefined) return found
    }
    n.size++
    return strLookup(n.x, sub)
  }
  if (n.d === null) {
    n.d = { buckets: null, arraySize: 0, maxed: false }
    grow(n.d)
  }
  const { d } = n
  const found = intFind(d, sub.int)
  if (found !== undefined) return found
  n.size++
  const own = n.size - (n.x === null ? 0 : n.x.size)
  if (!d.maxed && Math.floor(own / d.arraySize) > CHAIN_MAX) intGrow(d)
  return intInsert(d, sub.int, { value: undefined })
}

function intGrow(d) {
  const old = grow(d)
  if (typeof old === 'boolean') return
  for (const head of old) {
    for (let b = head; b !== null; b = b.next) {
      for (let i = 0; i < b.count; i++) intInsert(d, b.nums[i], b.vals[i])
    }
  }
}

export function intExists(n, sub) {
  if (!isInteger(sub)) return n.x === null ? undefined : strExists(n.x, sub)
  return n.d === null ? undefined : intFind(n.d, sub.int)
}

export function intRemove(n, sub) {
  const xn = n.x
  if (n.size === 0 || n.d === null) return false
  if (!isInteger(sub)) {
    if (xn === null || !strRemove(xn, sub)) return false
    if (xn.size === 0) n.x = null
    n.size--
    return true
  }
  const k = sub.int
  const { d } = n
  const h = intHash(k, d.arraySize)
  let prev = null
  let b = d.buckets[h]
  for (; b !== null; prev = b, b = b.next) {
    if (b.nums[0] === k) {
      if (b.count === 2) { b.nums[0] = b.nums[1]; b.vals[0] = b.vals[1] }
      break
    }
    if (b.count === 2 && b.nums[1] === k) break
  }
  if (b === null) return false
  if (--b.count === 0) {
    if (prev === null) d.buckets[h] = b.next
    else prev.next = b.next
  } else if (b !== d.buckets[h]) {
    // Refill the bucket from the chain's head, the one bucket allowed a gap.
    const head = d.buckets[h]
    const i = --head.count
    b.nums[1] = head.nums[i]
    b.vals[1] = head.vals[i]
    b.count++
    if (i === 0) d.buckets[h] = head.next
  }
  n.size--
  if (xn === null && n.size === 0) reset(n)
  else if (xn !== null && n.size === xn.size) promote(n, xn)
  return true
}

export function intList(n, out) {
  if (n.x !== null) strList(n.x, out)
  for (const head of n.d.buckets) {
    for (let b = head; b !== null; b = b.next) {
      for (let i = 0; i < b.count; i++) out.push(String(b.nums[i]))
    }
  }
}
