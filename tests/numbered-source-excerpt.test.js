import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const pipeline = String.raw`sed -n 700,880p in.txt | cat -n | sed 's/^/  /' | awk '{printf "%d: %s\n", NR+699, substr($0, index($0,$2))}' | head -5`
const direct = String.raw`awk 'NR>=700 && NR<=880 {printf "%d: %s\n", NR, $0}`
const expected = (stdout, notes = []) => ({ stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [], notes })
const previewNotes = ['head: selected 5 of 181 lines from standard input.']

function terminal(excerpt) {
  const lines = Array.from({ length: 900 }, (_, index) => `source line ${index + 1}`)
  if (excerpt) lines.splice(699, excerpt.length, ...excerpt)
  return createTerminal({ 'in.txt': lines.join('\n') + '\n' })
}

describe('numbered source excerpt from reported command', () => {
  it('rejects the pasted unterminated quote before executing the semicolon list', () => {
    const result = terminal().run(pipeline + '; echo "---"; ' + direct)
    assert.deepEqual(result, { ...expected(''), stderr: 'error: unterminated single quote\n', exitCode: 2 })
  })

  it('runs both completed commands with the expected source line numbers', () => {
    const command = pipeline + '; echo "---"; ' + direct + "' in.txt | head -5"
    const excerpt = Array.from({ length: 5 }, (_, index) => `${index + 700}: source line ${index + 700}\n`).join('')
    assert.deepEqual(terminal().run(command), expected(excerpt + '---\n' + excerpt, previewNotes))
  })

  it('keeps native index semantics when the search also matches the added number', () => {
    const t = terminal(['alpha', '2 second', '', '  indented', 'plain'])
    assert.deepEqual(t.run(pipeline), expected('700: alpha\n701: 2\t2 second\n702:        3\t\n703: indented\n704: plain\n', previewNotes))
  })

  it('preserves blank lines and indentation when awk reads the original file', () => {
    const t = terminal(['alpha', '2 second', '', '  indented', 'plain'])
    assert.deepEqual(t.run(direct + "' in.txt | head -5"), expected('700: alpha\n701: 2 second\n702: \n703:   indented\n704: plain\n', previewNotes))
  })
})
