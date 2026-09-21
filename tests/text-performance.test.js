import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

async function check(command, input, stdout, notes = []) {
  assert.deepEqual(await createTerminal({ input }).run(command), {
    stdout, stderr: '', exitCode: 0, cwd: '/', notes, unsupported: [],
  }, command)
}

describe('text processing preserves record and byte semantics', () => {
  it('head and tail preserve blank records, final terminators, and shared stdin offsets', async () => {
    for (const [command, input, stdout, notes] of [
      ['head -n1 input', '\nlast', '\n', ['head: selected 1 of 2 lines from "/input".']],
      ['tail -n1 input', 'first\n\n', '\n', ['tail: selected 1 of 2 lines from "/input".']],
      ['head -n-1 input', 'first\n\n', 'first\n', ['head: selected 1 of 2 lines from "/input".']],
      ['tail -n+2 input', 'first\n\n', '\n', ['tail: selected 1 of 2 lines from "/input".']],
      ['tail -n1 input', 'first\nlast', 'last', ['tail: selected 1 of 2 lines from "/input".']],
      ['head -n-1 input', 'first\nlast', 'first\n', ['head: selected 1 of 2 lines from "/input".']],
      ['head -n-0 input', 'first\nlast', 'first\nlast'],
      ['tail -n+0 input', 'first\nlast', 'first\nlast'],
      ['tail -n2 input', '\n', '\n'],
      ['head -n-2 input', '\n', '', ['head: selected 0 of 1 line from "/input".']],
      ['head -n999999999999999999 input', '', ''],
      ['tail -n999999999999999999 input', '\n', '\n'],
      ['{ head -n1; head -n1; cat; } < input', 'first\n\nlast', 'first\n\nlast', [
        'head: selected 1 of 3 lines from standard input.', 'head: selected 1 of 2 lines from standard input.',
      ]],
    ]) await check(command, input, stdout, notes)
  })

  it('wc keeps byte-based column widths when counting characters and lines', async () => {
    const input = '😀é\n\uD800\n'
    await check('wc -l input', input, '2 input\n')
    await check('wc -m input', input, '5 input\n')
    await check('wc -c input', input, '11 input\n')
    await check('wc -lm input input', input, ' 2  5 input\n 2  5 input\n 4 10 total\n')
    await check('wc -lc input input', input, ' 2 11 input\n 2 11 input\n 4 22 total\n')
  })

  it('uniq compares UTF-8 replacement bytes and folds only ASCII', async () => {
    const input = 'A\uD800\nA\uFFFD\nA\uDFFF\na\uFFFD\n'
    await check('uniq -c input', input, '      3 A\uD800\n      1 a\uFFFD\n')
    await check('uniq -ic input', input, '      4 A\uD800\n')
    await check('uniq -s1 input', input, 'A\uD800\n')
    await check('uniq -i input', 'K\nK\nk\n', 'K\nK\nk\n')
  })
})
