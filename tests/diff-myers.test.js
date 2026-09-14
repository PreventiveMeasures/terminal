import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hrtime } from 'node:process'
import { DiffError, diffLines, sameLines, verifyChangeSet } from '../src/diff/myers.js'
import { lineKey, splitRecords } from '../src/diff/compare.js'
import { formatContext, formatNormal, formatUnified } from '../src/diff/format.js'

// The change set is the thing under test here, not its rendering: every
// change set diffLines returns has to reconstruct the second input, and
// when the inputs are small enough to check by other means, it also has to
// be as short as a change set can be.

// A small seeded generator (a 32-bit LCG), so a failing case can be replayed.
function random(seed) {
  let state = seed
  return () => {
    // Math.imul and >>> both read their operand as 32 bits; no masking needed.
    state = Math.imul(state, 1664525) + 1013904223
    return ((state >>> 8) & 0xFFFFFF) / 0x1000000
  }
}

// The textbook O(N·M) longest common subsequence, for cross-checking.
function lcsLength(a, b) {
  let previous = new Int32Array(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    const row = new Int32Array(b.length + 1)
    for (let j = 1; j <= b.length; j++) row[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], row[j - 1])
    previous = row
  }
  return previous[b.length]
}

const editCount = (blocks) => blocks.reduce((n, { a0, a1, b0, b1 }) => n + (a1 - a0) + (b1 - b0), 0)

// What patch would do with the change set: keep what is between the
// blocks, take each block's replacement from b.
function replay(a, b, blocks) {
  const out = []
  let ai = 0
  for (const { a0, a1, b0, b1 } of blocks) {
    out.push(...a.slice(ai, a0), ...b.slice(b0, b1))
    ai = a1
  }
  out.push(...a.slice(ai))
  return out
}

describe('diffLines returns a shortest change set that reconstructs the second input', () => {
  it('on thousands of small random inputs, with and without --minimal', () => {
    const next = random(20260914)
    for (let round = 0; round < 4000; round++) {
      const alphabet = 1 + Math.floor(next() * 4)
      const draw = () => Array.from({ length: Math.floor(next() * 14) }, () => String.fromCodePoint(97 + Math.floor(next() * alphabet)) + '\n')
      const a = draw(), b = draw()
      const blocks = diffLines(a, b, { minimal: next() < 0.5 })
      assert.deepEqual(replay(a, b, blocks), b, `round ${round}: ${JSON.stringify([a.join(''), b.join('')])}`)
      assert.equal(editCount(blocks), a.length + b.length - 2 * lcsLength(a, b), `round ${round}: not minimal`)
      for (let i = 1; i < blocks.length; i++) assert.ok(blocks[i].a0 > blocks[i - 1].a1 || blocks[i].b0 > blocks[i - 1].b1, `round ${round}: adjacent blocks were not merged`)
    }
  })

  it('handles the degenerate shapes', () => {
    assert.deepEqual(diffLines([], []), [])
    assert.deepEqual(diffLines(['a\n'], ['a\n']), [])
    assert.deepEqual(diffLines([], ['a\n', 'b\n']), [{ a0: 0, a1: 0, b0: 0, b1: 2 }])
    assert.deepEqual(diffLines(['a\n', 'b\n'], []), [{ a0: 0, a1: 2, b0: 0, b1: 0 }])
    assert.deepEqual(diffLines(['a\n'], ['b\n']), [{ a0: 0, a1: 1, b0: 0, b1: 1 }])
    assert.deepEqual(diffLines(['a\n'], ['a']), [{ a0: 0, a1: 1, b0: 0, b1: 1 }])
    assert.deepEqual(diffLines(['x\n', 'a\n', 'y\n'], ['a\n']), [{ a0: 0, a1: 1, b0: 0, b1: 0 }, { a0: 2, a1: 3, b0: 1, b1: 1 }])
  })

  it('compares under a key and verifies under the same key', () => {
    const key = lineKey({ ignoreCase: true, whitespace: 'all' })
    const a = splitRecords('Hello World\nsame\n'), b = splitRecords('hello   world\nsame\n')
    assert.deepEqual(diffLines(a, b, { key }), [])
    assert.ok(sameLines(a, b, key))
    assert.ok(!sameLines(a, b))
    const c = splitRecords('hello world\nchanged\n')
    assert.deepEqual(diffLines(a, c, { key }), [{ a0: 1, a1: 2, b0: 1, b1: 2 }])
  })

  it('past the cost limit still returns a change set that reconstructs the input', () => {
    const next = random(7)
    // Long inputs sharing little: the search gives up on minimality, never
    // on correctness.
    const a = Array.from({ length: 3000 }, () => `${Math.floor(next() * 100000)}\n`)
    const b = Array.from({ length: 3000 }, () => `${Math.floor(next() * 100000)}\n`)
    const blocks = diffLines(a, b)
    assert.deepEqual(replay(a, b, blocks), b)
    const minimal = diffLines(a, b, { minimal: true })
    assert.deepEqual(replay(a, b, minimal), b)
    assert.ok(editCount(minimal) <= editCount(blocks))
  })
})

