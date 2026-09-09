import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createTerminal } from '@preventive/terminal'

function output(files, command) {
  const result = createTerminal(files).run(command)
  assert.equal(result.exitCode, 0)
  assert.equal(result.stderr, '')
  assert.deepEqual(result.unsupported, [])
  return result.stdout
}

describe('awk repeated value conversions', () => {
  it('keeps numeric classification separate from prefix conversion and original text', () => {
    const values = [
      ['', 'string', 0, 0, 1],
      [' ', 'string', 1, 0, 1],
      ['0', 'strnum', 0, 0, 1],
      ['-0', 'strnum', 0, 0, 1],
      ['  4 ', 'strnum', 1, 4, 0],
      ['0x10', 'string', 1, 0, 1],
      ['10tail', 'string', 1, 10, 1],
      ['3x', 'string', 1, 3, 0],
      ['1e', 'string', 1, 1, 1],
      ['1e2tail', 'string', 1, 100, 1],
      ['1e2', 'strnum', 1, 100, 0],
      ['nan', 'string', 1, 0, 0],
    ]
    const input = values.map(([text]) => text).join('\n') + '\n'
    const expected = values.map(([text, type, truth, number, less]) => `${type}|${truth}|${number}|${less}|<${text}>\n`.repeat(3)).join('')
    assert.equal(output({ input }, String.raw`awk '{ x=$0; for (i=0; i<3; i++) { n=x+0; printf "%s|%d|%d|%d|<%s>\n", typeof(x), !!x, n, x<2, x } }' input`), expected)
  })

  it('refreshes conversions after assignments and keeps scalar copies independent', () => {
    const command = String.raw`awk -v x=10 'BEGIN {
      y=x
      for (i=0; i<3; i++) print x+0, x<9, typeof(x)
      x="10"
      for (i=0; i<3; i++) print x+0, x<9, typeof(x), y<9, typeof(y)
      split("3 0 12tail", a)
      for (i=1; i<=3; i++) {
        x=a[i]
        for (j=0; j<2; j++) print x+0, !!x, x<9, typeof(x)
      }
    }'`
    assert.equal(output({}, command), '10 0 strnum\n'.repeat(3) + '10 1 string 0 strnum\n'.repeat(3)
      + '3 1 1 strnum\n'.repeat(2) + '0 0 1 strnum\n'.repeat(2) + '12 1 1 string\n'.repeat(2))
  })

  it('retains unordered comparisons and diagnostics after repeated NaN coercion', () => {
    const command = String.raw`awk -v x=+nan 'BEGIN {
      for (i=0; i<3; i++) { n=x+0; print typeof(x), x==x, x!=x, n==n, n!=n }
      print x+0
    }' 2>/dev/null`
    const result = createTerminal({}).run(command)
    assert.equal(result.stdout, 'strnum 0 1 0 1\n'.repeat(3))
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 2)
    assert.deepEqual(result.unsupported.map(({ detail }) => detail), ['signed NaN'])
  })
})
