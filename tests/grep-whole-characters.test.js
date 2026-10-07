import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU grep reads a character whole, wherever it sits; every answer here is
// what GNU grep 3.11 gave in C.UTF-8 over the same text.
const FILES = {
  letter: '\u{10080}\n',
  word: 'a\u{10080}b\n',
  emoji: 'x\u{1F600}y\n',
  times: 'x×y\n',
  accent: 'xéy\n',
  space: 'x y\n',
}

async function check(command, stdout, exitCode = 0) {
  assert.deepEqual(await createTerminal(FILES).run(command), { stdout, stderr: '', exitCode, cwd: '/', notes: [], unsupported: [] }, command)
}

describe('grep reads a character past U+FFFF whole', () => {
  it('finds no word edge, and no empty match, between its two halves', async () => {
    // U+10080 is a letter, so a line of it alone has edges at both ends and
    // none inside; an emoji is no word character, and neither has any either.
    await check(String.raw`grep -c '\B' letter`, '0\n', 1)
    await check(String.raw`grep -c '\b' letter`, '1\n')
    await check(String.raw`grep -c '\B' emoji`, '0\n', 1)
    await check("grep -cw 'x*' word", '0\n', 1)
    await check("grep -cw '' letter", '0\n', 1)
    await check(String.raw`grep -c '\Wb' word`, '0\n', 1)
  })

  it('answers -w as ever where no empty match is asked for', async () => {
    await check("grep -cw '' accent", '0\n', 1)
    await check("grep -cw 'x*' space", '1\n')
    await check('grep -cw x emoji', '1\n')
  })

  it('refuses -w with a pattern that can match nothing over text that is no word characters past ASCII', async () => {
    // GNU reads the line a byte at a time there and takes an empty match from
    // inside such a character, which a matcher reading characters whole cannot
    // stand in: it selects both lines below.
    const message = 'grep: -w with a pattern that can match nothing, over non-ASCII text that is not word characters, is not supported'
    for (const command of ["grep -cw '' emoji", "grep -cw 'x*' times"]) {
      const result = await createTerminal(FILES).run(command)
      assert.deepEqual([result.stdout, result.exitCode, result.unsupported], ['', 2, [{ kind: 'feature', command: 'grep', detail: 'empty word match', message }]], command)
    }
  })
})

describe('awk reads a character past U+FFFF whole', () => {
  it('tests a line as its own match extent reads it', async () => {
    // U+10080 is a letter: a line of it alone has word edges at both ends and
    // none inside, so `\B` selects no line, as gsub finds no place for it.
    await check(String.raw`awk '/\B/ { n++ } END { print n + 0 }' letter`, '0\n')
    await check(String.raw`awk '{ print gsub(/\B/, "-") }' letter`, '0\n')
    await check(String.raw`awk '/\y/ { n++ } END { print n + 0 }' letter`, '1\n')
  })
})