describe('verifyChangeSet is the guarantee: a wrong change set is refused', () => {
  const a = splitRecords('a\nb\nc\n'), b = splitRecords('a\nX\nc\n')
  it('accepts the right one', () => {
    assert.doesNotThrow(() => verifyChangeSet(a, b, [{ a0: 1, a1: 2, b0: 1, b1: 2 }]))
  })
  for (const [name, blocks] of [
    ['a block that drops a line', [{ a0: 1, a1: 2, b0: 1, b1: 1 }]],
    ['a block that keeps a changed line', []],
    ['a block out of range', [{ a0: 1, a1: 2, b0: 1, b1: 4 }]],
    ['a block that changes nothing', [{ a0: 1, a1: 1, b0: 1, b1: 1 }]],
    ['blocks out of order', [{ a0: 2, a1: 3, b0: 2, b1: 3 }, { a0: 1, a1: 2, b0: 1, b1: 2 }]],
    ['kept runs of different lengths', [{ a0: 2, a1: 3, b0: 1, b1: 2 }]],
  ]) {
    it(`refuses ${name}`, () => assert.throws(() => verifyChangeSet(a, b, blocks), DiffError))
  }
})

describe('rendering a change set is GNU rendering, for every style', () => {
  const a = splitRecords('a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n'), b = splitRecords('a\nb\nX\nd\ne\nf\ng\nh\nY\nj\n')
  const blocks = diffLines(a, b)
  it('normal', () => assert.equal(formatNormal(a, b, blocks), '3c3\n< c\n---\n> X\n9c9\n< i\n---\n> Y\n'))
  it('unified merges hunks whose context would touch, and not otherwise', () => {
    assert.equal(formatUnified(a, b, blocks, { context: 3, header: '', fn: null }), '@@ -1,10 +1,10 @@\n a\n b\n-c\n+X\n d\n e\n f\n g\n h\n-i\n+Y\n j\n')
    assert.equal(formatUnified(a, b, blocks, { context: 1, header: '', fn: null }), '@@ -2,3 +2,3 @@\n b\n-c\n+X\n d\n@@ -8,3 +8,3 @@\n h\n-i\n+Y\n j\n')
    assert.equal(formatUnified(a, b, blocks, { context: 0, header: '', fn: null }), '@@ -3 +3 @@\n-c\n+X\n@@ -9 +9 @@\n-i\n+Y\n')
  })
  it('context marks a change with ! and leaves out a side with nothing of its own', () => {
    const ins = splitRecords('a\nb\nc\nNEW\nd\ne\nf\ng\nh\ni\nj\n')
    assert.equal(formatContext(a, ins, diffLines(a, ins), { context: 3, header: '', fn: null }), '***************\n*** 1,6 ****\n--- 1,7 ----\n  a\n  b\n  c\n+ NEW\n  d\n  e\n  f\n')
    assert.equal(formatContext(a, b, blocks, { context: 1, header: '', fn: null }), '***************\n*** 2,4 ****\n  b\n! c\n  d\n--- 2,4 ----\n  b\n! X\n  d\n***************\n*** 8,10 ****\n  h\n! i\n  j\n--- 8,10 ----\n  h\n! Y\n  j\n')
  })
  it('says when a last line has no newline', () => {
    const x = splitRecords('a\n'), y = splitRecords('a')
    assert.equal(formatNormal(x, y, diffLines(x, y)), '1c1\n< a\n---\n> a\n\\ No newline at end of file\n')
    assert.equal(formatUnified(y, x, diffLines(y, x), { context: 3, header: '', fn: null }), '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n')
  })
})

describe('the search stays fast', () => {
  const budget = (label, fn, ms) => {
    const started = hrtime.bigint()
    fn()
    const took = Number(hrtime.bigint() - started) / 1e6
    assert.ok(took < ms, `${label}: took ${took.toFixed(0)}ms, budget ${ms}ms`)
  }
  it('two hundred thousand mostly shared lines', () => {
    const a = Array.from({ length: 200000 }, (_, i) => `line ${i}\n`)
    const b = a.map((line, i) => i % 97 === 0 ? `changed ${i}\n` : line)
    b.splice(50000, 0, 'inserted\n')
    budget('200k lines', () => assert.deepEqual(replay(a, b, diffLines(a, b)), b), 3000)
  })
  it('twenty thousand lines sharing nothing', () => {
    const a = Array.from({ length: 20000 }, (_, i) => `left ${i}\n`)
    const b = Array.from({ length: 20000 }, (_, i) => `right ${i}\n`)
    budget('disjoint', () => assert.deepEqual(diffLines(a, b), [{ a0: 0, a1: 20000, b0: 0, b1: 20000 }]), 3000)
  })
  it('fifty thousand lines over a small alphabet', () => {
    const a = Array.from({ length: 50000 }, (_, i) => `${i % 7}\n`)
    const b = Array.from({ length: 50000 }, (_, i) => `${(i * 3) % 7}\n`)
    budget('small alphabet', () => assert.deepEqual(replay(a, b, diffLines(a, b)), b), 3000)
  })
})
