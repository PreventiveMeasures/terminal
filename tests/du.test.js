import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { createFs } from '../src/fs.js'
import { writableFs } from '../src/writable.js'
import { du } from '../src/commands/du.js'
import { duSize } from '../src/commands/du-options.js'

// GNU 9.2+ excludes directory st_size from apparent sizes.
// https://www.gnu.org/software/coreutils/manual/html_node/du-invocation.html
const sources = { a: 'abc', empty: '', 'dir/b': 'é😀', 'dir/sub/c': '12345', '.hidden': 'xy', 'dir/.hidden': 'z' }
const result = (stdout = '', exitCode = 0, stderr = '', cwd = '/') => ({ stdout, stderr, exitCode, cwd, notes: [], unsupported: [] })
const run = (command) => createTerminal(sources).run(command)

describe('du apparent sizes and traversal', () => {
  for (const flag of ['-b', '--bytes', '--apparent-size -B1', '-AB1']) {
    it(flag, () => assert.deepEqual(run(`du ${flag}`), result('5\t./dir/sub\n12\t./dir\n17\t.\n')))
  }
  it('includes hidden files without glob or listing omission notes', () => {
    assert.deepEqual(run('du -ab dir'), result('1\tdir/.hidden\n6\tdir/b\n5\tdir/sub/c\n5\tdir/sub\n12\tdir\n'))
  })
  for (const flag of ['-s', '--summarize', '-d0', '--max-depth=0']) {
    it(flag, () => assert.deepEqual(run(`du -b ${flag} dir a empty`), result('12\tdir\n3\ta\n0\tempty\n')))
  }
  it('depth limits output, not totals', () => {
    assert.deepEqual(run('du -ab -d1'), result('2\t./.hidden\n3\t./a\n12\t./dir\n0\t./empty\n17\t.\n'))
  })
  for (const depth of ['1', '01', '0x1', '+1', "' 1'"]) {
    it(`GNU integer depth ${depth}`, () => assert.deepEqual(run(`du -b -d${depth}`), result('12\t./dir\n17\t.\n')))
  }
  it('separates subdirectory totals', () => assert.deepEqual(run('du -bS'), result('5\t./dir/sub\n7\t./dir\n5\t.\n')))
  it('adds only counted file bytes to a grand total', () => {
    assert.deepEqual(run('du -bc a dir empty'), result('3\ta\n5\tdir/sub\n12\tdir\n0\tempty\n15\ttotal\n'))
  })
  it('deduplicates repeat and overlapping operands by canonical identity', () => {
    assert.deepEqual(run('du -bc a ./a dir dir/sub'), result('3\ta\n5\tdir/sub\n12\tdir\n15\ttotal\n'))
    assert.deepEqual(run('du -bcs dir/sub dir'), result('5\tdir/sub\n7\tdir\n12\ttotal\n'))
  })
  it('count-links counts repeated operands and subtrees', () => {
    assert.deepEqual(run('du -blsc dir dir/sub'), result('12\tdir\n5\tdir/sub\n17\ttotal\n'))
    assert.deepEqual(run('du -blc a ./a'), result('3\ta\n3\t./a\n6\ttotal\n'))
  })
  it('preserves operand spelling and NUL-delimits names', () => {
    assert.deepEqual(run('du -b0 dir/../a /dir//sub/'), result('3\tdir/../a\u00005\t/dir//sub/\0'))
  })
  it('normalizes repeated trailing slashes while retaining a double-slash root', () => {
    const terminal = createTerminal({ 'dir/file': 'abc' })
    assert.deepEqual(terminal.run('du -ab dir///'), result('3\tdir/file\n3\tdir/\n'))
    assert.deepEqual(terminal.run('du -ab //'), result('3\t//dir/file\n3\t//dir\n3\t//\n'))
    assert.deepEqual(terminal.run('du -ab ///'), result('3\t/dir/file\n3\t/dir\n3\t/\n'))
  })
  for (const flag of ['-L', '-D', '-H', '-P', '--dereference', '--dereference-args', '--no-dereference']) {
    it(`accepts link mode in a filesystem without links: ${flag}`, () => assert.deepEqual(run(`du -bs ${flag} dir`), result('12\tdir\n')))
  }
  it('does not consume piped standard input', () => assert.deepEqual(run("printf 'input\\n' | { du -b a; cat; }"), result('3\ta\ninput\n')))
  it('treats a dash operand as a filename', () => assert.deepEqual(createTerminal({ '-': 'hi' }).run('du -b -'), result('2\t-\n')))
})

