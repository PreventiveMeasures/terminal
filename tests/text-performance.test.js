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
    // A surrogate half spelled in UTF-8's shape is three bytes and no
    // character, as GNU wc 9.4 counts it.
    const input = Uint8Array.of(0xf0, 0x9f, 0x98, 0x80, 0xc3, 0xa9, 0x0a, 0xed, 0xa0, 0x80, 0x0a)
    await check('wc -l input', input, '2 input\n')
    await check('wc -m input', input, '4 input\n')
    await check('wc -c input', input, '11 input\n')
    await check('wc -lm input input', input, ' 2  4 input\n 2  4 input\n 4  8 total\n')
    await check('wc -lc input input', input, ' 2 11 input\n 2 11 input\n 4 22 total\n')
  })

  it('uniq compares UTF-8 replacement bytes and folds only ASCII', async () => {
    // No file holds a lone surrogate, which has no bytes; the command line can.
    const piped = (command) => `echo -n 'A\uD800\nA\uFFFD\nA\uDFFF\na\uFFFD\n' | ${command}`
    await check(piped('uniq -c'), '', '      3 A\uD800\n      1 a\uFFFD\n')
    await check(piped('uniq -ic'), '', '      4 A\uD800\n')
    await check(piped('uniq -s1'), '', 'A\uD800\n')
    await check('uniq -i input', 'K\nK\nk\n', 'K\nK\nk\n')
  })
})
