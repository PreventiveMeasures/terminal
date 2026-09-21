import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Checked against GNU coreutils 9.4: what `-p` passes over, which component a
// failure names, and the stream `-v` announces on.
const SOURCES = { file: 'f\n', 'dir/leaf': 'leaf\n' }
const terminal = (options = {}) => createTerminal(SOURCES, { mount: '/repo', cwd: '/repo', writable: '/tmp/', ...options })

async function check(t, command, stdout = '', stderr = '', exitCode = 0, cwd = '/repo') {
  assert.deepEqual(await t.run(command), { stdout, stderr, exitCode, cwd, notes: [], unsupported: [] }, command)
}

describe('mkdir makes directories in the writable overlay', () => {
  it('makes one, and everything else can then use it', async () => {
    const t = terminal()
    await check(t, 'mkdir /tmp/made')
    await check(t, 'ls /tmp', 'made\n')
    await check(t, 'test -d /tmp/made && echo yes', 'yes\n')
    await check(t, 'touch /tmp/made/new; printf x >/tmp/made/written; cp /repo/file /tmp/made/copied')
    await check(t, 'find /tmp/made', '/tmp/made\n/tmp/made/copied\n/tmp/made/new\n/tmp/made/written\n')
    await check(t, 'cd /tmp/made; pwd', '/tmp/made\n', '', 0, '/tmp/made')
  })

  it('makes several, and keeps going after one it cannot make', async () => {
    const t = terminal()
    await check(t, 'mkdir /tmp/one /tmp/two')
    await check(t, 'mkdir /tmp/one /tmp/three', '', "mkdir: cannot create directory '/tmp/one': File exists\n", 1)
    await check(t, 'ls /tmp', 'one\nthree\ntwo\n')
  })

  it('announces what it made on stdout, and only what it made', async () => {
    const t = terminal()
    await check(t, 'mkdir -v /tmp/loud', "mkdir: created directory '/tmp/loud'\n")
    await check(t, 'mkdir --verbose /tmp/louder', "mkdir: created directory '/tmp/louder'\n")
    await check(t, 'mkdir -v /tmp/quiet 2>/dev/null', "mkdir: created directory '/tmp/quiet'\n")
    await check(t, 'mkdir -pv /tmp/quiet')
  })

  it('takes a trailing slash as the directory it names', async () => {
    const t = terminal()
    await check(t, 'mkdir -pv /tmp/slash/', "mkdir: created directory '/tmp/slash/'\n")
    await check(t, 'test -d /tmp/slash && echo yes', 'yes\n')
  })

  it('makes a path relative to where it stands', async () => {
    const t = terminal()
    await check(t, 'cd /tmp; mkdir here; ls', 'here\n', '', 0, '/tmp')
  })
})

describe('mkdir -p makes each missing component and passes over the rest', () => {
  it('makes a whole path, announcing every level', async () => {
    const t = terminal()
    await check(t, 'mkdir -pv /tmp/a/b/c', "mkdir: created directory '/tmp/a'\nmkdir: created directory '/tmp/a/b'\nmkdir: created directory '/tmp/a/b/c'\n")
    await check(t, 'find /tmp/a', '/tmp/a\n/tmp/a/b\n/tmp/a/b/c\n')
  })

  it('says nothing of a directory already there', async () => {
    const t = terminal()
    await check(t, 'mkdir -p /tmp/a/b')
    await check(t, 'mkdir -pv /tmp/a/b/c', "mkdir: created directory '/tmp/a/b/c'\n")
    await check(t, 'mkdir -p /tmp/a')
  })

  it('makes a relative path from several components', async () => {
    const t = terminal()
    await check(t, 'cd /tmp; mkdir -p one/two/three; find one', 'one\none/two\none/two/three\n', '', 0, '/tmp')
  })

  it('names the component a file is in the way of', async () => {
    const t = terminal()
    await check(t, 'printf x >/tmp/blocked')
    await check(t, 'mkdir -p /tmp/blocked/inner', '', "mkdir: cannot create directory '/tmp/blocked': Not a directory\n", 1)
    await check(t, 'mkdir -p /tmp/blocked', '', "mkdir: cannot create directory '/tmp/blocked': File exists\n", 1)
    await check(t, 'cat /tmp/blocked', 'x')
  })

  it('stops at the component it could not make', async () => {
    const t = terminal()
    await check(t, 'printf x >/tmp/blocked')
    await check(t, 'mkdir -pv /tmp/blocked/inner/deeper', '', "mkdir: cannot create directory '/tmp/blocked': Not a directory\n", 1)
    await check(t, 'ls /tmp', 'blocked\n')
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
    it(command, async () => {
      const t = terminal()
      await check(t, 'mkdir /tmp/here; printf x >/tmp/taken')
      await check(t, command, '', stderr, 1)
      await check(t, 'ls /tmp', 'here\ntaken\n')
    })
  }

  it('names an empty operand rather than passing over it', async () => {
    const t = terminal()
    // A silent success here would let `mkdir -p "$dir" && …` run on a name it
    // never got.
    check(t, "mkdir -p ''", '', "mkdir: cannot create directory '': No such file or directory\n", 1)
    await check(t, "mkdir ''", '', "mkdir: cannot create directory '': No such file or directory\n", 1)
    const gated = await t.run("mkdir -p '' && echo continued")
    assert.equal(gated.stdout, '')
    assert.equal(gated.exitCode, 1)
    assert.deepEqual(gated.notes, ['mkdir: exited 1, so the command after && did not run.'])
    await check(t, "mkdir -p /tmp/made ''", '', "mkdir: cannot create directory '': No such file or directory\n", 1)
    await check(t, 'ls /tmp', 'made\n')
  })

  it('passes over the root, which is there whichever way it is spelled', async () => {
    const t = terminal()
    await check(t, 'mkdir -p /')
    await check(t, 'mkdir -p //')
    await check(t, 'mkdir -p /tmp')
  })

  it('has no /tmp to make anything in without an overlay', async () => {
    await check(terminal({ writable: false }), 'mkdir /tmp/new', '', "mkdir: cannot create directory '/tmp/new': No such file or directory\n", 1)
  })

  it('points at a path that exists under another root', async () => {
    const result = await terminal({ cwd: '/' }).run('mkdir dir/leaf')
    assert.equal(result.stderr, "mkdir: cannot create directory 'dir/leaf': No such file or directory\n")
    assert.deepEqual(result.notes, ['mkdir: relative path "dir/leaf" was not found from cwd "/". A file exists at "/repo/dir/leaf".'])
  })

  for (const option of ['-m 755', '--mode=755', '-Z', '--context=x']) {
    it(`refuses ${option}, which there is no model for`, async () => {
      const t = terminal()
      const result = await t.run(`mkdir ${option} /tmp/new 2>/dev/null | cat`)
      assert.equal(result.exitCode, 0)
      assert.ok(result.unsupported.some(({ kind, command }) => kind === 'option' && command === 'mkdir'), JSON.stringify(result.unsupported))
      await check(t, 'test -e /tmp/new', '', '', 1)
    })
  }
})
