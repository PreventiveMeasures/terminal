import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { AwkRegex } from '../src/awk/regex.js'

// gawk reads a regex a byte at a time, so a backslash before a character
// outside ASCII escapes only that character's first byte. It warns about the
// escape — "regexp escape sequence `\<byte>' is not a known regexp operator",
// naming that lone byte — and then matches as if the backslash were not there.
// These cases used to match silently with no warning at all; the warning
// gawk prints is not valid UTF-8, which this string-based terminal cannot
// write, so the escape is refused by name instead. Recorded from GNU Awk
// 5.2.1, where the same programs without the backslash print exactly what
// they print here.
describe('awk escaped Unicode characters', () => {
  const cases = [
    [String.raw`awk '/[\😀]/ { print }' input`, '😀\n😃\nplain\n', '😀\n', 1],
    [String.raw`awk '/^[\😀-\😃]$/ { print }' input`, '😀\n😃\nplain\n', '😀\n😃\n', 1],
    [String.raw`awk '/^[^\😀]$/ { print }' input`, '😀\n😃\nx\n', '😃\nx\n', 1],
    [String.raw`awk '{ gsub(/[\😀]+/, "X"); print }' input`, 'a😀😀b😀c\n', 'aXbXc\n', 1],
    [String.raw`awk '{ print match($0, /[\😀]+/), RSTART, RLENGTH }' input`, 'a😀😀b\n', '2 2 2\n', 1],
    [String.raw`awk -F '[\\😀]' '{ print NF, $1, $2, $3 }' input`, 'oak😀elm😀fir\n', '3 oak elm fir\n', 2],
    [String.raw`awk 'BEGIN { print split("a😀b", a, /[\😀]/), a[1], a[2] }'`, '', '2 a b\n', 1],
  ]
  for (const [command, input, stdout, exitCode] of cases) {
    it(command, async () => {
      const r = await createTerminal({ input }).run(command)
      assert.deepEqual([r.stdout, r.stderr, r.exitCode], ['', 'awk: non-ASCII characters after a regex escape are not supported\n', exitCode])
      assert.deepEqual(r.unsupported.map((u) => u.detail), ['non-ASCII regex escape'])
      const plain = await createTerminal({ input }).run(command.replaceAll(/\\+(?=\p{Extended_Pictographic})/gu, ''))
      assert.deepEqual(plain, { stdout, stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [] })
    })
  }

  it('refuses the escape outside brackets too, and in the regex engine itself', () => {
    assert.throws(() => new AwkRegex(String.raw`^\🧪+$`, false, () => {}), { message: 'non-ASCII characters after a regex escape are not supported' })
    const re = new AwkRegex('^🧪+$', false, () => {})
    assert.equal(re.test('🧪🧪'), true)
    assert.equal(re.test('🧪x'), false)
    assert.deepEqual(re.search('🧪🧪'), { start: 0, end: 4 })
  })
})
