import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Checked against GNU coreutils 9.4: which name a link gets, what a directory
// operand means under -T and -n, what -f replaces and refuses, and what
// symlink(2) says of a name that is taken, that has no parent, or that lies
// under something that is not a directory.
const SOURCES = { file: 'plain\n', 'dir/leaf': 'leaf\n', srclink: { type: 'link', target: 'file' } }
const terminal = (options = {}) => createTerminal(SOURCES, { mount: '/repo', cwd: '/tmp', writable: '/tmp/', ...options })

function check(t, command, stdout = '', stderr = '', exitCode = 0, cwd = '/tmp') {
  assert.deepEqual(t.run(command), { stdout, stderr, exitCode, cwd, notes: [], unsupported: [] }, command)
}
const fails = (t, command, stderr, stdout = '') => check(t, command, stdout, stderr, 1)

describe('ln -s makes a symbolic link in the writable overlay', () => {
  it('holds the target as written, and everything else reads it as a link', () => {
    const t = terminal()
    check(t, 'ln -s /repo/file link')
    check(t, 'test -L link && echo yes', 'yes\n')
    check(t, 'cat link', 'plain\n')
    check(t, 'find /tmp -type l', '/tmp/link\n')
    check(t, 'stat -c %F link', 'symbolic link\n')
    check(t, 'realpath link', '/repo/file\n')
    check(t, 'ls -F', 'link@\n')
    assert.match(t.run('ls -l link').stdout, /^lrwxrwxrwx 1 user user 10 .* link -> \/repo\/file\n$/u)
    check(t, 'du link; du -b link', '0\tlink\n10\tlink\n')
  })

  it('resolves a relative target from the directory the link is in, whether or not it leads anywhere', () => {
    const t = terminal()
    check(t, 'mkdir sub; ln -s ../../repo/file sub/link; cat sub/link', 'plain\n')
    check(t, 'ln -s ../nowhere sub/gone; test -L sub/gone && echo link; test -e sub/gone || echo dangling', 'link\ndangling\n')
    fails(t, 'cat sub/gone', 'cat: sub/gone: No such file or directory\n')
    // A link to a link is followed in turn, as the kernel follows it.
    check(t, 'ln -s /repo/srclink twice; cat twice', 'plain\n')
  })

  it('makes the link in the current directory when given the target alone', () => {
    const t = terminal()
    check(t, 'ln -s /repo/dir/leaf; cat leaf', 'leaf\n')
    check(t, 'ln -sv /repo/file', "'./file' -> '/repo/file'\n")
    fails(t, 'ln -s /repo/file', "ln: failed to create symbolic link './file': File exists\n")
    check(t, 'ln -s /repo/dir/; ls', 'dir\nfile\nleaf\n')
  })

  it("takes a directory operand as where the link goes, under the target's last component", () => {
    const t = terminal()
    check(t, 'mkdir d; ln -s /repo/file d; ln -s /repo/dir/ d/; ln -s a b d; find /tmp/d -type l', '/tmp/d/a\n/tmp/d/b\n/tmp/d/dir\n/tmp/d/file\n')
    check(t, 'ln -s -t d /repo/dir/leaf; cat d/leaf', 'leaf\n')
    check(t, 'ln -sv --target-directory=d /repo/srclink', "'d/srclink' -> '/repo/srclink'\n")
    fails(t, 'ln -s /repo/file d', "ln: failed to create symbolic link 'd/file': File exists\n")
    fails(t, 'ln -s x y missing', "ln: target 'missing': No such file or directory\n")
    fails(t, 'ln -s x y /repo/file', "ln: target '/repo/file': Not a directory\n")
    fails(t, 'ln -st missing x', "ln: failed to access 'missing': No such file or directory\n")
    fails(t, 'ln -st /repo/file x', "ln: target '/repo/file' is not a directory\n")
    // Every operand is tried, and one failing does not stop the next.
    fails(t, 'ln -s /repo/file nowhere d', "ln: failed to create symbolic link 'd/file': File exists\n")
    check(t, 'test -L d/nowhere && echo yes', 'yes\n')
  })

  it('-T names the link itself, and -n keeps a link to a directory from standing for it', () => {
    const t = terminal()
    check(t, 'mkdir d; ln -s d dl')
    // Without -n a link to `d` is the directory it leads to, so the new link
    // lands inside `d`; with it the name is the link, and a name taken.
    check(t, 'ln -s /repo/file dl; find /tmp/d -type l', '/tmp/d/file\n')
    fails(t, 'ln -sn /repo/file dl', "ln: failed to create symbolic link 'dl': File exists\n")
    fails(t, 'ln -sT /repo/file d', "ln: failed to create symbolic link 'd': File exists\n")
    check(t, 'ln -sfn /repo/file dl; cat dl', 'plain\n')
    fails(t, 'ln -sT x y z', "ln: extra operand 'z'\n")
    fails(t, 'ln -sT x', "ln: missing destination file operand after 'x'\n")
    fails(t, 'ln -s -t d -T x', 'ln: cannot combine --target-directory and --no-target-directory\n')
  })

  it('-f replaces a file or a link, and refuses a directory', () => {
    const t = terminal()
    check(t, 'printf old > f; ln -s nowhere l; ln -sf /repo/file f; ln -sf /repo/file l; cat f l', 'plain\nplain\n')
    fails(t, 'ln -s /repo/file f', "ln: failed to create symbolic link 'f': File exists\n")
    check(t, 'ln -sfv /repo/dir/leaf f', "'f' -> '/repo/dir/leaf'\n")
    check(t, 'ln --symbolic --force --verbose /repo/file f', "'f' -> '/repo/file'\n")
    check(t, 'mkdir d')
    fails(t, 'ln -sfT /repo/file d', 'ln: d: cannot overwrite directory\n')
    // A name the sources hold is read-only, -f or not.
    fails(t, 'ln -sf /repo/file /repo/dir/leaf', "ln: failed to create symbolic link '/repo/dir/leaf': Read-only file system\n")
  })

  it('-r writes the target relative to the link', () => {
    const t = terminal()
    check(t, 'mkdir -p d/sub; ln -srv /repo/file d/sub/f', "'d/sub/f' -> '../../../repo/file'\n")
    check(t, 'cat d/sub/f', 'plain\n')
    check(t, 'ln -sr d d/self; realpath d/self', '/tmp/d\n')
    assert.match(t.run('ls -l d/self').stdout, / d\/self -> \.\n$/u)
    // The target is taken as far as it leads, through the links on the way.
    check(t, 'ln -s /repo/dir dl; ln -srv dl/leaf d/l', "'d/l' -> '../../repo/dir/leaf'\n")
    fails(t, 'ln -r /repo/file x', 'ln: cannot do --relative without --symbolic\n')
  })

  it('reports what symlink(2) would', () => {
    const t = terminal()
    fails(t, 'ln -s x /tmp/missing/y', "ln: failed to create symbolic link '/tmp/missing/y': No such file or directory\n")
    fails(t, 'ln -s x /repo/file/y', "ln: failed to create symbolic link '/repo/file/y': Not a directory\n")
    fails(t, 'ln -s x newdir/', "ln: failed to create symbolic link 'newdir/': No such file or directory\n")
    fails(t, 'ln -s x /repo/file/', "ln: failed to create symbolic link '/repo/file/': File exists\n")
    fails(t, 'ln -s nowhere gone; ln -s x gone/y', "ln: failed to create symbolic link 'gone/y': No such file or directory\n")
    fails(t, "ln -s '' e", "ln: failed to create symbolic link 'e' -> '': No such file or directory\n")
    fails(t, "ln -s x ''", "ln: failed to create symbolic link '': No such file or directory\n")
    fails(t, 'ln -s x /repo/new', "ln: failed to create symbolic link '/repo/new': Read-only file system\n")
    fails(t, 'ln -s x /repo/file', "ln: failed to create symbolic link '/repo/file': File exists\n")
    fails(t, 'ln -s x /repo/srclink', "ln: failed to create symbolic link '/repo/srclink': File exists\n")
    fails(t, 'ln -s', 'ln: missing file operand\n')
    fails(t, 'ln', 'ln: missing file operand\n')
    check(t, 'ls /tmp', 'gone\n')
  })

  it('is refused without an overlay, and for the hard link it makes without -s', () => {
    const t = createTerminal(SOURCES, { mount: '/repo', cwd: '/repo' })
    check(t, 'ln -s file link', '', "ln: failed to create symbolic link 'link': Read-only file system\n", 1, '/repo')
    for (const command of ['ln /repo/file hard', 'ln -L /repo/file hard']) {
      const r = terminal().run(command)
      assert.deepEqual(r.unsupported.map((u) => [u.kind, u.command, u.detail]), [['feature', 'ln', 'hard link']], command)
      assert.equal(r.stderr, "ln: hard links are not supported: '/repo/file' (ln -s makes a symbolic one)\n", command)
      assert.notEqual(r.exitCode, 0, command)
    }
    for (const command of ['ln -si /repo/file x', 'ln -sb /repo/file x', 'ln -s --backup /repo/file x']) {
      const r = terminal().run(command)
      assert.equal(r.unsupported[0]?.kind, 'option', command)
      assert.notEqual(r.exitCode, 0, command)
    }
  })
})

