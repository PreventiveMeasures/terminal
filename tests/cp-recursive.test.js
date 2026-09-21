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
async function check(t, command, stdout = '', stderr = '', exitCode = 0, cwd = '/repo') {
  assert.deepEqual(await t.run(command), { stdout, stderr, exitCode, cwd, notes: [], unsupported: [] }, command)
}
const check2 = (t, command, stdout = '') => check(t, command, stdout, '', 0, '/tmp')

const TREE = '/tmp/copy\n/tmp/copy/.hidden\n/tmp/copy/one\n/tmp/copy/sub\n/tmp/copy/sub/deep\n/tmp/copy/sub/deep/three\n/tmp/copy/sub/two\n'

describe('cp -r copies a tree into the writable filesystem', () => {
  for (const option of ['-r', '-R', '--recursive']) {
    it(`${option} makes every directory and file below the source`, async () => {
      const t = terminal()
      await check(t, `cp ${option} a /tmp/copy`)
      await check(t, 'find /tmp/copy', TREE)
      await check(t, 'cat /tmp/copy/one /tmp/copy/sub/two /tmp/copy/sub/deep/three', '1\n2\n3\n')
    })
  }

  it('copies the hidden entries a listing would pass over, without a note', async () => {
    const t = terminal()
    await check(t, 'cp -r a /tmp/copy')
    await check(t, 'cat /tmp/copy/.hidden', 'dot\n')
  })

  it('names the copy after the last component of the source, inside an existing directory', async () => {
    const t = terminal()
    await check(t, 'cp -r a /tmp')
    await check(t, 'find /tmp -type f', '/tmp/a/.hidden\n/tmp/a/one\n/tmp/a/sub/deep/three\n/tmp/a/sub/two\n')
  })

  it('takes a trailing slash off the name it copies to', async () => {
    const t = terminal()
    await check(t, 'cp -r a/ /tmp/one')
    await check(t, 'cp -r a/sub/ /tmp/two')
    await check(t, 'find /tmp -type f', '/tmp/one/.hidden\n/tmp/one/one\n/tmp/one/sub/deep/three\n/tmp/one/sub/two\n/tmp/two/deep/three\n/tmp/two/two\n')
  })

  it('copies what a source holds, not the source itself, when it is named with a dot', async () => {
    const t = terminal()
    await check(t, 'cp -r a /tmp/dest')
    await check(t, 'rm /tmp/dest/one')
    await check(t, 'cp -r a/. /tmp/dest')
    await check(t, 'find /tmp/dest -type f', '/tmp/dest/.hidden\n/tmp/dest/one\n/tmp/dest/sub/deep/three\n/tmp/dest/sub/two\n')
  })

  it('copies a file as a plain copy does', async () => {
    const t = terminal()
    await check(t, 'cp -r file /tmp/plain')
    await check(t, 'cat /tmp/plain', 'plain\n')
  })

  it('copies a tree the overlay itself holds', async () => {
    const t = terminal()
    await check(t, 'cp -r a /tmp/first')
    await check(t, 'cp -r /tmp/first /tmp/second')
    await check(t, 'printf changed >/tmp/second/one')
    await check(t, 'cat /tmp/first/one /tmp/second/one', '1\nchanged')
  })

  it('overwrites the files of a copy made before it, keeping what it does not name', async () => {
    const t = terminal()
    await check(t, 'cp -r a /tmp/copy')
    await check(t, 'printf stale >/tmp/copy/one; printf kept >/tmp/copy/extra')
    await check(t, 'cp -r a/. /tmp/copy')
    await check(t, 'cat /tmp/copy/one /tmp/copy/extra', '1\nkept')
  })

  it('leaves what -n finds already there', async () => {
    const t = terminal()
    await check(t, 'cp -r a /tmp/copy')
    await check(t, 'printf mine >/tmp/copy/one')
    await check(t, 'cp -rn a/. /tmp/copy')
    await check(t, 'cat /tmp/copy/one', 'mine')
  })

  it('copies into the target itself under -T', async () => {
    const t = terminal()
    await check(t, 'cp -rT a /tmp/exact')
    await check(t, 'find /tmp/exact -type f', '/tmp/exact/.hidden\n/tmp/exact/one\n/tmp/exact/sub/deep/three\n/tmp/exact/sub/two\n')
  })

  it('carries a directory left empty by a removal', async () => {
    const t = terminal()
    await check(t, 'cp -r a /tmp/copy')
    await check(t, 'rm /tmp/copy/sub/two /tmp/copy/sub/deep/three')
    await check(t, 'find /tmp/copy/sub', '/tmp/copy/sub\n/tmp/copy/sub/deep\n')
    await check(t, 'cp -r /tmp/copy /tmp/again')
    await check(t, 'find /tmp/again/sub', '/tmp/again/sub\n/tmp/again/sub/deep\n')
  })
})

