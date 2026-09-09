import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU copy.c: same-file rejection, no-clobber precedence, duplicate-source
// warnings, and protecting targets already copied during this invocation.
// https://www.gnu.org/software/coreutils/manual/html_node/cp-invocation.html
// https://github.com/coreutils/coreutils/blob/v9.11/src/copy.c
const SOURCES = { a: 'alpha\n', b: 'beta\0😀', empty: '', 'dir/leaf': 'leaf', 'one/shared': 'first', 'two/shared': 'second', '-f': 'literal', bad: '\uD800' }
const terminal = (options = {}) => createTerminal(SOURCES, { mount: '/repo', cwd: '/repo', writable: '/tmp/', ...options })
const expected = (stdout = '', stderr = '', exitCode = 0) => ({ stdout, stderr, exitCode, cwd: '/repo', unsupported: [] })
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'"

function check(t, command, stdout = '', stderr = '', exitCode = 0) {
  assert.deepEqual(t.run(command), expected(stdout, stderr, exitCode), command)
}

describe('cp copies regular files into the writable filesystem', () => {
  for (const [command, file] of [
    ['cp a /tmp/copy', '/tmp/copy'], ['cp /repo/a /tmp/copy', '/tmp/copy'],
    ['cp ./a ../tmp/copy', '/tmp/copy'], ['cp a /tmp', '/tmp/a'], ['cp a /tmp/', '/tmp/a'],
    ['cp -t /tmp a', '/tmp/a'], ['cp -t/tmp a', '/tmp/a'], ['cp a --target-directory=/tmp', '/tmp/a'],
    ['cp -T a /tmp/copy', '/tmp/copy'], ['cp --no-target-directory a /tmp/copy', '/tmp/copy'],
    ['cp -f a /tmp/copy', '/tmp/copy'], ['cp --force a /tmp/copy', '/tmp/copy'],
  ]) {
    it(command, () => {
      const t = terminal()
      check(t, command)
      check(t, `cat ${file}`, 'alpha\n')
      check(t, 'cat a', 'alpha\n')
    })
  }

  it('copies multiple operands and preserves Unicode, NUL and empty content', () => {
    const t = terminal()
    check(t, 'cp a b empty /tmp')
    check(t, 'cat /tmp/a /tmp/b /tmp/empty', 'alpha\nbeta\0😀')
    check(t, 'ls /tmp', 'a\nb\nempty\n')
    assert.deepEqual(t.complete('cat /tmp/e'), ['cat /tmp/empty'])
  })

  it('copies globs and names beginning with an option prefix', () => {
    const t = terminal()
    check(t, 'cp -- -f /tmp/dash; cp one/* /tmp')
    check(t, 'cat /tmp/dash /tmp/shared', 'literalfirst')
    assert.deepEqual(t.run('cat a'), expected('alpha\n'))
  })

  it('overwrites rather than appending and leaves the source independent', () => {
    const t = terminal()
    check(t, 'printf longer-content >/tmp/out; cp a /tmp/out')
    check(t, 'cat /tmp/out', 'alpha\n')
    check(t, 'cp /tmp/out /tmp/second; printf changed >/tmp/out')
    check(t, 'cat /tmp/second a', 'alpha\nalpha\n')
  })

  it('preserves existing destination inode identity for open descriptors', () => {
    const t = terminal()
    check(t, 'printf old >/tmp/out; { cp a /tmp/out; printf extra; } >>/tmp/out')
    check(t, 'cat /tmp/out', 'alpha\nextra')
  })

  it('works through find and xargs dispatch without consuming their stdin again', () => {
    const t = terminal()
    check(t, "find dir -type f -exec cp {} /tmp ';'")
    check(t, 'printf "a b" | xargs cp -t /tmp')
    check(t, 'cat /tmp/leaf /tmp/a /tmp/b', 'leafalpha\nbeta\0😀')
    check(t, 'printf retained | { cp a /tmp/copy; cat; }', 'retained')
  })
})