describe('a link ln made is a name the rest of the overlay answers for', () => {
  it('rm takes the link away and leaves what it points at', () => {
    const t = terminal()
    check(t, 'ln -s /repo/file link; rm link; ls; cat /repo/file', 'plain\n')
    check(t, 'mkdir d; ln -s /repo/dir d/l; ln -s d dl; rm -r dl; ls', 'd\n')
    check(t, 'rm -rv d', "removed 'd/l'\nremoved directory 'd'\n")
  })

  it('writes land where the link leads', () => {
    const t = terminal()
    check(t, 'ln -s /tmp/out link; echo x > link; cat /tmp/out', 'x\n')
    check(t, 'mkdir d; ln -s d dl; mkdir -p dl/sub; touch dl/f; cp /repo/file dl/c; find /tmp/d', '/tmp/d\n/tmp/d/c\n/tmp/d/f\n/tmp/d/sub\n')
    fails(t, 'mkdir dl', "mkdir: cannot create directory 'dl': File exists\n")
    fails(t, 'echo x > dl', 'error: dl: Is a directory\n')
  })

  it('sed -i writes a file over the link, and keeps the link as the backup', () => {
    const t = terminal()
    check(t, 'ln -s /repo/file link; sed -i.bak s/plain/edited/ link; cat link /repo/file; test -L link.bak && test -f link && echo split', 'edited\nplain\nsplit\n')
    check(t, 'ln -s /repo/file again; sed -i s/plain/changed/ again; cat again; test -L again || echo file', 'changed\nfile\n')
  })

  it('a copy of a tree holding one is still refused, since cp makes no link', () => {
    const t = terminal()
    check(t, 'mkdir d; ln -s /repo/file d/link')
    const r = t.run('cp -r d e')
    assert.deepEqual(r.unsupported.map((u) => u.detail), ['symbolic link'])
    assert.equal(r.stderr, 'cp: copying a symbolic link is not supported: d/link (a recursive copy keeps the link, which cp does not make here)\n')
  })
})