describe('cp -rv announces each directory it makes and each file it copies', () => {
  it('names a directory once, when it is made', async () => {
    const t = terminal()
    await check(t, 'cp -rv a /tmp/copy', "'a' -> '/tmp/copy'\n'a/.hidden' -> '/tmp/copy/.hidden'\n'a/one' -> '/tmp/copy/one'\n'a/sub' -> '/tmp/copy/sub'\n'a/sub/deep' -> '/tmp/copy/sub/deep'\n'a/sub/deep/three' -> '/tmp/copy/sub/deep/three'\n'a/sub/two' -> '/tmp/copy/sub/two'\n")
  })

  it('says nothing of a directory already there', async () => {
    const t = terminal()
    await check(t, 'cp -r a /tmp/copy')
    await check(t, 'rm /tmp/copy/one')
    await check(t, 'cp -rv a/. /tmp/copy', "'a/./.hidden' -> '/tmp/copy/./.hidden'\n'a/./one' -> '/tmp/copy/./one'\n'a/./sub/deep/three' -> '/tmp/copy/./sub/deep/three'\n'a/./sub/two' -> '/tmp/copy/./sub/two'\n")
  })

  it('keeps the source spelling it was given', async () => {
    const t = terminal()
    await check(t, 'cp -rv a/sub /tmp/s', "'a/sub' -> '/tmp/s'\n'a/sub/deep' -> '/tmp/s/deep'\n'a/sub/deep/three' -> '/tmp/s/deep/three'\n'a/sub/two' -> '/tmp/s/two'\n")
  })
})

