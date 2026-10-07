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
    it(command, async () => {
      const result = await terminal().run(command)
      assert.deepEqual(result, { stdout, stderr, exitCode, cwd: '/src', notes: [], unsupported: [] })
    })
  }

  it('preserves earlier redirect writes and does not apply later redirects', async () => {
    const t = terminal()
    await t.run('printf keep >/tmp/earlier; printf keep >/tmp/later')
    const earlier = await t.run('echo bad >/tmp/earlier >&3')
    const later = await t.run('echo bad >&3 >/tmp/later')
    for (const result of [earlier, later]) {
      assert.equal(result.stdout, '')
      assert.equal(result.stderr, badFd)
      assert.equal(result.exitCode, 1)
      assert.deepEqual(result.unsupported, [])
    }
    assert.equal((await t.run('cat /tmp/earlier')).stdout, '')
    assert.equal((await t.run('cat /tmp/later')).stdout, 'keep')
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
    it(command, async () => {
      const result = await terminal().run(command)
      assert.deepEqual(result, { stdout, stderr: badFd, exitCode, cwd: '/src', notes: [], unsupported: [] })
    })
  }

  it('does not evaluate command substitutions in a skipped command', async () => {
    const result = await terminal().run('true || echo "$(echo bad >&3)"; false && echo "$(echo bad >&3)"')
    assert.deepEqual(result, { stdout: '', stderr: '', exitCode: 1, cwd: '/src', notes: [], unsupported: [] })
  })
})

// A directory opens for reading as a file does, and it is the read that
// fails: a command that never reads stdin runs as anywhere, and one that does
// fails in its own words — or is refused, where those words are not known.
describe('a directory on standard input', () => {
  const dirTerminal = () => createTerminal({ 'dir/f': 'f\n', 'a.txt': 'hello\n', lnk: { type: 'symlink', target: 'dir' } }, { mount: '/src', writable: '/tmp/' })
  for (const [command, stdout, stderr, exitCode = 0] of [
    ['echo hi < dir; echo $?', 'hi\n0\n', ''],
    ['echo hi < lnk; echo $?', 'hi\n0\n', ''],
    ['{ echo a; } < dir', 'a\n', ''],
    ['cat < dir; echo $?', '1\n', 'cat: -: Is a directory\n'],
    ['cat < lnk', '', 'cat: -: Is a directory\n', 1],
    ['wc -l < dir; echo $?', '0\n1\n', "wc: 'standard input': Is a directory\n"],
    ['wc < dir 2>&1', "wc: 'standard input': Is a directory\n      0       0       0\n", '', 1],
    ['grep -c x < dir; echo $?', '0\n2\n', 'grep: (standard input): Is a directory\n'],
    ['head -n 1 < dir', '', "head: error reading 'standard input': Is a directory\n", 1],
    ['sort < dir', '', 'sort: read failed: -: Is a directory\n', 2],
    ['sed p < dir', '', 'sed: read error on stdin: Is a directory\n', 4],
    ['sha256sum < dir', '', 'sha256sum: -: Is a directory\n', 1],
    ['cat < dir | wc -l', '0\n', 'cat: -: Is a directory\n'],
    ['x=$(< dir); echo "$? [$x]"', '0 []\n', ''],
  ]) {
    it(command, async () => {
      const result = await dirTerminal().run(command)
      assert.deepEqual(result, { stdout, stderr, exitCode, cwd: '/src', notes: [], unsupported: [] })
    })
  }

  for (const command of ['cat - a.txt < dir', 'cat /dev/stdin < dir', 'grep -s x < dir', 'awk 1 < dir', 'xargs echo < dir', 'find . -exec cat {} \\; < dir']) {
    it(`refuses ${command}`, async () => {
      const result = await dirTerminal().run(command)
      assert.notEqual(result.exitCode, 0)
      assert.equal(result.unsupported[0]?.detail, 'directory on standard input')
    })
  }
})