describe('du scales exact byte counts', () => {
  const terminal = createTerminal({ a: 'a'.repeat(1025), b: 'b'.repeat(1024), empty: '' })
  for (const [flags, stdout] of [
    ['--apparent-size', '2\ta\n1\tb\n0\tempty\n'], ['-bk', '2\ta\n1\tb\n0\tempty\n'],
    ['-kb', '1025\ta\n1024\tb\n0\tempty\n'], ['-bm', '1\ta\n1\tb\n0\tempty\n'],
    ['-bB1000', '2\ta\n2\tb\n0\tempty\n'], ['-bBK', '2K\ta\n1K\tb\n0K\tempty\n'],
    ['-bB1K', '2\ta\n1\tb\n0\tempty\n'], ['-bBKB', '2kB\ta\n2kB\tb\n0kB\tempty\n'],
    ['-bB1KD', '2\ta\n2\tb\n0\tempty\n'], ['-bBKD', '2K\ta\n2K\tb\n0K\tempty\n'],
    ['-bh', '1.1K\ta\n1.0K\tb\n0\tempty\n'], ['-b --si', '1.1k\ta\n1.1k\tb\n0\tempty\n'],
    ['-bB0x400', '2\ta\n1\tb\n0\tempty\n'], ['-bB02000', '2\ta\n1\tb\n0\tempty\n'],
  ]) {
    it(flags, () => assert.deepEqual(terminal.run(`du ${flags} a b empty`), result(stdout)))
  }
  for (const [bytes, expected] of [[0n, '0'], [1023n, '1023'], [1024n, '1.0K'], [1025n, '1.1K'], [10137n, '9.9K'], [10138n, '10K'], [1047553n, '1.0M']]) {
    it(`human-readable boundary ${bytes}`, () => assert.equal(duSize(bytes, { base: 1024n, unit: 1n }), expected))
  }
  it('respects block environment settings and explicit overrides', () => {
    assert.deepEqual(terminal.run('DU_BLOCK_SIZE=1 du --apparent-size a'), result('1025\ta\n'))
    assert.deepEqual(terminal.run('BLOCK_SIZE=512 du --apparent-size a'), result('3\ta\n'))
    assert.equal(terminal.run('POSIXLY_CORRECT=1 du --apparent-size a').unsupported[0].detail, 'POSIXLY_CORRECT')
    assert.deepEqual(terminal.run('DU_BLOCK_SIZE=2 du -b a'), result('1025\ta\n'))
  })
  it('uses the first configured block-size variable, including explicit overrides', () => {
    assert.deepEqual(terminal.run('DU_BLOCK_SIZE=2 BLOCK_SIZE=1 BLOCKSIZE=512 du -A a'), result('513\ta\n'))
    assert.deepEqual(terminal.run('BLOCK_SIZE=2 BLOCKSIZE=1 du -A a'), result('513\ta\n'))
    assert.deepEqual(terminal.run('BLOCKSIZE=2 du -A a'), result('513\ta\n'))
    assert.deepEqual(terminal.run('DU_BLOCK_SIZE=invalid du -b a'), result('1025\ta\n'))
  })
  for (const setting of ['DU_BLOCK_SIZE=', 'DU_BLOCK_SIZE=invalid', 'BLOCK_SIZE=2junk', 'BLOCKSIZE=0']) {
    it(`diagnoses GNU fallback semantics for ${setting}`, () => {
      const actual = terminal.run(`${setting} du -A a 2>/dev/null | cat`)
      assert.equal(actual.stdout, '')
      assert.equal(actual.stderr, '')
      assert.equal(actual.unsupported[0].detail, 'invalid block size environment')
    })
  }
  for (const mode of ['h', 'hu', 'human', 's', 'si']) {
    it(`unique automatic-unit abbreviation ${mode}`, () => {
      assert.deepEqual(terminal.run(`du --apparent-size -B${mode} a`), result(`1.1${mode.startsWith('s') ? 'k' : 'K'}\ta\n`))
    })
  }
})