describe('cp no-clobber, verbosity, and multi-source conflicts', () => {
  for (const flag of ['-n', '--no-clobber', '-fn', '-nf', '--force --no-clobber']) {
    it(`${flag} skips an existing destination successfully`, () => {
      const t = terminal()
      check(t, `printf old >/tmp/out; cp ${flag} -v a /tmp/out`)
      check(t, 'cat /tmp/out', 'old')
      check(t, `cp ${flag} bad /tmp/out`)
      check(t, `cp ${flag} a a`)
    })
  }

  it('creates a missing destination with no-clobber', () => {
    const t = terminal()
    check(t, 'cp -nv a /tmp/out', "'a' -> '/tmp/out'\n")
    check(t, 'cat /tmp/out', 'alpha\n')
  })

  it('prints verbose paths before an ordinary copy failure', () => {
    check(terminal(), 'cp --verbose a /repo/new', "'a' -> '/repo/new'\n", "cp: cannot create regular file '/repo/new': Read-only file system\n", 1)
  })

  it('does not overwrite a target produced by an earlier source with the same basename', () => {
    const t = terminal()
    check(t, 'cp -v one/shared two/shared /tmp', "'one/shared' -> '/tmp/shared'\n", "cp: will not overwrite just-created '/tmp/shared' with 'two/shared'\n", 1)
    check(t, 'cat /tmp/shared', 'first')
  })

  it('no-clobber silently skips a colliding later source', () => {
    const t = terminal()
    check(t, 'cp -nv one/shared two/shared /tmp', "'one/shared' -> '/tmp/shared'\n")
    check(t, 'cat /tmp/shared', 'first')
  })

  it('warns about an identical repeated source without making success fail', () => {
    const t = terminal()
    check(t, 'cp -v a a /tmp', "'a' -> '/tmp/a'\n", "cp: warning: source file 'a' specified more than once\n")
    check(t, 'cat /tmp/a', 'alpha\n')
  })

  it('recognizes different path spellings of the same repeated source', () => {
    const t = terminal()
    check(t, 'cp -v a ./a /repo//a /tmp', "'a' -> '/tmp/a'\n", "cp: warning: source file './a' specified more than once\ncp: warning: source file '/repo//a' specified more than once\n")
    check(t, 'cat /tmp/a', 'alpha\n')
  })

  it('flushes verbose output before opening the source', () => {
    const t = terminal()
    check(t, 'printf old >/tmp/source')
    check(t, 'cp -v /tmp/source /tmp/dest >>/tmp/source')
    const content = "old'/tmp/source' -> '/tmp/dest'\n"
    check(t, 'cat /tmp/source /tmp/dest', content.repeat(2))
  })

  it('truncates verbose output written into the destination before copying', () => {
    const t = terminal()
    check(t, 'cp -v a /tmp/out >/tmp/out')
    check(t, 'cat /tmp/out', 'alpha\n')
  })

  it('quotes unusual filenames consistently with other file commands', () => {
    const name = 'a\nspace \'quote'
    const t = createTerminal({ [name]: 'content' }, { mount: '/repo', cwd: '/repo', writable: '/tmp/' })
    const r = t.run(`cp -v ${quote(name)} /tmp/out`)
    assert.equal(r.exitCode, 0)
    assert.equal(r.stderr, '')
    assert.deepEqual(r.unsupported, [])
    assert.equal(r.stdout.split('\n').length, 2)
    assert.match(r.stdout, /\\n/u)
    check(t, 'cat /tmp/out', 'content')
  })
})

