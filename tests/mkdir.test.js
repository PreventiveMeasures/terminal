import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Checked against GNU coreutils 9.4: what `-p` passes over, which component a
// failure names, and the stream `-v` announces on.
const SOURCES = { file: 'f\n', 'dir/leaf': 'leaf\n' }
const terminal = (options = {}) => createTerminal(SOURCES, { mount: '/repo', cwd: '/repo', writable: '/tmp/', ...options })

function check(t, command, stdout = '', stderr = '', exitCode = 0, cwd = '/repo') {
  assert.deepEqual(t.run(command), { stdout, stderr, exitCode, cwd, notes: [], unsupported: [] }, command)
}

describe('mkdir makes directories in the writable overlay', () => {
  it('makes one, and everything else can then use it', () => {
    const t = terminal()
    check(t, 'mkdir /tmp/made')
    check(t, 'ls /tmp', 'made\n')
    check(t, 'test -d /tmp/made && echo yes', 'yes\n')
    check(t, 'touch /tmp/made/new; printf x >/tmp/made/written; cp /repo/file /tmp/made/copied')
    check(t, 'find /tmp/made', '/tmp/made\n/tmp/made/copied\n/tmp/made/new\n/tmp/made/written\n')
    check(t, 'cd /tmp/made; pwd', '/tmp/made\n', '', 0, '/tmp/made')
  })

  it('makes several, and keeps going after one it cannot make', () => {
    const t = terminal()
    check(t, 'mkdir /tmp/one /tmp/two')
    check(t, 'mkdir /tmp/one /tmp/three', '', "mkdir: cannot create directory '/tmp/one': File exists\n", 1)
    check(t, 'ls /tmp', 'one\nthree\ntwo\n')
  })

  it('announces what it made on stdout, and only what it made', () => {
    const t = terminal()
    check(t, 'mkdir -v /tmp/loud', "mkdir: created directory '/tmp/loud'\n")
    check(t, 'mkdir --verbose /tmp/louder', "mkdir: created directory '/tmp/louder'\n")
    check(t, 'mkdir -v /tmp/quiet 2>/dev/null', "mkdir: created directory '/tmp/quiet'\n")
    check(t, 'mkdir -pv /tmp/quiet')
  })

  it('takes a trailing slash as the directory it names', () => {
    const t = terminal()
    check(t, 'mkdir -pv /tmp/slash/', "mkdir: created directory '/tmp/slash/'\n")
    check(t, 'test -d /tmp/slash && echo yes', 'yes\n')
  })

  it('makes a path relative to where it stands', () => {
    const t = terminal()
    check(t, 'cd /tmp; mkdir here; ls', 'here\n', '', 0, '/tmp')
  })
})

describe('mkdir -p makes each missing component and passes over the rest', () => {
  it('makes a whole path, announcing every level', () => {
    const t = terminal()
    check(t, 'mkdir -pv /tmp/a/b/c', "mkdir: created directory '/tmp/a'\nmkdir: created directory '/tmp/a/b'\nmkdir: created directory '/tmp/a/b/c'\n")
    check(t, 'find /tmp/a', '/tmp/a\n/tmp/a/b\n/tmp/a/b/c\n')
  })

  it('says nothing of a directory already there', () => {
    const t = terminal()
    check(t, 'mkdir -p /tmp/a/b')
    check(t, 'mkdir -pv /tmp/a/b/c', "mkdir: created directory '/tmp/a/b/c'\n")
    check(t, 'mkdir -p /tmp/a')
  })

  it('makes a relative path from several components', () => {
    const t = terminal()
    check(t, 'cd /tmp; mkdir -p one/two/three; find one', 'one\none/two\none/two/three\n', '', 0, '/tmp')
  })

  it('names the component a file is in the way of', () => {
    const t = terminal()
    check(t, 'printf x >/tmp/blocked')
    check(t, 'mkdir -p /tmp/blocked/inner', '', "mkdir: cannot create directory '/tmp/blocked': Not a directory\n", 1)
    check(t, 'mkdir -p /tmp/blocked', '', "mkdir: cannot create directory '/tmp/blocked': File exists\n", 1)
    check(t, 'cat /tmp/blocked', 'x')
  })

  it('stops at the component it could not make', () => {
    const t = terminal()
    check(t, 'printf x >/tmp/blocked')
    check(t, 'mkdir -pv /tmp/blocked/inner/deeper', '', "mkdir: cannot create directory '/tmp/blocked': Not a directory\n", 1)
    check(t, 'ls /tmp', 'blocked\n')
  })
})

describe('mkdir refuses what it cannot make', () => {
  for (const [command, stderr] of [
    ['mkdir', 'mkdir: missing operand\n'],
    ['mkdir /tmp/here', "mkdir: cannot create directory '/tmp/here': File exists\n"],
    ['mkdir /tmp/taken', "mkdir: cannot create directory '/tmp/taken': File exists\n"],
    ['mkdir /tmp/missing/inner', "mkdir: cannot create directory '/tmp/missing/inner': No such file or directory\n"],
    ['mkdir /tmp/taken/inner', "mkdir: cannot create directory '/tmp/taken/inner': Not a directory\n"],
    ['mkdir /repo/new', "mkdir: cannot create directory '/repo/new': Read-only file system\n"],
    ['mkdir dir', "mkdir: cannot create directory 'dir': File exists\n"],
  ]) {
    it(command, () => {
      const t = terminal()
      check(t, 'mkdir /tmp/here; printf x >/tmp/taken')
      check(t, command, '', stderr, 1)
      check(t, 'ls /tmp', 'here\ntaken\n')
    })
  }

  it('has no /tmp to make anything in without an overlay', () => {
    check(terminal({ writable: false }), 'mkdir /tmp/new', '', "mkdir: cannot create directory '/tmp/new': No such file or directory\n", 1)
  })

  it('points at a path that exists under another root', () => {
    const result = terminal({ cwd: '/' }).run('mkdir dir/leaf')
    assert.equal(result.stderr, "mkdir: cannot create directory 'dir/leaf': No such file or directory\n")
    assert.deepEqual(result.notes, ['mkdir: relative path "dir/leaf" was not found from cwd "/". A file exists at "/repo/dir/leaf".'])
  })

  for (const option of ['-m 755', '--mode=755', '-Z', '--context=x']) {
    it(`refuses ${option}, which there is no model for`, () => {
      const t = terminal()
      const result = t.run(`mkdir ${option} /tmp/new 2>/dev/null | cat`)
      assert.equal(result.exitCode, 0)
      assert.ok(result.unsupported.some(({ kind, command }) => kind === 'option' && command === 'mkdir'), JSON.stringify(result.unsupported))
      check(t, 'test -e /tmp/new', '', '', 1)
    })
  }
})
