import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { AwkRegex } from '../src/awk/regex.js'

// GNU awk treats an otherwise unrecognized escaped character literally:
// https://www.gnu.org/software/gawk/manual/html_node/Escape-Sequences.html
// That character can occupy two UTF-16 units in this implementation.
describe('awk escaped Unicode characters', () => {
  const cases = [
    [String.raw`awk '/[\😀]/ { print }' input`, '😀\n😃\nplain\n', '😀\n'],
    [String.raw`awk '/^[\😀-\😃]$/ { print }' input`, '😀\n😃\nplain\n', '😀\n😃\n'],
    [String.raw`awk '/^[^\😀]$/ { print }' input`, '😀\n😃\nx\n', '😃\nx\n'],
    [String.raw`awk '{ gsub(/[\😀]+/, "X"); print }' input`, 'a😀😀b😀c\n', 'aXbXc\n'],
    [String.raw`awk '{ print match($0, /[\😀]+/), RSTART, RLENGTH }' input`, 'a😀😀b\n', '2 2 2\n'],
    [String.raw`awk -F '[\\😀]' '{ print NF, $1, $2, $3 }' input`, 'oak😀elm😀fir\n', '3 oak elm fir\n'],
    [String.raw`awk 'BEGIN { print split("a😀b", a, /[\😀]/), a[1], a[2] }'`, '', '2 a b\n'],
  ]
  for (const [command, input, stdout] of cases) {
    it(command, () => {
      assert.deepEqual(createTerminal({ input }).run(command), { stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [] })
    })
  }

  it('keeps escaped non-bracket characters whole in matching and warnings', () => {
    const warnings = []
    const re = new AwkRegex(String.raw`^\🧪+$`, false, (message) => warnings.push(message))
    assert.equal(re.test('🧪🧪'), true)
    assert.equal(re.test('🧪x'), false)
    assert.deepEqual(re.search('🧪🧪'), { start: 0, end: 4 })
    assert.deepEqual(warnings, ["regexp escape sequence `\\🧪' is not a known regexp operator"])
  })
})
