import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const terminal = () => createTerminal({}, { mount: '/src', writable: '/tmp/' })
const badFd = 'error: 3: Bad file descriptor\n'

// Bash performs descriptor duplication in do_redirections while executing the
// selected command, after expanding its arguments and earlier redirects.
describe('unopened descriptors fail during command execution', () => {
  for (const [command, stdout, stderr, exitCode] of [
    ['echo before; echo bad >&3; echo after', 'before\nafter\n', badFd, 0],
    ['echo before; echo bad >&3', 'before\n', badFd, 1],
    ['echo bad 2>&3', '', badFd, 1],
    ['echo before\necho bad >&3\necho after', 'before\nafter\n', badFd, 0],
    ['false && echo bad >&3; echo after', 'after\n', '', 0],
    ['true || echo bad >&3', '', '', 0],
    ['true && echo bad >&3', '', badFd, 1],
    ['false || echo bad >&3', '', badFd, 1],
    ['echo before; echo bad 2>/dev/null >&3; echo after', 'before\nafter\n', '', 0],
    ['echo before; echo bad >&3 2>/dev/null; echo after', 'before\nafter\n', badFd, 0],
    ['echo "$((n=3))" >&3; printf "%s" "$n"', '3', badFd, 0],
  ]) {
    it(command, () => {
      const result = terminal().run(command)
      assert.deepEqual(result, { stdout, stderr, exitCode, cwd: '/src', notes: [], unsupported: [] })
    })
  }

  it('preserves earlier redirect writes and does not apply later redirects', () => {
    const t = terminal()
    t.run('printf keep >/tmp/earlier; printf keep >/tmp/later')
    const earlier = t.run('echo bad >/tmp/earlier >&3')
    const later = t.run('echo bad >&3 >/tmp/later')
    for (const result of [earlier, later]) {
      assert.equal(result.stdout, '')
      assert.equal(result.stderr, badFd)
      assert.equal(result.exitCode, 1)
      assert.deepEqual(result.unsupported, [])
    }
    assert.equal(t.run('cat /tmp/earlier').stdout, '')
    assert.equal(t.run('cat /tmp/later').stdout, 'keep')
  })
})

describe('substitution descriptor failures retain normal command status rules', () => {
  for (const [command, stdout, exitCode] of [
    ['printf "<%s>" "$(echo prefix; echo bad >&3)"; printf "<%s>" "$?"', '<prefix><0>', 0],
    ['x=$(echo prefix; echo bad >&3); status=$?; printf "<%s><%s>" "$status" "$x"', '<1><prefix>', 0],
    ['x=$(echo bad >&3)', '', 1],
    ['x=$(echo one; echo bad >&3; echo two); printf "<%s>" "$x"', '<one\ntwo>', 0],
    ['echo before\nx=$(echo prefix; echo bad >&3)\nprintf "<%s><%s>" "$?" "$x"', 'before\n<1><prefix>', 0],
    ['x=$(echo "$(echo bad >&3)"); printf "<%s><%s>" "$?" "$x"', '<0><>', 0],
  ]) {
    it(command, () => {
      const result = terminal().run(command)
      assert.deepEqual(result, { stdout, stderr: badFd, exitCode, cwd: '/src', notes: [], unsupported: [] })
    })
  }

  it('does not evaluate command substitutions in a skipped command', () => {
    const result = terminal().run('true || echo "$(echo bad >&3)"; false && echo "$(echo bad >&3)"')
    assert.deepEqual(result, { stdout: '', stderr: '', exitCode: 1, cwd: '/src', notes: [], unsupported: [] })
  })
})
