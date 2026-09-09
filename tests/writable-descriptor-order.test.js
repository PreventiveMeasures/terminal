import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const ERROR = 'cat: missing: no such file or directory\n'
const options = { mount: '/repo', cwd: '/repo', writable: '/tmp/' }
const terminal = (extra = {}) => createTerminal({ input: 'source\n' }, { ...options, ...extra })
const result = (stdout = '', exitCode = 0, stderr = '', unsupported = []) => ({ stdout, stderr, exitCode, cwd: '/repo', unsupported })
const check = (t, command, stdout = '') => assert.deepEqual(t.run(command), result(stdout), command)

// Output redirects open left-to-right. Duplicated descriptors share a write
// position, separate opens retain independent positions, and append uses EOF
// at each write. Enclosing shell scopes inherit those open descriptions.
describe('writable redirects are visible while enclosing commands execute', () => {
  const cases = [
    ["{ printf A; printf '%s' \"$(cat /tmp/log)\"; } >/tmp/log", 'AA'],
    ["{ printf A; { printf B; printf '%s' \"$(cat /tmp/log)\"; }; } >/tmp/log", 'ABAB'],
    ["{ printf 'a b'; for x in $(cat /tmp/log); do printf '[%s]' \"$x\"; done; } >/tmp/log", 'a b[a][b]'],
    ['{ printf a; if grep -q a /tmp/log; then printf yes; fi; } >/tmp/log', 'ayes'],
    ["{ printf '%s' \"$(printf inside)\"; } >/tmp/log", 'inside'],
    ['{ printf X | cat; } >/tmp/log', 'X'],
    ['{ { printf A; } | cat; printf B; } >/tmp/log', 'AB'],
    ['{ (printf A); printf B; } >/tmp/log', 'AB'],
    ["{ printf old; printf '%s' \"$(cat /tmp/log)\" >>/tmp/log; } >/tmp/log", 'oldold'],
  ]
  for (const [command, content] of cases) {
    it(command, () => {
      const t = terminal()
      check(t, command)
      check(t, 'cat /tmp/log', content)
    })
  }
  it('a command substitution reads diagnostics written by earlier inner commands', () => {
    const t = terminal()
    check(t, '{ value=$(cat missing; cat /tmp/errors); printf "%s" "$value"; } 2>/tmp/errors', ERROR.trimEnd())
    check(t, 'cat /tmp/errors', ERROR)
  })
  it('a substitution can duplicate its captured stdout over inherited file stderr', () => {
    const t = terminal()
    check(t, '{ value=$(cat missing 2>&1); printf "%s" "$value"; } 2>/tmp/errors', ERROR.trimEnd())
    check(t, 'cat /tmp/errors')
  })
  it('pipeline stderr reaches its inherited file before the next stage reads it', () => {
    const t = terminal()
    check(t, '{ cat missing | cat /tmp/errors; } 2>/tmp/errors', ERROR)
    check(t, 'cat /tmp/errors', ERROR)
  })
  it('inner redirects override and then restore the enclosing file', () => {
    const t = terminal()
    check(t, '{ printf A; printf B >/tmp/other; printf C | cat >>/tmp/other; printf D; } >/tmp/log')
    check(t, 'cat /tmp/log', 'AD')
    check(t, 'cat /tmp/other', 'BC')
  })
  it('delegated find commands see writes from earlier child commands', () => {
    const t = terminal()
    const command = 'find /repo/input -exec printf A \\; -exec grep -q A /tmp/log \\; -exec printf yes \\; >/tmp/log'
    check(t, command)
    check(t, 'cat /tmp/log', 'Ayes')
  })
  it('find prints precede child commands that inspect their output file', () => {
    const t = terminal()
    check(t, 'find /repo/input -print -exec grep -q input /tmp/log \\; -exec printf yes \\; >/tmp/log')
    check(t, 'cat /tmp/log', '/repo/input\nyes')
  })
  it('find print0 and child output keep their action order', () => {
    const t = terminal()
    check(t, 'find /repo/input -print0 -exec printf middle \\; -print0 >/tmp/log')
    check(t, 'cat /tmp/log', '/repo/input\0middle/repo/input\0')
  })
  it('find errors reach inherited stderr before later child commands read it', () => {
    const t = terminal()
    const actual = t.run('find missing /repo/input -exec grep -q missing /tmp/log \\; -exec printf yes \\; 2>/tmp/log')
    assert.deepEqual(actual, result('yes', 1))
    check(t, 'cat /tmp/log', 'find: missing: no such file or directory\n')
  })
  it('find known stdout and stderr events can share a file in action order', () => {
    const t = terminal()
    const actual = t.run('find missing /repo/input -print 2>&1 >/tmp/out')
    assert.deepEqual(actual, result('find: missing: no such file or directory\n', 1))
    check(t, 'cat /tmp/out', '/repo/input\n')
    assert.deepEqual(t.run('find missing /repo/input -print >/tmp/log 2>&1'), result('', 1))
    check(t, 'cat /tmp/log', 'find: missing: no such file or directory\n/repo/input\n')
  })
  it('delegated xargs commands see writes from earlier child commands', () => {
    const t = terminal({ commands: {
      snapshot: ({ args, fs }) => fs.readFile('/tmp/log') + args[0],
    } })
    check(t, "printf 'a b' | xargs -n1 snapshot >/tmp/log")
    check(t, 'cat /tmp/log', 'aab')
  })
})