describe('du counts modeled inodes', () => {
  it('counts files and directories', () => assert.deepEqual(run('du --inodes'), result('2\t./dir/sub\n5\t./dir\n9\t.\n')))
  it('supports summarize, all entries, separate dirs and totals', () => {
    assert.deepEqual(run('du --inodes -sc dir a'), result('5\tdir\n1\ta\n6\ttotal\n'))
    assert.deepEqual(run('du --inodes -aSd1 dir'), result('1\tdir/.hidden\n1\tdir/b\n2\tdir/sub\n3\tdir\n'))
  })
  it('ignores numeric size units and diagnoses ineffective apparent-size flags', () => {
    assert.deepEqual(run('du --inodes -ks dir'), result('5\tdir\n'))
    assert.deepEqual(run('du --inodes -bs dir'), result('5\tdir\n', 0, 'du: warning: options --apparent-size and -b are ineffective with --inodes\n'))
  })
  for (const [size, suffix] of [['M', ''], ['MB', 'B'], ['MiB', 'B']]) {
    it(`inode counts with -B${size}`, () => assert.deepEqual(run(`du --inodes -s -B${size} dir`), result(`5${suffix}\tdir\n`)))
  }
  it('counts an empty writable directory as one inode and zero apparent bytes', () => {
    const terminal = createTerminal({}, { mount: '/src', writable: '/tmp/' })
    assert.deepEqual(terminal.run('du -b /tmp; du --inodes /tmp'), result('0\t/tmp\n1\t/tmp\n', 0, '', '/src'))
  })
  it('deduplicates actual shared overlay identities', () => {
    const fs = writableFs(createFs({}, '/src'))
    fs.openWritable('/', '/tmp/a').write('old')
    fs.replaceWritable('/', '/tmp/a', 'new', '/tmp/b')
    fs.replaceWritable('/', '/tmp/b', 'newer', '/tmp/c')
    const identity = fs.fileIdentity('/tmp/a')
    const shared = { ...fs, fileIdentity: (path) => path === '/tmp/a' || path === '/tmp/b' ? identity : fs.fileIdentity(path) }
    const ctx = { fs: shared, cwd: '/', vars: new Map(), notes: new Set(), unsupported: { add() {} }, flushOutput: (r) => r }
    assert.equal(du('', ['--inodes', '-c', '/tmp/a', '/tmp/b'], ctx).stdout, '1\t/tmp/a\n1\ttotal\n')
  })
})

