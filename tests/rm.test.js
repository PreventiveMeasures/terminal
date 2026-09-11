import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { createFs } from '../src/fs.js'
import { writableFs } from '../src/writable.js'

// GNU remove.c defines -f's ignorable missing errors and -v's per-file output.
// https://github.com/coreutils/coreutils/blob/master/src/remove.c
const result = (stdout = '', exitCode = 0, stderr = '', cwd = '/src') => ({ stdout, stderr, exitCode, cwd, notes: [], unsupported: [] })
const makeTerminal = () => createTerminal({ source: 'original\n' }, { mount: '/src/', writable: '/tmp/' })
const setup = () => {
  const terminal = makeTerminal()
  assert.deepEqual(terminal.run('printf A >/tmp/a; printf B >/tmp/b'), result())
  return terminal
}

describe('rm removes writable files', () => {
  for (const command of ['rm /tmp/a', 'rm -- /tmp/a', 'rm -f /tmp/a', 'rm --force /tmp/a']) {
    it(command, () => {
      const terminal = setup()
      assert.deepEqual(terminal.run(command), result())
      assert.deepEqual(terminal.run('test -f /tmp/a'), result('', 1))
      assert.deepEqual(terminal.run('cat /tmp/b /src/source'), result('Boriginal\n'))
    })
  }
  it('handles multiple operands, relative paths, dot components and repeated slashes', () => {
    const terminal = setup()
    assert.deepEqual(terminal.run('cd /tmp; rm ./a /tmp//./b; ls -A'), result('', 0, '', '/tmp'))
  })
  it('removes empty files and literal dash operands', () => {
    const terminal = makeTerminal()
    assert.deepEqual(terminal.run('cd /tmp; >empty; >-; >-file; rm empty - -- -file; ls -A'), result('', 0, '', '/tmp'))
  })
  it('preserves literal spaces, brackets, quotes and Unicode in filenames', () => {
    const terminal = makeTerminal()
    assert.deepEqual(terminal.run('cd /tmp; >"[a b]"; >"a\'b"; >"é😀"; rm "[a b]" "a\'b" "é😀"; ls -A'), result('', 0, '', '/tmp'))
  })
  it('refreshes directory listings, glob expansion and find after removal', () => {
    const terminal = setup()
    assert.deepEqual(terminal.run('ls /tmp'), result('a\nb\n'))
    assert.deepEqual(terminal.run('rm /tmp/a; echo /tmp/*; find /tmp -type f'), result('/tmp/b\n/tmp/b\n'))
    assert.deepEqual(terminal.run('printf C >/tmp/c; rm /tmp/*; ls -A /tmp'), result())
  })
  it('keeps hidden files out of star expansion', () => {
    const terminal = setup()
    assert.deepEqual(terminal.run('printf H >/tmp/.hidden; rm /tmp/*; ls -A /tmp'), {
      ...result('.hidden\n'),
      notes: ['glob: omitted 1 hidden entry while expanding "/tmp/*": "/tmp/.hidden".'],
    })
  })
  it('supports agent cleanup through xargs and find -exec', () => {
    const terminal = setup()
    assert.deepEqual(terminal.run("printf '/tmp/a\\n' | xargs rm; find /tmp -type f -exec rm {} \\; ; ls -A /tmp"), result())
  })
  it('keeps changes confined to one terminal instance', () => {
    const first = setup(), second = setup()
    assert.deepEqual(first.run('rm /tmp/a'), result())
    assert.deepEqual(second.run('cat /tmp/a'), result('A'))
  })
})

describe('rm force and verbose behavior', () => {
  for (const flags of ['-v', '--verbose', '-fv', '--force --verbose']) {
    it(flags, () => {
      assert.deepEqual(setup().run(`rm ${flags} /tmp/a /tmp/b`), result("removed '/tmp/a'\nremoved '/tmp/b'\n"))
    })
  }
  it('accepts flags following operands and prints original operand spelling', () => {
    assert.deepEqual(setup().run('rm /tmp/./a --verbose'), result("removed '/tmp/./a'\n"))
  })
  for (const command of ['rm -f', 'rm --force --', "rm -f '' /tmp/missing /tmp/missing/child /tmp/a/child /src/missing", 'rm -f /tmp/a /tmp/a']) {
    it(command, () => assert.deepEqual(setup().run(command), result()))
  }
  it('verbose force reports only files actually removed', () => {
    assert.deepEqual(setup().run('rm -vf /tmp/missing /tmp/a /tmp/a /tmp/b'), result("removed '/tmp/a'\nremoved '/tmp/b'\n"))
  })
  for (const command of ['rm', 'rm --', 'rm -v']) {
    it(`requires operands: ${command}`, () => assert.deepEqual(setup().run(command), result('', 1, 'rm: missing operand\n')))
  }
})

