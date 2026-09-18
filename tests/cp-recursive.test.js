import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Checked against GNU coreutils 9.4: what `-r` makes, what it announces, and
// the three refusals it has of its own — a destination inside the source, a
// destination that is the source, and a directory over a file.
// https://github.com/coreutils/coreutils/blob/v9.11/src/copy.c
const SOURCES = {
  'a/one': '1\n',
  'a/sub/two': '2\n',
  'a/sub/deep/three': '3\n',
  'a/.hidden': 'dot\n',
  file: 'plain\n',
}
const terminal = (options = {}) => createTerminal(SOURCES, { mount: '/repo', cwd: '/repo', writable: '/tmp/', ...options })
function check(t, command, stdout = '', stderr = '', exitCode = 0, cwd = '/repo') {
  assert.deepEqual(t.run(command), { stdout, stderr, exitCode, cwd, notes: [], unsupported: [] }, command)
}

const TREE = '/tmp/copy\n/tmp/copy/.hidden\n/tmp/copy/one\n/tmp/copy/sub\n/tmp/copy/sub/deep\n/tmp/copy/sub/deep/three\n/tmp/copy/sub/two\n'

describe('cp -r copies a tree into the writable filesystem', () => {
  for (const option of ['-r', '-R', '--recursive']) {
    it(`${option} makes every directory and file below the source`, () => {
      const t = terminal()
      check(t, `cp ${option} a /tmp/copy`)
      check(t, 'find /tmp/copy', TREE)
      check(t, 'cat /tmp/copy/one /tmp/copy/sub/two /tmp/copy/sub/deep/three', '1\n2\n3\n')
    })
  }

  it('copies the hidden entries a listing would pass over, without a note', () => {
    const t = terminal()
    check(t, 'cp -r a /tmp/copy')
    check(t, 'cat /tmp/copy/.hidden', 'dot\n')
  })

  it('names the copy after the last component of the source, inside an existing directory', () => {
    const t = terminal()
    check(t, 'cp -r a /tmp')
    check(t, 'find /tmp -type f', '/tmp/a/.hidden\n/tmp/a/one\n/tmp/a/sub/deep/three\n/tmp/a/sub/two\n')
  })

  it('takes a trailing slash off the name it copies to', () => {
    const t = terminal()
    check(t, 'cp -r a/ /tmp/one')
    check(t, 'cp -r a/sub/ /tmp/two')
    check(t, 'find /tmp -type f', '/tmp/one/.hidden\n/tmp/one/one\n/tmp/one/sub/deep/three\n/tmp/one/sub/two\n/tmp/two/deep/three\n/tmp/two/two\n')
  })

  it('copies what a source holds, not the source itself, when it is named with a dot', () => {
    const t = terminal()
    check(t, 'cp -r a /tmp/dest')
    check(t, 'rm /tmp/dest/one')
    check(t, 'cp -r a/. /tmp/dest')
    check(t, 'find /tmp/dest -type f', '/tmp/dest/.hidden\n/tmp/dest/one\n/tmp/dest/sub/deep/three\n/tmp/dest/sub/two\n')
  })

  it('copies a file as a plain copy does', () => {
    const t = terminal()
    check(t, 'cp -r file /tmp/plain')
    check(t, 'cat /tmp/plain', 'plain\n')
  })

  it('copies a tree the overlay itself holds', () => {
    const t = terminal()
    check(t, 'cp -r a /tmp/first')
    check(t, 'cp -r /tmp/first /tmp/second')
    check(t, 'printf changed >/tmp/second/one')
    check(t, 'cat /tmp/first/one /tmp/second/one', '1\nchanged')
  })

  it('overwrites the files of a copy made before it, keeping what it does not name', () => {
    const t = terminal()
    check(t, 'cp -r a /tmp/copy')
    check(t, 'printf stale >/tmp/copy/one; printf kept >/tmp/copy/extra')
    check(t, 'cp -r a/. /tmp/copy')
    check(t, 'cat /tmp/copy/one /tmp/copy/extra', '1\nkept')
  })

  it('leaves what -n finds already there', () => {
    const t = terminal()
    check(t, 'cp -r a /tmp/copy')
    check(t, 'printf mine >/tmp/copy/one')
    check(t, 'cp -rn a/. /tmp/copy')
    check(t, 'cat /tmp/copy/one', 'mine')
  })

  it('copies into the target itself under -T', () => {
    const t = terminal()
    check(t, 'cp -rT a /tmp/exact')
    check(t, 'find /tmp/exact -type f', '/tmp/exact/.hidden\n/tmp/exact/one\n/tmp/exact/sub/deep/three\n/tmp/exact/sub/two\n')
  })

  it('carries a directory left empty by a removal', () => {
    const t = terminal()
    check(t, 'cp -r a /tmp/copy')
    check(t, 'rm /tmp/copy/sub/two /tmp/copy/sub/deep/three')
    check(t, 'find /tmp/copy/sub', '/tmp/copy/sub\n/tmp/copy/sub/deep\n')
    check(t, 'cp -r /tmp/copy /tmp/again')
    check(t, 'find /tmp/again/sub', '/tmp/again/sub\n/tmp/again/sub/deep\n')
  })
})