describe('cp reports ordinary path, operand, and read-only failures', () => {
  const cases = [
    ['cp', 'missing file operand'], ['cp a', "missing destination file operand after 'a'"],
    ['cp -T a b /tmp/out', "extra operand '/tmp/out'"],
    ['cp -t /tmp -T a b', 'cannot combine --target-directory (-t) and --no-target-directory (-T)'],
    ['cp -t /tmp -t /repo a', 'multiple target directories specified'],
    ['cp -t /missing a', "target directory '/missing': No such file or directory"],
    ['cp -t a b', "target directory 'a': Not a directory"],
    ['cp a b /tmp/missing', "target '/tmp/missing': No such file or directory"],
    ['cp a b /repo/a', "target '/repo/a': Not a directory"],
    ['cp missing /tmp/out', "cannot stat 'missing': No such file or directory"],
    ['cp a/../b /tmp/out', "cannot stat 'a/../b': Not a directory"],
    ['cp a/ /tmp/out', "cannot stat 'a/': Not a directory"],
    ['cp dir /tmp/out', "-r not specified; omitting directory 'dir'"],
    ['cp -T a /tmp', "cannot overwrite directory '/tmp' with non-directory 'a'"],
    ['cp a /repo/new', "cannot create regular file '/repo/new': Read-only file system"],
    ['cp a /tmp/../repo/new', "cannot create regular file '/tmp/../repo/new': Read-only file system"],
    ['cp -f a /repo/b', "cannot remove '/repo/b': Read-only file system"],
    ['cp a /tmp/no/leaf', "cannot create regular file '/tmp/no/leaf': No such file or directory"],
    ['cp a /tmp/no/', "cannot create regular file '/tmp/no/': No such file or directory"],
    ["cp a ''", "cannot create regular file '': No such file or directory"],
    ['cp a ./a', "'a' and './a' are the same file"],
  ]
  for (const [command, error] of cases) it(command, () => check(terminal(), command, '', 'cp: ' + error + '\n', 1))

  it('reports self-copy without truncating even when forced', () => {
    const t = terminal()
    check(t, 'cp a /tmp/out')
    check(t, 'cp -fv /tmp/out /tmp/./out', '', "cp: '/tmp/out' and '/tmp/./out' are the same file\n", 1)
    check(t, 'cat /tmp/out', 'alpha\n')
  })

  it('continues copying later sources after a missing source or directory', () => {
    const t = terminal()
    check(t, 'cp -v missing a dir b /tmp', "'a' -> '/tmp/a'\n'b' -> '/tmp/b'\n", "cp: cannot stat 'missing': No such file or directory\ncp: -r not specified; omitting directory 'dir'\n", 1)
    check(t, 'cat /tmp/a /tmp/b', 'alpha\nbeta\0😀')
  })

  it('leaves disabled and mounted source files read-only with ordinary errors', () => {
    const t = terminal({ writable: false })
    check(t, 'cp a /repo/new', '', "cp: cannot create regular file '/repo/new': Read-only file system\n", 1)
    check(t, 'cp -n a b')
    assert.deepEqual(SOURCES, { a: 'alpha\n', b: 'beta\0😀', empty: '', 'dir/leaf': 'leaf', 'one/shared': 'first', 'two/shared': 'second', '-f': 'literal', bad: '\uD800' })
  })
})

describe('cp unsupported features and write guards retain diagnostics', () => {
  for (const option of ['-r', '-R', '--recursive', '-a', '-p', '-i', '--parents', '--preserve', '--reflink', '--remove-destination']) {
    it(option, () => {
      const t = terminal()
      const r = t.run(`cp ${option} a /tmp/out 2>/dev/null | cat`)
      assert.equal(r.stdout, '')
      assert.equal(r.stderr, '')
      assert.equal(r.exitCode, 0)
      assert.ok(r.unsupported.some(({ kind, command, detail }) => kind === 'option' && command === 'cp' && detail === option))
      check(t, 'test -e /tmp/out', '', '', 1)
    })
  }

  for (const command of ['cp /dev/stdin /tmp/out', 'cp /dev/./stdin /tmp/out', 'cp //dev//stdin /tmp/out', 'cp a /dev/null', 'cp a /dev/./null']) {
    it(`diagnoses special-file copies: ${command}`, () => {
      const r = terminal().run(command + ' 2>/dev/null | cat')
      assert.equal(r.stdout, '')
      assert.equal(r.stderr, '')
      assert.equal(r.exitCode, 0)
      assert.deepEqual(r.unsupported.map(({ detail }) => detail), ['special file'])
    })
  }

  it('cannot bypass a parent xargs input guard with a newly opened destination', () => {
    const t = terminal()
    check(t, 'printf "/tmp/args\\n" >/tmp/args')
    const r = t.run('xargs -I{} cp a {} </tmp/args 2>/dev/null | cat')
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '')
    assert.equal(r.exitCode, 0)
    assert.ok(r.unsupported.some(({ detail }) => detail === 'streaming self-output'))
    check(t, 'cat /tmp/args', '/tmp/args\n')
  })

  it('preserves earlier output when a later source has no byte representation', () => {
    const t = terminal()
    const r = t.run('cp -v a bad /tmp')
    assert.equal(r.stdout, "'a' -> '/tmp/a'\n'bad' -> '/tmp/bad'\n")
    assert.equal(r.exitCode, 1)
    assert.deepEqual(r.unsupported.map(({ detail }) => detail), ['unpaired surrogate'])
    check(t, 'cat /tmp/a', 'alpha\n')
    check(t, 'test -e /tmp/bad', '', '', 1)
  })
})