describe('cp -r refuses what GNU refuses', () => {
  it('will not copy a directory into itself', async () => {
    const t = terminal()
    await check(t, 'cp -r a /tmp/a')
    for (const [command, message] of [
      ['cp -r /tmp/a /tmp/a', "cp: cannot copy a directory, '/tmp/a', into itself, '/tmp/a/a'\n"],
      ['cp -r /tmp/a /tmp/a/inner', "cp: cannot copy a directory, '/tmp/a', into itself, '/tmp/a/inner'\n"],
      ['cp -r /tmp/a /tmp/a/sub/inner', "cp: cannot copy a directory, '/tmp/a', into itself, '/tmp/a/sub/inner'\n"],
    ]) {
      await check(t, command, '', message, 1)
    }
    // Nothing of the refused copy is left behind.
    check(t, 'find /tmp -type d', '/tmp\n/tmp/a\n/tmp/a/sub\n/tmp/a/sub/deep\n')
  })

  it('will not copy a directory onto itself', async () => {
    const t = terminal()
    await check(t, 'cp -r a /tmp/a')
    await check(t, 'cp -r /tmp/a/sub /tmp/a', '', "cp: '/tmp/a/sub' and '/tmp/a/sub' are the same file\n", 1)
    await check(t, 'cd /tmp; cp -r a .', '', "cp: 'a' and './a' are the same file\n", 1, '/tmp')
  })

  it('will not overwrite a file with a directory', async () => {
    const t = terminal()
    await check(t, 'printf x >/tmp/taken')
    await check(t, 'cp -r a /tmp/taken', '', "cp: cannot overwrite non-directory '/tmp/taken' with directory 'a'\n", 1)
    await check(t, 'cat /tmp/taken', 'x')
  })

  it('names a file in the way as a file, not as a loop', async () => {
    const t = terminal()
    await check(t, 'cp -r a /tmp/src')
    // The destination is under the source either way; what it already is
    // settles it first.
    check(t, 'cp -rT /tmp/src /tmp/src/one', '', "cp: cannot overwrite non-directory '/tmp/src/one' with directory '/tmp/src'\n", 1)
    await check(t, 'cp -r /tmp/src /tmp/src/one', '', "cp: cannot overwrite non-directory '/tmp/src/one' with directory '/tmp/src'\n", 1)
    await check(t, 'cat /tmp/src/one', '1\n')
    // A directory under the source is still the loop, and the source itself
    // is still the same file.
    check(t, 'cp -r /tmp/src /tmp/src/sub', '', "cp: cannot copy a directory, '/tmp/src', into itself, '/tmp/src/sub/src'\n", 1)
    await check(t, 'cp -r /tmp/src/sub /tmp/src', '', "cp: '/tmp/src/sub' and '/tmp/src/sub' are the same file\n", 1)
  })

  it('will not make a directory where there is no directory to make it in', async () => {
    const t = terminal()
    await check(t, 'cp -r a /tmp/missing/inner', '', "cp: cannot create directory '/tmp/missing/inner': No such file or directory\n", 1)
  })

  it('will not write outside the overlay', async () => {
    await check(terminal(), 'cp -r a /repo/copy', '', "cp: cannot create directory '/repo/copy': Read-only file system\n", 1)
    await check(terminal({ writable: false }), 'cp -r a /tmp/copy', '', "cp: cannot create directory '/tmp/copy': No such file or directory\n", 1)
  })

  it('still omits a directory without -r', async () => {
    await check(terminal(), 'cp a /tmp/copy', '', "cp: -r not specified; omitting directory 'a'\n", 1)
  })

  it('names a directory given twice as the directory it is', async () => {
    const t = terminal()
    await check(t, 'cp -r a a /tmp', '', "cp: warning: source directory 'a' specified more than once\n")
    await check(t, 'find /tmp -type f', '/tmp/a/.hidden\n/tmp/a/one\n/tmp/a/sub/deep/three\n/tmp/a/sub/two\n')
  })

  it('copies an operand that another operand contains, to both of its names', async () => {
    const t = terminal()
    await check(t, 'mkdir /tmp/dest')
    // The warning is for an operand repeated on the command line. `a/sub/two`
    // and `a` are two names with two destinations, so both are copied.
    check(t, 'cp -r a/sub/two a /tmp/dest')
    await check(t, 'find /tmp/dest -type f', '/tmp/dest/a/.hidden\n/tmp/dest/a/one\n/tmp/dest/a/sub/deep/three\n/tmp/dest/a/sub/two\n/tmp/dest/two\n')
  })

  it('copies overlapping directory operands in full', async () => {
    const t = terminal()
    await check(t, 'mkdir /tmp/dest')
    // GNU refuses the second copy of `a/sub` as a hard link it would rather
    // make than copy; nothing here is linked, so each name is copied for
    // itself and the tree the operands asked for is what comes out.
    check(t, 'cp -r a/sub a /tmp/dest')
    await check(t, 'find /tmp/dest -type f', '/tmp/dest/a/.hidden\n/tmp/dest/a/one\n/tmp/dest/a/sub/deep/three\n/tmp/dest/a/sub/two\n/tmp/dest/sub/deep/three\n/tmp/dest/sub/two\n')
  })

  it('still warns for one operand given twice, however it is spelled', async () => {
    const t = terminal()
    await check(t, 'cp -r a a /tmp', '', "cp: warning: source directory 'a' specified more than once\n")
    await check(t, 'mkdir /tmp/dest; cp -r a a/. /tmp/dest', '', "cp: warning: source directory 'a/.' specified more than once\n")
    await check(t, 'cp file file /tmp/dest', '', "cp: warning: source file 'file' specified more than once\n")
  })

  it('keeps copying the operands after one of them fails', async () => {
    const t = terminal()
    await check(t, 'cp -r a missing file /tmp', '', "cp: cannot stat 'missing': No such file or directory\n", 1)
    await check(t, 'find /tmp -type f', '/tmp/a/.hidden\n/tmp/a/one\n/tmp/a/sub/deep/three\n/tmp/a/sub/two\n/tmp/file\n')
  })
})