describe('cp -rv announces each directory it makes and each file it copies', () => {
  it('names a directory once, when it is made', () => {
    const t = terminal()
    check(t, 'cp -rv a /tmp/copy', "'a' -> '/tmp/copy'\n'a/.hidden' -> '/tmp/copy/.hidden'\n'a/one' -> '/tmp/copy/one'\n'a/sub' -> '/tmp/copy/sub'\n'a/sub/deep' -> '/tmp/copy/sub/deep'\n'a/sub/deep/three' -> '/tmp/copy/sub/deep/three'\n'a/sub/two' -> '/tmp/copy/sub/two'\n")
  })

  it('says nothing of a directory already there', () => {
    const t = terminal()
    check(t, 'cp -r a /tmp/copy')
    check(t, 'rm /tmp/copy/one')
    check(t, 'cp -rv a/. /tmp/copy', "'a/./.hidden' -> '/tmp/copy/./.hidden'\n'a/./one' -> '/tmp/copy/./one'\n'a/./sub/deep/three' -> '/tmp/copy/./sub/deep/three'\n'a/./sub/two' -> '/tmp/copy/./sub/two'\n")
  })

  it('keeps the source spelling it was given', () => {
    const t = terminal()
    check(t, 'cp -rv a/sub /tmp/s', "'a/sub' -> '/tmp/s'\n'a/sub/deep' -> '/tmp/s/deep'\n'a/sub/deep/three' -> '/tmp/s/deep/three'\n'a/sub/two' -> '/tmp/s/two'\n")
  })
})

describe('cp -r refuses what GNU refuses', () => {
  it('will not copy a directory into itself', () => {
    const t = terminal()
    check(t, 'cp -r a /tmp/a')
    for (const [command, message] of [
      ['cp -r /tmp/a /tmp/a', "cp: cannot copy a directory, '/tmp/a', into itself, '/tmp/a/a'\n"],
      ['cp -r /tmp/a /tmp/a/inner', "cp: cannot copy a directory, '/tmp/a', into itself, '/tmp/a/inner'\n"],
      ['cp -r /tmp/a /tmp/a/sub/inner', "cp: cannot copy a directory, '/tmp/a', into itself, '/tmp/a/sub/inner'\n"],
    ]) {
      check(t, command, '', message, 1)
    }
    // Nothing of the refused copy is left behind.
    check(t, 'find /tmp -type d', '/tmp\n/tmp/a\n/tmp/a/sub\n/tmp/a/sub/deep\n')
  })

  it('will not copy a directory onto itself', () => {
    const t = terminal()
    check(t, 'cp -r a /tmp/a')
    check(t, 'cp -r /tmp/a/sub /tmp/a', '', "cp: '/tmp/a/sub' and '/tmp/a/sub' are the same file\n", 1)
    check(t, 'cd /tmp; cp -r a .', '', "cp: 'a' and './a' are the same file\n", 1, '/tmp')
  })

  it('will not overwrite a file with a directory', () => {
    const t = terminal()
    check(t, 'printf x >/tmp/taken')
    check(t, 'cp -r a /tmp/taken', '', "cp: cannot overwrite non-directory '/tmp/taken' with directory 'a'\n", 1)
    check(t, 'cat /tmp/taken', 'x')
  })

  it('will not make a directory where there is no directory to make it in', () => {
    const t = terminal()
    check(t, 'cp -r a /tmp/missing/inner', '', "cp: cannot create directory '/tmp/missing/inner': No such file or directory\n", 1)
  })

  it('will not write outside the overlay', () => {
    check(terminal(), 'cp -r a /repo/copy', '', "cp: cannot create directory '/repo/copy': Read-only file system\n", 1)
    check(terminal({ writable: false }), 'cp -r a /tmp/copy', '', "cp: cannot create directory '/tmp/copy': No such file or directory\n", 1)
  })

  it('still omits a directory without -r', () => {
    check(terminal(), 'cp a /tmp/copy', '', "cp: -r not specified; omitting directory 'a'\n", 1)
  })

  it('names a directory given twice as the directory it is', () => {
    const t = terminal()
    check(t, 'cp -r a a /tmp', '', "cp: warning: source directory 'a' specified more than once\n")
    check(t, 'find /tmp -type f', '/tmp/a/.hidden\n/tmp/a/one\n/tmp/a/sub/deep/three\n/tmp/a/sub/two\n')
  })

  it('keeps copying the operands after one of them fails', () => {
    const t = terminal()
    check(t, 'cp -r a missing file /tmp', '', "cp: cannot stat 'missing': No such file or directory\n", 1)
    check(t, 'find /tmp -type f', '/tmp/a/.hidden\n/tmp/a/one\n/tmp/a/sub/deep/three\n/tmp/a/sub/two\n/tmp/file\n')
  })
})

