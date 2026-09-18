import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Checked against GNU coreutils 9.4, which opens a name to create it and sets
// times where it cannot — `-c`, or a trailing slash — naming in the diagnostic
// which of the two it was doing. The times themselves are the half this
// filesystem has nowhere to keep.
const SOURCES = { file: 'plain\n', 'dir/leaf': 'leaf\n' }
const terminal = (options = {}) => createTerminal(SOURCES, { mount: '/repo', cwd: '/repo', writable: '/tmp/', ...options })

function check(t, command, stdout = '', stderr = '', exitCode = 0, cwd = '/repo') {
  assert.deepEqual(t.run(command), { stdout, stderr, exitCode, cwd, notes: [], unsupported: [] }, command)
}

const TIMES = (name) => `touch: setting the times of '${name}' is not supported (every entry here carries the one time this filesystem keeps)\n`

function gap(t, command, stderr) {
  const result = t.run(command)
  assert.equal(result.stdout, '', command)
  assert.equal(result.stderr, stderr, command)
  assert.equal(result.exitCode, 1, command)
  assert.deepEqual(result.unsupported.map(({ kind, command: from, detail }) => [kind, from, detail]), [['feature', 'touch', 'times']], command)
  return result
}

describe('touch makes the files it names', () => {
  it('creates an empty file', () => {
    const t = terminal()
    check(t, 'touch /tmp/new')
    check(t, 'ls /tmp', 'new\n')
    check(t, 'wc -c /tmp/new', '0 /tmp/new\n')
    check(t, 'test -f /tmp/new && echo yes', 'yes\n')
  })

  it('creates every name it is given', () => {
    const t = terminal()
    check(t, 'touch /tmp/one /tmp/two /tmp/three')
    check(t, 'ls /tmp', 'one\nthree\ntwo\n')
  })

  it('creates a file a later redirect can append to', () => {
    const t = terminal()
    check(t, 'touch /tmp/log; echo first >>/tmp/log; echo second >>/tmp/log')
    check(t, 'cat /tmp/log', 'first\nsecond\n')
  })

  it('creates inside a directory cp -r made', () => {
    const t = terminal()
    check(t, 'cp -r dir /tmp/copy')
    check(t, 'touch /tmp/copy/new')
    check(t, 'ls /tmp/copy', 'leaf\nnew\n')
  })

  it('takes a name that looks like an option after --', () => {
    const t = terminal()
    check(t, 'touch -- /tmp/-c')
    check(t, 'ls /tmp', '-c\n')
  })

  it('reads as a command, in completion and in which', () => {
    const t = terminal()
    assert.deepEqual(t.complete('tou'), ['touch'])
    check(t, 'which touch', '/usr/bin/touch\n')
  })
})

describe('touch reports the times it cannot set', () => {
  it('names a file that is already there', () => {
    const t = terminal()
    check(t, 'printf kept >/tmp/held')
    gap(t, 'touch /tmp/held', TIMES('/tmp/held'))
    // The gap is a refusal, not a rewrite: what the file holds is untouched.
    check(t, 'cat /tmp/held', 'kept')
  })

  it('names a directory that is already there', () => {
    const t = terminal()
    check(t, 'cp -r dir /tmp/copy')
    gap(t, 'touch /tmp/copy', TIMES('/tmp/copy'))
    gap(t, 'touch /tmp/copy/', TIMES('/tmp/copy/'))
    gap(t, 'touch /tmp', TIMES('/tmp'))
  })

  it('reports it under -c as well, since -c still sets times', () => {
    const t = terminal()
    check(t, 'touch /tmp/new')
    gap(t, 'touch -c /tmp/new', TIMES('/tmp/new'))
    gap(t, 'touch --no-create /tmp/new', TIMES('/tmp/new'))
  })

  it('reports it once for a line that names the same gap twice', () => {
    const t = terminal()
    check(t, 'touch /tmp/one /tmp/two')
    gap(t, 'touch /tmp/one /tmp/two', TIMES('/tmp/one') + TIMES('/tmp/two'))
  })

  it('creates what it can and reports what it cannot, in one line', () => {
    const t = terminal()
    check(t, 'touch /tmp/first')
    gap(t, 'touch /tmp/first /tmp/second', TIMES('/tmp/first'))
    check(t, 'ls /tmp', 'first\nsecond\n')
  })

  it('cannot be hidden by a redirect or a pipe', () => {
    const t = terminal()
    check(t, 'touch /tmp/new')
    const result = t.run('touch /tmp/new 2>/dev/null | cat')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.unsupported.map(({ detail }) => detail), ['times'])
  })
})