describe('cp -r keeps a copy inside the destination it was given', () => {
  it('names a source ending in .. after the target, as cp.c does', async () => {
    const sources = { 'base/source/f': 'x\n', 'base/sibling': 'sib\n' }
    const t = createTerminal(sources, { mount: '/repo', cwd: '/repo/base', writable: '/tmp/' })
    assert.equal((await t.run('mkdir /tmp/out')).exitCode, 0)
    const copied = await t.run('cp -rv source/.. /tmp/out')
    assert.equal(copied.stderr, '')
    assert.equal(copied.stdout, "'source/../sibling' -> '/tmp/out/./sibling'\n'source/../source' -> '/tmp/out/./source'\n'source/../source/f' -> '/tmp/out/./source/f'\n")
    // Everything lands under the target: `/tmp/out/..` would have climbed out.
    assert.equal((await t.run('find /tmp')).stdout, '/tmp\n/tmp/out\n/tmp/out/sibling\n/tmp/out/source\n/tmp/out/source/f\n')
  })

  it('merges two sources of the same name, with the second winning', async () => {
    const sources = { 'one/shared/a': 'first\n', 'two/shared/a': 'second\n', 'two/shared/only': 'kept\n' }
    const t = createTerminal(sources, { mount: '/repo', cwd: '/repo', writable: '/tmp/' })
    const copied = await t.run('cp -rv one/shared two/shared /tmp')
    assert.equal(copied.stderr, '')
    assert.equal(copied.exitCode, 0)
    assert.equal((await t.run('cat /tmp/shared/a /tmp/shared/only')).stdout, 'second\nkept\n')
  })

  it('still refuses two operands landing on one file', async () => {
    const sources = { 'one/a': 'first\n', 'two/a': 'second\n' }
    const t = createTerminal(sources, { mount: '/repo', cwd: '/repo', writable: '/tmp/' })
    const copied = await t.run('cp -r one/a two/a /tmp')
    assert.equal(copied.stderr, "cp: will not overwrite just-created '/tmp/a' with 'two/a'\n")
    assert.equal(copied.exitCode, 1)
    assert.equal((await t.run('cat /tmp/a')).stdout, 'first\n')
  })

  it('makes a destination spelled with a trailing slash', async () => {
    const t = terminal()
    await check(t, 'cp -rv a /tmp/new/', "'a' -> '/tmp/new/'\n'a/.hidden' -> '/tmp/new/.hidden'\n'a/one' -> '/tmp/new/one'\n'a/sub' -> '/tmp/new/sub'\n'a/sub/deep' -> '/tmp/new/sub/deep'\n'a/sub/deep/three' -> '/tmp/new/sub/deep/three'\n'a/sub/two' -> '/tmp/new/sub/two'\n")
    await check(t, 'cp -rT a /tmp/exact/')
    await check(t, 'find /tmp -type d', '/tmp\n/tmp/exact\n/tmp/exact/sub\n/tmp/exact/sub/deep\n/tmp/new\n/tmp/new/sub\n/tmp/new/sub/deep\n')
    // The same spelling on a directory that is there copies into it, as ever.
    check(t, 'cp -r a /tmp/new/')
    await check(t, 'find /tmp/new/a -type f', '/tmp/new/a/.hidden\n/tmp/new/a/one\n/tmp/new/a/sub/deep/three\n/tmp/new/a/sub/two\n')
  })

  it('names a destination reaching through a directory that is not there', async () => {
    const t = terminal()
    await check(t, 'cp -r a /tmp/src')
    // Lexically this normalizes inside the source, but the missing component
    // is what a caller needs told, not a loop that is not one.
    check(t, 'cp -r /tmp/src /tmp/src/missing/../copy', '', "cp: cannot create directory '/tmp/src/missing/../copy': No such file or directory\n", 1)
    await check(t, 'cp -r /tmp/src /tmp/other/missing/../copy', '', "cp: cannot create directory '/tmp/other/missing/../copy': No such file or directory\n", 1)
    // A destination that does resolve inside the source is still the loop.
    check(t, 'cp -r /tmp/src /tmp/src/sub/../inner', '', "cp: cannot copy a directory, '/tmp/src', into itself, '/tmp/src/sub/../inner'\n", 1)
    await check(t, 'find /tmp -type d', '/tmp\n/tmp/src\n/tmp/src/sub\n/tmp/src/sub/deep\n')
  })

  it('refuses verbose output written into a tree it is copying, before making any of it', async () => {
    const t = terminal()
    await check(t, 'cp -r a /tmp/src')
    const refused = await t.run('cp -rv /tmp/src /tmp/dest >/tmp/src/one')
    assert.equal(refused.exitCode, 1)
    assert.deepEqual(refused.unsupported.map(({ detail }) => detail), ['copy output buffering'])
    // The redirect truncated the file; nothing was written to it after that.
    check(t, 'cat /tmp/src/one', '')
    await check(t, 'test -e /tmp/dest', '', '', 1)
  })

  it('refuses it for the destination tree as well', async () => {
    const t = terminal()
    await check(t, 'cp -r a /tmp/src; mkdir /tmp/dest; cp -r /tmp/src /tmp/dest')
    // The copy overwrites /tmp/dest/src/one, which is where the verbose output
    // of this very command would go.
    const refused = await t.run('cp -rv /tmp/src /tmp/dest >/tmp/dest/src/one')
    assert.equal(refused.exitCode, 1)
    assert.deepEqual(refused.unsupported.map(({ detail }) => detail), ['copy output buffering'])
    await check(t, 'cat /tmp/dest/src/one', '')
  })

  it('leaves a destination file no source entry names alone', async () => {
    const t = terminal()
    await check(t, 'cp -r a/. /tmp/dest; printf EXTRA >/tmp/dest/extra')
    // Nothing under `a` is named `extra`, so this copy neither reads nor writes
    // it and there is no ordering to be unsure about: GNU's buffer meets no
    // file of its own, and the lines land in `extra` when it flushes at exit.
    const lines = (await t.run('cp -rv a/. /tmp/dest')).stdout
    assert.ok(lines.includes("'a/./one' -> '/tmp/dest/./one'"), lines)
    await check(t, 'cp -rv a/. /tmp/dest >/tmp/dest/extra')
    await check(t, 'cat /tmp/dest/extra', lines)
    await check(t, 'cat /tmp/dest/one', '1\n')
    // A destination file a source entry does name is still refused: what a
    // caller would read back there depends on when the buffer was flushed.
    const refused = await t.run('cp -rv a/. /tmp/dest >/tmp/dest/one')
    assert.deepEqual(refused.unsupported.map(({ detail }) => detail), ['copy output buffering'])
    await check(t, 'cat /tmp/dest/one', '')
  })

  it('lets a refusal that needs no output answer before the buffering one', async () => {
    const t = terminal()
    await check(t, 'cp -r a /tmp/src')
    // These refuse before anything is made or announced, so what GNU would
    // have buffered never arises and the ordinary diagnostic stands.
    check(t, 'cp -rvT /tmp/src /tmp/src >/tmp/src/one', '', "cp: '/tmp/src' and '/tmp/src' are the same file\n", 1)
    await check(t, 'cp -rv /tmp/src /tmp/src >/tmp/src/one', '', "cp: cannot copy a directory, '/tmp/src', into itself, '/tmp/src/src'\n", 1)
    await check(t, 'cp -rv /tmp/src/sub /tmp/src >/tmp/src/one', '', "cp: '/tmp/src/sub' and '/tmp/src/sub' are the same file\n", 1)
    // The redirect truncated the file; nothing wrote to it after that.
    check(t, 'cat /tmp/src/one', '')
  })

  it('lets a destination it cannot make answer before the buffering one', async () => {
    const t = terminal()
    await check(t, 'cp -r a /tmp/src')
    // GNU announces a directory only where it makes one, so a destination it
    // cannot make emits no verbose line and there is nothing to be unsure
    // about — the read-only answer is the whole of it, redirect or no.
    check(t, 'cp -rv /tmp/src /repo/new >/tmp/src/one', '', "cp: cannot create directory '/repo/new': Read-only file system\n", 1)
    await check(t, 'cp -rv /tmp/src /repo/new', '', "cp: cannot create directory '/repo/new': Read-only file system\n", 1)
    await check(t, 'cat /tmp/src/one', '')
    // A destination it *can* make still refuses, since that line would be
    // written into a file this copy reads.
    const refused = await t.run('cp -rv /tmp/src /tmp/dest >/tmp/src/one')
    assert.deepEqual(refused.unsupported.map(({ detail }) => detail), ['copy output buffering'])
    await check(t, 'test -e /tmp/dest', '', '', 1)
  })

  it('refuses nothing when -n leaves every copy undone', async () => {
    const t = terminal()
    await check(t, 'cp -r a /tmp/dest')
    // Every name is already there, so nothing is copied and nothing is
    // announced: there is no buffered line to be unsure about.
    check(t, 'cp -rvn a/. /tmp/dest >/tmp/dest/one')
    await check(t, 'cat /tmp/dest/one', '')
    await check(t, 'cat /tmp/dest/sub/two', '2\n')
  })

  it('leaves alone what -n will not overwrite', async () => {
    const t = terminal()
    const setup = 'mkdir /tmp/d; printf OLD >/tmp/d/one'
    await check(t, setup)
    // `-n` passes over `one`, so this copy neither reads nor writes it and a
    // descriptor on it meets nothing of the copy's: GNU copies the rest and
    // the lines land there when the buffer flushes at exit.
    const lines = (await terminal().run(`${setup}; cp -rvn a/. /tmp/d`)).stdout
    assert.ok(lines.includes("'a/./sub/two' -> '/tmp/d/./sub/two'") && !lines.includes("/tmp/d/./one"), lines)
    await check(t, 'cp -rvn a/. /tmp/d >/tmp/d/one')
    await check(t, 'cat /tmp/d/one', lines)
    await check(t, 'cat /tmp/d/sub/two', '2\n')
    // Without -n the same name is overwritten, and that is still refused.
    const refused = await terminal().run(`${setup}; cp -rv a/. /tmp/d >/tmp/d/one`)
    assert.deepEqual(refused.unsupported.map(({ detail }) => detail), ['copy output buffering'])
  })

  it('leaves an entry that is refused before it is opened out of the overlap', async () => {
    const setup = 'cp -r a /tmp/s; mkdir -p /tmp/d/one'
    const t = terminal()
    await check(t, setup)
    // `/tmp/d/one` is a directory, so that entry is refused before either name
    // is opened; a descriptor on it meets nothing this copy does, and the rest
    // of the tree is copied with its lines landing there, as GNU has it.
    const lines = (await terminal().run(`${setup}; cp -rv /tmp/s/. /tmp/d`)).stdout
    assert.ok(lines.includes("'/tmp/s/./sub/two' -> '/tmp/d/./sub/two'") && !lines.includes("'/tmp/d/./one'"), lines)
    await check(t, 'cp -rv /tmp/s/. /tmp/d >/tmp/s/one', '', "cp: cannot overwrite directory '/tmp/d/./one' with non-directory '/tmp/s/./one'\n", 1)
    await check(t, 'cat /tmp/s/one', lines)
    await check(t, 'cat /tmp/d/sub/two', '2\n')
    // A descriptor on an entry that is copied still refuses.
    const refused = await terminal().run(`${setup}; cp -rv /tmp/s/. /tmp/d >/tmp/s/sub/two`)
    assert.deepEqual(refused.unsupported.map(({ detail }) => detail), ['copy output buffering'])
  })

  it('leaves an operand refused before the walk out of the overlap', async () => {
    const t = terminal()
    await check(t, 'mkdir -p /tmp/s/inside /tmp/dest; printf OUT >/tmp/s/out')
    // `/tmp/s` names a destination under itself, so it is refused before it is
    // listed and nothing below it is opened — including the descriptor's file.
    // The operand beside it is copied and announced, as GNU announces it.
    check(t, 'cp -rv file /tmp/s /tmp/s/inside >/tmp/s/out', '', "cp: cannot copy a directory, '/tmp/s', into itself, '/tmp/s/inside/s'\n", 1)
    await check(t, 'cat /tmp/s/out', "'file' -> '/tmp/s/inside/file'\n")
    await check(t, 'cat /tmp/s/inside/file', 'plain\n')
    // The same operand against a destination it can be walked into refuses,
    // since `out` is then one of the files it reads.
    const refused = await t.run('cp -rv file /tmp/s /tmp/dest >/tmp/s/out')
    assert.deepEqual(refused.unsupported.map(({ detail }) => detail), ['copy output buffering'])
    await check(t, 'find /tmp/dest', '/tmp/dest\n')
  })

  it('sees a source an earlier operand has yet to make', async () => {
    const t = createTerminal({ 's/x': 'X\n' }, { mount: '/repo', cwd: '/tmp', writable: '/tmp/' })
    await check2(t, 'cp -r /repo/s /tmp/s; mkdir -p /tmp/d/s')
    // `/tmp/d/s/x` is not there when the command starts; the first operand
    // makes it, and the second copies it onto the descriptor's own file. GNU
    // ends with its buffered lines there instead of the copied bytes, which is
    // the ordering this refuses to invent.
    const refused = await t.run('cp -rv s /tmp/d/s/x /tmp/d >/tmp/d/x')
    assert.deepEqual(refused.unsupported.map(({ detail }) => detail), ['copy output buffering'])
    await check2(t, 'cat /tmp/d/x', '')
  })

  it('leaves a source spelled twice out of the overlap', async () => {
    const t = createTerminal({ 's/a': 'A\n', 's/sub/b': 'B\n' }, { mount: '/repo', cwd: '/tmp', writable: '/tmp/' })
    await check2(t, 'cp -r /repo/s /tmp/s; mkdir /tmp/d')
    // `s/sub/..` is `s` again, so cp warns instead of copying it — even though
    // that spelling would land in `/tmp/d` itself and take the descriptor's
    // name with it. The first spelling copies into `/tmp/d/s`, which does not.
    const lines = "'s' -> '/tmp/d/s'\n's/a' -> '/tmp/d/s/a'\n's/sub' -> '/tmp/d/s/sub'\n's/sub/b' -> '/tmp/d/s/sub/b'\n"
    const result = await t.run('cp -rv s s/sub/.. /tmp/d >/tmp/d/a')
    assert.deepEqual(result.unsupported, [])
    assert.equal(result.stderr, "cp: warning: source directory 's/sub/..' specified more than once\n")
    await check2(t, 'cat /tmp/d/a', lines)
    await check2(t, 'find /tmp/d -type f', '/tmp/d/a\n/tmp/d/s/a\n/tmp/d/s/sub/b\n')
  })

  it('sees a descriptor a backup name put inside the tree', async () => {
    const t = createTerminal({ x: 'x\n' }, { mount: '/repo', cwd: '/tmp', writable: '/tmp/' })
    const run = (command) => t.run(command)
    assert.equal((await run('mkdir tree; printf original >out')).exitCode, 0)
    // `sed -i` renames what `out` held into the tree, so the descriptor opened
    // on `out` now points at a file inside `tree` under another name. Lexically
    // it is nowhere near it; by inode it is one of the files about to be copied.
    const refused = await run("{ sed -i'tree/*' s/x/y/ out; cp -rv tree dest; } >out")
    assert.deepEqual(refused.unsupported.map(({ detail }) => detail), ['copy output buffering'])
    assert.equal((await run('test -e dest')).exitCode, 1)
    // The redirect truncated that inode before sed renamed it into the tree,
    // and the refusal came before any verbose line, so it is still empty —
    // without the guard it would hold this command's own diagnostics.
    assert.equal((await run('cat tree/out')).stdout, '')
  })

  it('leaves a descriptor outside both trees alone', async () => {
    const t = terminal()
    await check(t, 'cp -r a /tmp/src')
    await check(t, 'cp -rv /tmp/src /tmp/dest >/tmp/log')
    await check(t, 'cat /tmp/log', "'/tmp/src' -> '/tmp/dest'\n'/tmp/src/.hidden' -> '/tmp/dest/.hidden'\n'/tmp/src/one' -> '/tmp/dest/one'\n'/tmp/src/sub' -> '/tmp/dest/sub'\n'/tmp/src/sub/deep' -> '/tmp/dest/sub/deep'\n'/tmp/src/sub/deep/three' -> '/tmp/dest/sub/deep/three'\n'/tmp/src/sub/two' -> '/tmp/dest/sub/two'\n")
  })
})

