import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const files = {
  empty: '', blank: '\n', blanks: '\n\n', terminated: 'hit\n',
  trailing: 'hit\n\n', unterminated: 'hit', leading: '\nhit',
}

function check(command, stdout, exitCode = 0) {
  assert.deepEqual(createTerminal(files).run(command), {
    stdout, stderr: '', exitCode, cwd: '/', unsupported: [],
  }, command)
}

describe('grep line scanning', () => {
  it('counts and lists real empty lines without inventing one after a final newline', () => {
    const operands = 'empty blank blanks terminated trailing unterminated leading'
    check("grep -c '^$' " + operands, 'empty:0\nblank:1\nblanks:2\nterminated:0\ntrailing:1\nunterminated:0\nleading:1\n')
    check("grep -l '^$' " + operands, 'blank\nblanks\ntrailing\nleading\n')
    check("grep -L '^$' " + operands, 'empty\nterminated\nunterminated\n')
    check("grep -vc '^$' blank terminated trailing unterminated leading", 'blank:0\nterminated:1\ntrailing:1\nunterminated:1\nleading:1\n')
  })

  it('honors selection caps and quiet status for empty and unterminated lines', () => {
    check("grep -cm1 '^$' blanks trailing", 'blanks:1\ntrailing:1\n')
    check("grep -cm1 '^$' empty terminated unterminated", 'empty:0\nterminated:0\nunterminated:0\n', 1)
    check('grep -cm1 hit terminated trailing unterminated leading', 'terminated:1\ntrailing:1\nunterminated:1\nleading:1\n')
    for (const name of ['blank', 'blanks', 'trailing', 'leading']) check("grep -qm1 '^$' " + name, '')
    for (const name of ['empty', 'terminated', 'unterminated']) check("grep -qm1 '^$' " + name, '', 1)
  })

  it('keeps binary and locale diagnostics after an early matching line', () => {
    const inputs = { binary: 'hit\n\0', unicode: 'hit\né\n' }
    const cases = [
      ['hit binary', 'binary input', 'grep: binary input detection and output are not supported'],
      ['. unicode', 'non-ASCII regex semantics', 'grep: locale-sensitive regular expression matching on non-ASCII input is not supported'],
    ]
    for (const mode of ['-q', '-l', '-L', '-cm1', '-m1']) {
      for (const [operands, detail, message] of cases) {
        const command = 'grep ' + mode + ' ' + operands
        assert.deepEqual(createTerminal(inputs).run(command), {
          stdout: '', stderr: message + '\n', exitCode: 2, cwd: '/',
          unsupported: [{ kind: 'feature', command: 'grep', detail, message }],
        }, command)
      }
    }
  })
})