describe('writable file descriptions retain independent offsets', () => {
  const cases = [
    ['{ printf ab; printf Z >/tmp/log; printf cd; } >/tmp/log', 'Z\0cd'],
    ['{ printf ab; printf Z >/tmp/log; printf cd; } >>/tmp/log', 'Zcd'],
    ['{ printf ab >&2; printf cd; } >/tmp/log 2>&1', 'abcd'],
    ['{ printf ab; printf Z >&2; printf cd; } >/tmp/log 2>/tmp/log', 'Zbcd'],
    ['{ printf ab; printf Z >&2; printf cd; } >/tmp/log 2>>/tmp/log', 'abcd'],
    ['{ printf ab; printf Z >&2; printf cd; } >>/tmp/log 2>>/tmp/log', 'abZcd'],
    ["{ printf 'é'; printf A >/tmp/log; printf X; } >/tmp/log", 'A\0X'],
  ]
  for (const [command, content] of cases) {
    it(command, () => {
      const t = terminal()
      check(t, command)
      check(t, 'cat /tmp/log', content)
    })
  }
  it('opens every output target even when a later redirect replaces it', () => {
    const t = terminal()
    check(t, 'printf old >/tmp/first; printf new >/tmp/first >/tmp/second')
    check(t, 'cat /tmp/first')
    check(t, 'cat /tmp/second', 'new')
  })
  it('retains earlier truncation when a later target fails to open', () => {
    const t = terminal()
    check(t, 'printf old >/tmp/log')
    const failed = t.run('printf new >/tmp/log >/tmp/missing/file')
    assert.equal(failed.exitCode, 1)
    assert.equal(failed.stdout, '')
    assert.notEqual(failed.stderr, '')
    assert.deepEqual(failed.unsupported, [])
    check(t, 'cat /tmp/log')
  })
  it('does not open redirects for an unexecuted gated command', () => {
    const t = terminal()
    check(t, 'printf old >/tmp/log; false && printf new >/tmp/log; cat /tmp/log', 'old')
  })
  it('expands command arguments before truncating the output target', () => {
    const t = terminal()
    check(t, 'printf old >/tmp/log; printf "%s" "$(cat /tmp/log)" >/tmp/log')
    check(t, 'cat /tmp/log', 'old')
  })
})