describe('du reports failures without inventing metadata', () => {
  it('reports missing paths and continues with valid operands', () => {
    assert.deepEqual(run('du -bc missing a'), result('3\ta\n3\ttotal\n', 1, "du: cannot access 'missing': No such file or directory\n"))
  })
  for (const path of ['a/../empty', 'a/', 'missing/../a']) {
    it(`validates components of ${path}`, () => {
      const actual = run('du -b ' + path)
      assert.equal(actual.exitCode, 1)
      assert.equal(actual.stdout, '')
      assert.deepEqual(actual.unsupported, [])
    })
  }
  it('adds relative-cwd hints through the shared filesystem error path', () => {
    const terminal = createTerminal(sources, { mount: '/repo' })
    const actual = terminal.run('cd dir; du -b a')
    assert.equal(actual.exitCode, 1)
    assert.deepEqual(actual.notes, ['du: relative path "a" was not found from cwd "/repo/dir". A file exists at "/repo/a".'])
  })
  for (const flags of ['', '-h', '-sh', '-k', '-m']) {
    it(`diagnoses allocated-size mode: ${flags}`, () => {
      const actual = run(`du ${flags} a 2>/dev/null | cat`)
      assert.equal(actual.stdout, '')
      assert.equal(actual.stderr, '')
      assert.equal(actual.unsupported[0].detail, 'allocated disk size')
    })
  }
  for (const flag of ['--time', '--time=ctime', '-x', '--exclude=x', '--exclude-from=x', '--files0-from=-', '--threshold=1', '--bad']) {
    it(`diagnoses ${flag}`, () => {
      const actual = run(`du -b ${flag} a 2>/dev/null | cat`)
      assert.equal(actual.unsupported[0].kind, 'option')
      assert.equal(actual.unsupported[0].command, 'du')
    })
  }
  for (const flags of ['-as', '-sd1', '-d-1', '-d1.5', '-d08', '-d9223372036854775808', '-B0', '-B08', '-B1.5K', '-B18446744073709551616', '-B1e', '-B1p', '-B+M', "-B' M'"]) {
    it(`rejects invalid option values ${flags}`, () => {
      const actual = run(`du -b ${flags} a`)
      assert.equal(actual.exitCode, 1)
      assert.equal(actual.stdout, '')
    })
  }
  it('reports redundant depth-zero summarize without failing', () => {
    assert.deepEqual(run('du -bsd0 a'), result('3\ta\n', 0, 'du: warning: summarizing is the same as using --max-depth=0\n'))
  })
  it('accepts a signed zero depth', () => assert.deepEqual(run('du -b -d-0 dir'), result('12\tdir\n')))
  it('diagnoses unpaired source surrogates instead of measuring replacement bytes', () => {
    const actual = createTerminal({ file: '\uD800' }).run('du -b file')
    assert.equal(actual.exitCode, 1)
    assert.equal(actual.stdout, '')
    assert.equal(actual.unsupported.length, 1)
  })
  it('diagnoses colliding file/directory source keys', () => {
    const actual = createTerminal({ a: 'x', 'a/b': 'y' }).run('du -b a')
    assert.equal(actual.unsupported[0].detail, 'ambiguous file type')
  })
  it('measures invalid UTF-8 overlay bytes without decoding them', () => {
    const fs = writableFs(createFs({}, '/src'))
    const first = fs.openWritable('/', '/tmp/file'), second = fs.openWritable('/', '/tmp/file')
    first.write('é'); second.write('X')
    assert.throws(() => fs.readFile('/tmp/file'), /UTF-8/u)
    const ctx = { fs, cwd: '/', vars: new Map(), notes: new Set(), unsupported: { add() {} }, flushOutput: (r) => r }
    assert.equal(du('', ['-b', '/tmp/file'], ctx).stdout, '2\t/tmp/file\n')
  })
  it('flushes earlier output before measuring a writable output operand', () => {
    const terminal = createTerminal({}, { mount: '/src', writable: '/tmp/' })
    assert.deepEqual(terminal.run("printf abc >/tmp/a; du -b /tmp/a /tmp/out >/tmp/out; cat /tmp/out"), result('3\t/tmp/a\n9\t/tmp/out\n', 0, '', '/src'))
  })
  it('diagnoses recursive output overlap where metadata prefetch can change totals', () => {
    const terminal = createTerminal({}, { mount: '/src', writable: '/tmp/' })
    const actual = terminal.run('du -ab /tmp >/tmp/out')
    assert.equal(actual.exitCode, 1)
    assert.equal(actual.unsupported[0].detail, 'recursive metadata output overlap')
  })
  it('permits inode counts when only a descendant file content changes', () => {
    const terminal = createTerminal({}, { mount: '/src', writable: '/tmp/' })
    assert.deepEqual(terminal.run('du --inodes /tmp >/tmp/out; cat /tmp/out'), result('2\t/tmp\n', 0, '', '/src'))
  })
  it('retains the parent reader in nested self-output diagnostics', () => {
    const terminal = createTerminal({ a: 'abc' }, { mount: '/src', writable: '/tmp/' })
    terminal.run('echo a >/tmp/args')
    const actual = terminal.run('xargs -n1 du -b </tmp/args >>/tmp/args 2>/dev/null')
    assert.equal(actual.exitCode, 123)
    assert.deepEqual(actual.unsupported.map(({ command, detail }) => [command, detail]), [['xargs', 'streaming self-output']])
    assert.deepEqual(terminal.run('cat /tmp/args'), result('a\n', 0, '', '/src'))
  })
  it('reports a closed stdout as a failed write', () => {
    assert.deepEqual(run('du -b a 1>&-'), result('', 1, 'du: write error: Bad file descriptor\n'))
  })
  it('flushes warnings before inspecting a writable operand', () => {
    const terminal = createTerminal({}, { mount: '/src', writable: '/tmp/' })
    const warning = 'du: warning: summarizing is the same as using --max-depth=0\n'
    assert.deepEqual(terminal.run('du -bsd0 /tmp/out 2>/tmp/out'), result(`${warning.length}\t/tmp/out\n`, 0, '', '/src'))
    assert.deepEqual(terminal.run('cat /tmp/out'), result(warning, 0, '', '/src'))
  })
})
