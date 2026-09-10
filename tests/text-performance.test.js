import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

function check(command, input, stdout) {
  assert.deepEqual(createTerminal({ input }).run(command), {
    stdout, stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [],
  }, command)
}

describe('text processing preserves record and byte semantics', () => {
  it('head and tail preserve blank records, final terminators, and shared stdin offsets', () => {
    for (const [command, input, stdout] of [
      ['head -n1 input', '\nlast', '\n'],
      ['tail -n1 input', 'first\n\n', '\n'],
      ['head -n-1 input', 'first\n\n', 'first\n'],
      ['tail -n+2 input', 'first\n\n', '\n'],
      ['tail -n1 input', 'first\nlast', 'last'],
      ['head -n-1 input', 'first\nlast', 'first\n'],
      ['head -n-0 input', 'first\nlast', 'first\nlast'],
      ['tail -n+0 input', 'first\nlast', 'first\nlast'],
      ['tail -n2 input', '\n', '\n'],
      ['head -n-2 input', '\n', ''],
      ['head -n999999999999999999 input', '', ''],
      ['tail -n999999999999999999 input', '\n', '\n'],
      ['{ head -n1; head -n1; cat; } < input', 'first\n\nlast', 'first\n\nlast'],
    ]) check(command, input, stdout)
  })

  it('wc keeps byte-based column widths when counting characters and lines', () => {
    const input = '😀é\n\uD800\n'
    check('wc -l input', input, '2 input\n')
    check('wc -m input', input, '5 input\n')
    check('wc -c input', input, '11 input\n')
    check('LC_ALL=C wc -m input', input, '11 input\n')
    check('wc -lm input input', input, ' 2  5 input\n 2  5 input\n 4 10 total\n')
    check('wc -lc input input', input, ' 2 11 input\n 2 11 input\n 4 22 total\n')
  })

  it('uniq compares UTF-8 replacement bytes and folds only ASCII', () => {
    const input = 'A\uD800\nA\uFFFD\nA\uDFFF\na\uFFFD\n'
    check('uniq -c input', input, '      3 A\uD800\n      1 a\uFFFD\n')
    check('uniq -ic input', input, '      4 A\uD800\n')
    check('uniq -s1 input', input, 'A\uD800\n')
    check('uniq -i input', 'K\nK\nk\n', 'K\nK\nk\n')
  })
})