describe('a copied tree reads back like any other directory', () => {
  const copied = async () => {
    const t = terminal()
    assert.equal((await t.run('cp -r a /tmp/copy')).exitCode, 0)
    return t
  }

  it('lists, walks and measures', async () => {
    const t = await copied()
    const listed = await t.run('ls /tmp/copy')
    assert.equal(listed.stdout, 'one\nsub\n')
    assert.deepEqual(listed.notes, ['ls: omitted 1 hidden entry: "/tmp/copy/.hidden". Hidden entries are included with -a.'])
    await check(t, 'ls -a /tmp/copy', '.\n..\n.hidden\none\nsub\n')
    await check(t, 'ls /tmp', 'copy\n')
    await check(t, 'find /tmp/copy -type d', '/tmp/copy\n/tmp/copy/sub\n/tmp/copy/sub/deep\n')
    await check(t, 'du -b /tmp/copy/sub', '2\t/tmp/copy/sub/deep\n4\t/tmp/copy/sub\n')
    await check(t, 'wc -l /tmp/copy/one', '1 /tmp/copy/one\n')
  })

  it('searches and globs', async () => {
    const t = await copied()
    await check(t, 'grep -rn 2 /tmp/copy', '/tmp/copy/sub/two:1:2\n')
    await check(t, 'echo /tmp/copy/sub/*', '/tmp/copy/sub/deep /tmp/copy/sub/two\n')
    await check(t, 'cat /tmp/copy/sub/t*', '2\n')
    await check(t, 'cat /tmp/copy/sub/deep/*', '3\n')
  })

  it('takes writes, edits and removals inside it', async () => {
    const t = await copied()
    await check(t, 'printf added >/tmp/copy/sub/new; cat /tmp/copy/sub/new', 'added')
    await check(t, "sed -i 's/1/one/' /tmp/copy/one; cat /tmp/copy/one", 'one\n')
    await check(t, 'rm /tmp/copy/sub/new')
    await check(t, 'test -e /tmp/copy/sub/new', '', '', 1)
  })

  it('refuses to remove a directory, as rm does anywhere', async () => {
    const t = await copied()
    await check(t, 'rm /tmp/copy/sub', '', "rm: cannot remove '/tmp/copy/sub': Is a directory\n", 1)
  })

  it('is a directory to the shell, to cd and to test', async () => {
    const t = await copied()
    await check(t, 'test -d /tmp/copy/sub && echo yes', 'yes\n')
    await check(t, 'cd /tmp/copy/sub; pwd; cat two', '/tmp/copy/sub\n2\n', '', 0, '/tmp/copy/sub')
    await check(t, 'test -f /tmp/copy/sub', '', '', 1, '/tmp/copy/sub')
  })
})
