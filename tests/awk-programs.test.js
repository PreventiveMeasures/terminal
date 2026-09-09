// Whole programs exercise interactions between arrays, functions, input,
// and control flow. AWK_SLOW_TESTS=1 adds the sizes that stay expensive:
// a 400000-key sieve, and the two programs that run into the step budget
// — those cost what MAX_STEPS costs, so no optimisation shortens them,
// and the limit itself is already covered by default in terminal.test.js.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { env } from 'node:process'

import { AWK_FILES } from './fixtures/awk-programs.js'
import { createTerminal } from '@preventive/terminal'

const SLOW = { skip: env.AWK_SLOW_TESTS === '1' ? false : 'set AWK_SLOW_TESTS=1, or run `pnpm test:slow` (~2.4s)' }

// The virtual FS is read-only and each awk invocation gets its own
// machine, so one terminal serves every case.
const t = createTerminal(AWK_FILES)

function out(line) {
  const r = t.run(line)
  assert.equal(r.stderr, '', line)
  assert.equal(r.exitCode, 0, line)
  return r.stdout
}

describe('awk runs whole programs', () => {
  it('simulates a Turing machine, tape and transition table both as arrays', () => {
    // The busy beavers are the reference values: BB(3) writes 6 ones in
    // 14 steps, BB(4) writes 13 in 107. Getting either wrong means the
    // interpreter, not the program, is broken.
    assert.equal(out('awk -v name=BB3 -v limit=1000 -f tm.awk bb3.tm'), 'BB3: halted=yes steps=14 ones=6 tape=111111\n')
    assert.equal(out('awk -v name=BB4 -v limit=1000 -f tm.awk bb4.tm'), 'BB4: halted=yes steps=107 ones=13 tape=10111111111111\n')
  })

  it('runs a machine that never halts up to the bound the caller set', () => {
    // One tape cell written per step, so this also pins that an array
    // keyed by ever-larger subscripts stays addressable as it grows. The
    // rendered tape spans lo..hi, and hi is where the head stopped — one
    // cell past the last write, still unwritten, hence the trailing 0.
    assert.equal(out('awk -v name=SPIN -v limit=400 -f tm.awk spin.tm'), `SPIN: halted=no steps=400 ones=400 tape=${'1'.repeat(400)}0\n`)
  })

  it('interprets brainfuck, with the program as an operand and as stdin', () => {
    const fromFile = t.run('awk -f bf.awk hello.bf')
    assert.equal(fromFile.stdout, 'Hello World!\n')
    assert.equal(fromFile.exitCode, 0)
    // The op count goes to `> "/dev/stderr"` from inside a function.
    assert.equal(fromFile.stderr, '[906 brainfuck ops, 7 tape cells touched]\n')
    const piped = t.run('cat hello.bf | awk -f bf.awk')
    assert.equal(piped.stdout, 'Hello World!\n')
    assert.equal(piped.stderr, fromFile.stderr)
  })

  it('reports a malformed brainfuck program by position, and exits from inside a function', () => {
    for (const [program, message] of [['+[+', 'unmatched [ at 2\n'], ['+]', 'unmatched ] at 2\n']]) {
      const r = t.run(`echo '${program}' | awk -f bf.awk`)
      assert.equal(r.exitCode, 2, program)
      assert.equal(r.stdout, '', program)
      assert.equal(r.stderr, message, program)
    }
  })

  it('solves n-queens by recursive backtracking', () => {
    assert.equal(out('awk -v N=8 -f queens.awk'), [
      '4-queens: 2 solutions',
      '5-queens: 10 solutions',
      '6-queens: 4 solutions',
      '7-queens: 40 solutions',
      '8-queens: 92 solutions',
      '',
    ].join('\n'))
  })

  it('sieves primes into an array', () => {
    assert.equal(out('awk -v N=10000 -f sieve.awk'), 'primes below 10000: 1229 (largest 9973)\n')
  })

  it('produces a report: getline lookups, captures, 2-D subscripts, gensub, switch, a hand-written sort', () => {
    // Counts that tie keep insertion order (the three 1-hit status codes
    // below), which is this implementation's documented iteration order
    // where gawk leaves it unspecified.
    assert.equal(out('awk -v owners=owners.txt -f report.awk access.log'), [
      'SERVICE  ROUTE      CANONICAL                        HITS     BYTES    SHARE  OWNER',
      'api      users      /api/v2/users/{id}?full=1           3      1.9K    37.5%  platform-team',
      'api      orders     /api/v2/orders/{id}?full=1          2      2.4K    25.0%  platform-team',
      'static   assets     /static/v1/assets/{id}?full=1       2    390.6K    25.0%  cdn-team',
      'api      search     /api/v2/search/{id}?full=1          1      300B    12.5%  platform-team',
      '',
      '8 requests, 1 unparsed; api: 2 5xx / 1 4xx / 3 ok  ',
      'status codes: 200=5 404=1 503=1 500=1 ',
      '',
    ].join('\n'))
  })

  // Scale, at a size the default run can afford: ten queens recurses
  // deeper and deletes more, and the sieve grows an array past 100000
  // keys. Both were gated when they cost 292ms and 307ms; they are now
  // 235ms and 127ms together with the rest of this suite.
  it('solves ten queens by recursive backtracking', () => {
    assert.match(out('awk -v N=10 -f queens.awk'), /\n10-queens: 724 solutions\n$/u)
  })

  it('sieves primes below 100000', () => {
    assert.equal(out('awk -v N=100000 -f sieve.awk'), 'primes below 100000: 9592 (largest 99991)\n')
  })
})

describe('awk runs whole programs — heavier sizes', SLOW, () => {
  it('sieves primes below 400000', () => {
    assert.equal(out('awk -v N=400000 -f sieve.awk'), 'primes below 400000: 33860 (largest 399989)\n')
  })

  it('stops a program that outgrows the step budget, keeping what it already printed', () => {
    const r = t.run('awk -v N=11 -f queens.awk')
    assert.equal(r.exitCode, 2)
    // Everything computed before the budget ran out is still delivered.
    assert.match(r.stdout, /^4-queens: 2 solutions\n/u)
    assert.match(r.stdout, /\n10-queens: 724 solutions\n$/u)
    assert.match(r.stderr, /execution stopped after 5000000 statements/u)
    assert.deepEqual(r.unsupported.map((u) => u.detail), ['execution limit'])
  })

  it('bounds a non-halting machine rather than deciding it', () => {
    // Whether `spin.tm` halts is not answerable from its text, so the
    // step budget is what ends it — with the diagnostic on the same
    // channel a caller uses for every other unsupported form.
    const r = t.run('awk -v name=RUNAWAY -v limit=99999999 -f tm.awk spin.tm')
    assert.equal(r.exitCode, 2)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /execution stopped after 5000000 statements/u)
    assert.deepEqual(r.unsupported.map((u) => u.kind), ['feature'])
  })
})