describe('a copied tree reads back like any other directory', () => {
  const copied = () => {
    const t = terminal()
    assert.equal(t.run('cp -r a /tmp/copy').exitCode, 0)
    return t
  }

  it('lists, walks and measures', () => {
    const t = copied()
    const listed = t.run('ls /tmp/copy')
    assert.equal(listed.stdout, 'one\nsub\n')
    assert.deepEqual(listed.notes, ['ls: omitted 1 hidden entry: "/tmp/copy/.hidden". Hidden entries are included with -a.'])
    check(t, 'ls -a /tmp/copy', '.\n..\n.hidden\none\nsub\n')
    check(t, 'ls /tmp', 'copy\n')
    check(t, 'find /tmp/copy -type d', '/tmp/copy\n/tmp/copy/sub\n/tmp/copy/sub/deep\n')
    check(t, 'du -b /tmp/copy/sub', '2\t/tmp/copy/sub/deep\n4\t/tmp/copy/sub\n')
    check(t, 'wc -l /tmp/copy/one', '1 /tmp/copy/one\n')
  })

  it('searches and globs', () => {
    const t = copied()
    check(t, 'grep -rn 2 /tmp/copy', '/tmp/copy/sub/two:1:2\n')
    check(t, 'echo /tmp/copy/sub/*', '/tmp/copy/sub/deep /tmp/copy/sub/two\n')
    check(t, 'cat /tmp/copy/sub/t*', '2\n')
    check(t, 'cat /tmp/copy/sub/deep/*', '3\n')
  })

  it('takes writes, edits and removals inside it', () => {
    const t = copied()
    check(t, 'printf added >/tmp/copy/sub/new; cat /tmp/copy/sub/new', 'added')
    check(t, "sed -i 's/1/one/' /tmp/copy/one; cat /tmp/copy/one", 'one\n')
    check(t, 'rm /tmp/copy/sub/new')
    check(t, 'test -e /tmp/copy/sub/new', '', '', 1)
  })

  it('refuses to remove a directory, as rm does anywhere', () => {
    const t = copied()
    check(t, 'rm /tmp/copy/sub', '', "rm: cannot remove '/tmp/copy/sub': Is a directory\n", 1)
  })

  it('is a directory to the shell, to cd and to test', () => {
    const t = copied()
    check(t, 'test -d /tmp/copy/sub && echo yes', 'yes\n')
    check(t, 'cd /tmp/copy/sub; pwd; cat two', '/tmp/copy/sub\n2\n', '', 0, '/tmp/copy/sub')
    check(t, 'test -f /tmp/copy/sub', '', '', 1, '/tmp/copy/sub')
  })
})
