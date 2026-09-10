import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Bash preserves unrecognized escapes; %b follows echo -e's escape rules.
// https://www.gnu.org/software/bash/manual/html_node/Bash-Builtins.html
describe('Unicode boundaries in echo and printf escapes', () => {
  const cases = [
    [String.raw`echo -e '\😀'`, '\\😀\n'],
    [String.raw`echo -en 'a\😀b\🧪c'`, 'a\\😀b\\🧪c'],
    [String.raw`echo -e '😀\😀😀\n🧪\🧪🧪'`, '😀\\😀😀\n🧪\\🧪🧪\n'],
    [String.raw`echo -e '\😀\cdiscarded'`, '\\😀'],
    [String.raw`printf '\😀'`, '\\😀'],
    [String.raw`printf 'a\😀%sb\🧪' x`, 'a\\😀xb\\🧪'],
    [String.raw`printf '%b' '\😀'`, '\\😀'],
    [String.raw`printf '%b\n' '\😀' '\🧪'`, '\\😀\n\\🧪\n'],
    [String.raw`printf '%b' '😀\😀😀'`, '😀\\😀😀'],
    [String.raw`printf '%b' '\😀\cdiscarded'`, '\\😀'],
    [String.raw`printf '[%7b]' '\😀'`, '[  \\😀]'],
    [String.raw`printf '[%.5b]' '\😀x'`, '[\\😀]'],
    [String.raw`printf '%b' '\é\😀\n'`, '\\é\\😀\n'],
  ]
  for (const [command, stdout] of cases) {
    it(command, () => assert.deepEqual(createTerminal().run(command), { stdout, stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [] }))
  }

  it('still diagnoses precision that splits a multibyte character', () => {
    const command = String.raw`printf '%.4b' '\😀'`
    const r = createTerminal().run(command)
    assert.equal(r.stdout, '')
    assert.notEqual(r.exitCode, 0)
    assert.ok(r.unsupported.some((note) => note.detail === 'partial UTF-8 byte sequence'))
    const hidden = createTerminal().run(`${command} 2>/dev/null | true`)
    assert.equal(hidden.stderr, '')
    assert.deepEqual(hidden.unsupported, r.unsupported)
  })
})