describe('rm failures preserve filesystem state', () => {
  it('continues processing operands after missing files and read-only failures', () => {
    const terminal = setup()
    assert.deepEqual(terminal.run('rm -v /tmp/missing /tmp/a /src/source /tmp/b'), result("removed '/tmp/a'\nremoved '/tmp/b'\n", 1,
      "rm: cannot remove '/tmp/missing': No such file or directory\nrm: cannot remove '/src/source': Read-only file system\n"))
    assert.deepEqual(terminal.run('cat /src/source; ls -A /tmp'), result('original\n'))
  })
  it('preserves operand order when verbose output and errors share a descriptor', () => {
    const expected = "removed '/tmp/a'\nrm: cannot remove '/tmp/missing': No such file or directory\nremoved '/tmp/b'\n"
    assert.deepEqual(setup().run('rm -v /tmp/a /tmp/missing /tmp/b 2>&1'), result(expected, 1))
    const terminal = setup()
    assert.deepEqual(terminal.run('rm -v /tmp/a /tmp/missing /tmp/b >/tmp/log 2>&1'), result('', 1))
    assert.deepEqual(terminal.run('cat /tmp/log'), result(expected))
  })
  it('reports a repeated operand as missing after deleting the first', () => {
    assert.deepEqual(setup().run('rm /tmp/a /tmp/a'), result('', 1, "rm: cannot remove '/tmp/a': No such file or directory\n"))
  })
  for (const name of ['/tmp', '/tmp/', '/tmp/.', '/src', '/']) {
    it(`rejects a directory even with force: ${name}`, () => {
      const terminal = setup()
      assert.deepEqual(terminal.run(`rm -f ${name}`), result('', 1, `rm: cannot remove '${name}': Is a directory\n`))
      assert.deepEqual(terminal.run('cat /tmp/a /tmp/b'), result('AB'))
    })
  }
  for (const [name, error] of [
    ['/tmp/a/', 'Not a directory'], ['/tmp/a/../b', 'Not a directory'], ['/tmp/missing/../b', 'No such file or directory'],
  ]) {
    it(`checks path components before collapsing dot-dot: ${name}`, () => {
      const terminal = setup()
      assert.deepEqual(terminal.run(`rm ${name}`), result('', 1, `rm: cannot remove '${name}': ${error}\n`))
      assert.deepEqual(terminal.run('rm -f ' + name), result())
      assert.deepEqual(terminal.run('cat /tmp/a /tmp/b'), result('AB'))
    })
  }
  for (const name of ['/src/source', '/tmp/../src/source']) {
    it(`does not suppress actual read-only errors with force: ${name}`, () => {
      assert.deepEqual(setup().run(`rm -f ${name}`), result('', 1, `rm: cannot remove '${name}': Read-only file system\n`))
    })
  }
  it('reports ordinary read-only failures when writable storage is absent', () => {
    // No mount, so this terminal starts at the root rather than at /src.
    const terminal = createTerminal({ 'tmp/file': 'original' })
    assert.deepEqual(terminal.run('rm /tmp/file'), result('', 1, "rm: cannot remove '/tmp/file': Read-only file system\n", '/'))
    assert.deepEqual(terminal.run('rm /tmp/file 2>/dev/null | cat'), result('', 0, '', '/'))
    assert.deepEqual(terminal.run('cat /tmp/file'), result('original', 0, '', '/'))
  })
  it('writes ordinary errors through stderr redirection', () => {
    const terminal = setup()
    assert.deepEqual(terminal.run('rm /src/source 2>/tmp/errors'), result('', 1))
    assert.deepEqual(terminal.run('cat /tmp/errors'), result("rm: cannot remove '/src/source': Read-only file system\n"))
  })
})

describe('rm keeps unsupported modes visible without deleting operands', () => {
  for (const flag of ['-r', '-R', '--recursive', '-rf', '-d', '--dir', '-i', '-I', '--interactive=never', '--one-file-system', '--preserve-root', '--no-preserve-root']) {
    it(flag, () => {
      const terminal = setup()
      const actual = terminal.run(`rm ${flag} /tmp/a 2>/dev/null | cat`)
      assert.equal(actual.stdout, '')
      assert.equal(actual.stderr, '')
      assert.equal(actual.exitCode, 0)
      assert.equal(actual.unsupported.length, 1)
      assert.equal(actual.unsupported[0].command, 'rm')
      assert.equal(actual.unsupported[0].kind, 'option')
      assert.deepEqual(terminal.run('cat /tmp/a'), result('A'))
    })
  }
})

describe('unlinking writable files preserves open descriptors', () => {
  it('does not resurrect a removed file when its inherited stdout writes later', () => {
    const terminal = makeTerminal()
    assert.deepEqual(terminal.run('{ echo before; rm /tmp/output; echo after; } >/tmp/output; test -f /tmp/output'), result('', 1))
  })
  it('keeps old writes separate from a recreated filename', () => {
    const terminal = makeTerminal()
    assert.deepEqual(terminal.run('{ printf before; rm /tmp/output; printf fresh >/tmp/output; printf after; } >/tmp/output; cat /tmp/output'), result('fresh'))
  })
  it('does not reintroduce a verbose removal target used as stdout', () => {
    const terminal = setup()
    assert.deepEqual(terminal.run('rm -v /tmp/a >/tmp/a; test -f /tmp/a'), result('', 1))
  })
  it('preserves both regular and append handles to the unlinked inode', () => {
    const fs = writableFs(createFs({}, '/src'))
    const regular = fs.openWritable('/', '/tmp/file')
    const append = fs.openWritable('/', '/tmp/file', true)
    regular.write('old')
    assert.equal(fs.removeWritable('/', '/tmp/file'), true)
    assert.deepEqual(fs.listDir('/tmp'), { dirs: [], files: [] })
    regular.write(' regular')
    append.write(' append')
    assert.equal(fs.isFile('/tmp/file'), false)
    fs.openWritable('/', '/tmp/file').write('new')
    regular.write(' more')
    append.write(' tail')
    assert.equal(fs.readFile('/tmp/file'), 'new')
    assert.deepEqual(fs.listDir('/tmp'), { dirs: [], files: ['file'] })
  })
  it('can remove a file containing invalid UTF-8 without decoding it', () => {
    const fs = writableFs(createFs({}, '/src'))
    const first = fs.openWritable('/', '/tmp/file')
    const second = fs.openWritable('/', '/tmp/file')
    first.write('é')
    second.write('X')
    assert.throws(() => fs.readFile('/tmp/file'), /UTF-8/u)
    assert.equal(fs.removeWritable('/', '/tmp/file'), true)
    assert.equal(fs.isFile('/tmp/file'), false)
  })
})