describe('fresh captures and reopened output do not inherit closed stdout', () => {
  const cases = [
    ['{ printf X | cat >/tmp/log; } >&-', 'X'],
    ['{ value=$(printf X); printf "%s" "$value" >/tmp/log; } >&-', 'X'],
    ['{ printf X >/tmp/log; } >&-', 'X'],
    ['{ { printf X; } >/tmp/log; } >&-', 'X'],
  ]
  for (const [command, content] of cases) {
    it(command, () => {
      const t = terminal()
      check(t, command)
      check(t, 'cat /tmp/log', content)
    })
  }
  it('still reports a direct write to an inherited closed stdout', () => {
    const actual = terminal().run('{ printf X; } >&-')
    assert.equal(actual.exitCode, 1)
    assert.equal(actual.stdout, '')
    assert.match(actual.stderr, /Bad file descriptor/u)
    assert.deepEqual(actual.unsupported, [])
  })
})

describe('ambiguous stream order cannot silently corrupt writable files', () => {
  const commands = {
    mixed: () => ({ stdout: 'stdout', stderr: 'stderr\n', exitCode: 0 }),
  }
  for (const redirects of ['>/tmp/log 2>&1', '>/tmp/log 2>/tmp/log', '>>/tmp/log 2>>/tmp/log']) {
    it(`diagnoses unspecified handler ordering for ${redirects}`, () => {
      const t = terminal({ commands })
      const actual = t.run(`mixed ${redirects} | cat`)
      assert.equal(actual.stdout, '')
      assert.equal(actual.stderr, '')
      assert.equal(actual.exitCode, 0)
      assert.equal(actual.unsupported.length, 1)
      assert.equal(actual.unsupported[0].detail, 'combined output ordering')
      const stored = t.run('cat /tmp/log')
      assert.equal(stored.exitCode, 0)
      assert.match(stored.stdout, /merging.*stdout and stderr/u)
    })
  }
  it('independent output files do not require stream ordering', () => {
    const t = terminal({ commands })
    check(t, 'mixed >/tmp/out 2>/tmp/err')
    check(t, 'cat /tmp/out', 'stdout')
    check(t, 'cat /tmp/err', 'stderr\n')
  })
})

describe('writable input redirections cannot retain pre-truncation data', () => {
  for (const redirects of ['</tmp/log >/tmp/log', '>/tmp/log </tmp/log']) {
    it(`self-truncating input: ${redirects}`, () => {
      const t = terminal()
      check(t, 'printf old >/tmp/log')
      check(t, `cat ${redirects}`)
      check(t, 'cat /tmp/log')
    })
  }
  it('reads named operands after output redirection truncates the file', () => {
    const t = terminal()
    check(t, 'printf old >/tmp/log; cat /tmp/log >/tmp/log')
    check(t, 'cat /tmp/log')
  })
  for (const command of [
    '{ printf new >/tmp/log; cat; } </tmp/log',
    '{ head -c1 >/dev/null; printf new >/tmp/log; cat; } </tmp/log',
  ]) {
    it(`updated inherited input is read correctly or explicitly diagnosed: ${command}`, () => {
      const t = terminal()
      check(t, 'printf old >/tmp/log')
      const actual = t.run(command)
      if (actual.unsupported.length) {
        assert.notEqual(actual.exitCode, 0)
        assert.notEqual(actual.stderr, '')
        assert.equal(actual.stdout, '')
      } else {
        assert.deepEqual(actual, result(command.includes('head') ? 'ew' : 'new'))
        check(t, 'cat /tmp/log', 'new')
      }
    })
  }
  it('does not silently copy an input file into its own append destination', () => {
    // GNU cat refuses a regular input positioned before its output append EOF:
    // https://github.com/coreutils/coreutils/blob/master/src/cat.c
    const t = terminal()
    check(t, 'printf old >/tmp/log')
    const actual = t.run('cat /tmp/log >>/tmp/log')
    assert.notEqual(actual.exitCode, 0)
    assert.equal(actual.stdout, '')
    assert.notEqual(actual.stderr, '')
    check(t, 'cat /tmp/log', 'old')
  })
})
