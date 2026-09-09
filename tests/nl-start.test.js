import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = { source: 'first\n\nlast\n', other: 'more\n', partial: 'tail', empty: '', pages: 'before\n\\:\nnext\n' }
const run = (command) => createTerminal(FILES).run(command)

function check(command, stdout) {
  const result = run(command)
  assert.deepEqual([result.stdout, result.stderr, result.exitCode, result.unsupported], [stdout, '', 0, []], command)
}

describe('nl starting line numbers', () => {
  const numbered = '    45\tfirst\n    46\t\n    47\tlast\n'
  for (const command of [
    'nl -ba -v45 source', 'nl -b a -v 45 source', 'nl -v45 -ba source',
    'nl source -ba -v45', 'nl -ba --starting-line-number=45 source',
    'nl -ba --starting-line-number 45 source', 'cat source | nl -ba -v45',
    'nl -ba -v45 < source', 'cat source | nl -ba -v45 -',
  ]) {
    it(command + ' numbers every line, including blanks', () => check(command, numbered))
  }

  it('numbers a selected source slice from its original line', () => {
    check("sed -n '2,3p' source | nl -ba -v45", '    45\t\n    46\tlast\n')
  })

  it('keeps numbering continuous across file and stdin operands', () => {
    check('nl -ba -v45 source partial', numbered + '    48\ttail\n')
    check('cat source | nl -ba -v45 other - partial', '    45\tmore\n    46\tfirst\n    47\t\n    48\tlast\n    49\ttail\n')
  })

  it('increments only lines selected by the numbering style', () => {
    check('nl -v45 source', '    45\tfirst\n       \n    46\tlast\n')
    check('nl -bn -v45 source', '       first\n       \n       last\n')
    check('nl -ba -v45 empty', '')
  })

  it('accepts zero, signed decimal values, and leading zeroes', () => {
    check('nl -ba -v0 source', '     0\tfirst\n     1\t\n     2\tlast\n')
    check('nl -ba -v-1 source', '    -1\tfirst\n     0\t\n     1\tlast\n')
    check('nl -ba -v+0045 source', numbered)
  })

  it('honors the last starting number across short and long spellings', () => {
    check('nl -ba -v1 --starting-line-number=45 source', numbered)
    check('nl -ba --starting-line-number=1 -v45 source', numbered)
  })

  it('preserves integers beyond JavaScript safe precision', () => {
    check('nl -ba -v9007199254740992 source', '9007199254740992\tfirst\n9007199254740993\t\n9007199254740994\tlast\n')
    check('nl -v-9223372036854775808 other', '-9223372036854775808\tmore\n')
    check('nl -v9223372036854775807 other', '9223372036854775807\tmore\n')
  })

  it('reports overflow when another numbered line is required', () => {
    const result = run('nl -ba -v9223372036854775807 source')
    assert.deepEqual([result.stdout, result.stderr, result.exitCode, result.unsupported], ['9223372036854775807\tfirst\n', 'nl: line number overflow\n', 1, []])
    check('nl -bn -v9223372036854775807 source', '       first\n       \n       last\n')
  })

  for (const args of ['-v', '-vnope', '-v1.5', '-v0x10', "-v ''", '-v9223372036854775808', '-v-9223372036854775809', '-vbad -v45']) {
    it(args + ' rejects invalid starting numbers without consuming stdin', () => {
      const result = run(`{ nl -ba ${args}; cat; } < source`)
      assert.equal(result.stdout, FILES.source)
      assert.notEqual(result.stderr, '')
      assert.deepEqual(result.unsupported, [])
    })
  }

  it('retains read errors and output from readable operands', () => {
    const result = run('nl -ba -v45 missing source')
    assert.equal(result.stdout, numbered)
    assert.notEqual(result.stderr, '')
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.unsupported, [])
  })

  for (const [command, detail] of [['nl -ba -v45 -i2 source', '-i'], ['nl -ba -v45 pages', 'logical pages']]) {
    it(command + ' retains unsupported diagnostics through a pipeline', () => {
      const direct = run(command)
      const hidden = run(command + ' 2>/dev/null | head')
      assert.notEqual(direct.exitCode, 0)
      assert.notEqual(direct.stderr, '')
      assert.deepEqual(direct.unsupported.map((note) => [note.command, note.detail]), [['nl', detail]])
      assert.deepEqual(hidden.unsupported, direct.unsupported)
      assert.equal(hidden.stderr, '')
    })
  }
})