describe('touch answers for a filesystem it cannot write', () => {
  it('refuses a source tree that is read-only', () => {
    const t = terminal()
    check(t, 'touch /repo/new', '', "touch: cannot touch '/repo/new': Read-only file system\n", 1)
    check(t, 'touch file', '', "touch: setting times of 'file': Read-only file system\n", 1)
    check(t, 'touch dir', '', "touch: setting times of 'dir': Read-only file system\n", 1)
    check(t, 'test -e /repo/new', '', '', 1)
  })

  it('has no /tmp to write when no overlay was asked for', () => {
    const t = terminal({ writable: false })
    check(t, 'touch /tmp/new', '', "touch: cannot touch '/tmp/new': No such file or directory\n", 1)
    check(t, 'touch file', '', "touch: setting times of 'file': Read-only file system\n", 1)
  })
})

describe('touch reports a name it cannot reach the way GNU reports it', () => {
  for (const [command, stderr, exitCode] of [
    ['touch', 'touch: missing file operand\n', 1],
    ['touch /tmp/missing/new', "touch: cannot touch '/tmp/missing/new': No such file or directory\n", 1],
    ['touch /tmp/file/new', "touch: cannot touch '/tmp/file/new': Not a directory\n", 1],
    ['touch /tmp/gone/', "touch: setting times of '/tmp/gone/': No such file or directory\n", 1],
    ['touch -c /tmp/file/new', "touch: setting times of '/tmp/file/new': Not a directory\n", 1],
    ['touch -c /tmp/missing/new', '', 0],
    ['touch -c /tmp/gone/', '', 0],
    ['touch -c /tmp/gone', '', 0],
  ]) {
    it(command, () => {
      const t = terminal()
      check(t, 'printf x >/tmp/file')
      check(t, command, '', stderr, exitCode)
      check(t, 'ls /tmp', 'file\n')
    })
  }

  it('points at a path that exists under another root', () => {
    const t = terminal()
    const result = t.run('touch dir/leaf/new')
    assert.equal(result.stderr, "touch: cannot touch 'dir/leaf/new': Not a directory\n")
    assert.equal(result.exitCode, 1)
    const noted = terminal({ cwd: '/' }).run('touch dir/leaf')
    assert.equal(noted.stderr, "touch: cannot touch 'dir/leaf': No such file or directory\n")
    assert.deepEqual(noted.notes, ['touch: relative path "dir/leaf" was not found from cwd "/". A file exists at "/repo/dir/leaf".'])
  })

  it('hints at nothing for a name -c passes over', () => {
    const quiet = terminal({ cwd: '/' }).run('touch -c dir/leaf')
    assert.equal(quiet.stderr, '')
    assert.equal(quiet.exitCode, 0)
    // A hint accompanies a failure a caller was told about; there is none here.
    assert.deepEqual(quiet.notes, [])
    const reported = terminal({ cwd: '/' }).run('touch dir/leaf')
    assert.equal(reported.exitCode, 1)
    assert.deepEqual(reported.notes, ['touch: relative path "dir/leaf" was not found from cwd "/". A file exists at "/repo/dir/leaf".'])
  })

  it('quotes a name that needs it', () => {
    const t = createTerminal({ 'a b': 'x' }, { mount: '/repo', cwd: '/repo', writable: '/tmp/' })
    check(t, 'touch "a b"', '', "touch: setting times of 'a b': Read-only file system\n", 1)
  })
})

describe('touch refuses the options it has no clock for', () => {
  for (const option of ['-a', '-m', '-d 2024-01-01', '-t 202401010000', '-r /repo/file', '--time=mtime', '-h']) {
    it(option, () => {
      const t = terminal()
      const result = t.run(`touch ${option} /tmp/new 2>/dev/null | cat`)
      assert.equal(result.stdout, '')
      assert.equal(result.exitCode, 0)
      assert.ok(result.unsupported.some(({ kind, command }) => kind === 'option' && command === 'touch'), JSON.stringify(result.unsupported))
      check(t, 'test -e /tmp/new', '', '', 1)
    })
  }
})
