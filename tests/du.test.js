import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { createFs } from '../src/filesystem.js'
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
    it(flag, async () => assert.deepEqual(await run(`du ${flag}`), result('5\t./dir/sub\n12\t./dir\n17\t.\n')))
  }
  it('includes hidden files without glob or listing omission notes', async () => {
    assert.deepEqual(await run('du -ab dir'), result('1\tdir/.hidden\n6\tdir/b\n5\tdir/sub/c\n5\tdir/sub\n12\tdir\n'))
  })
  for (const flag of ['-s', '--summarize', '-d0', '--max-depth=0']) {
    it(flag, async () => assert.deepEqual(await run(`du -b ${flag} dir a empty`), result('12\tdir\n3\ta\n0\tempty\n')))
  }
  it('depth limits output, not totals', async () => {
    assert.deepEqual(await run('du -ab -d1'), result('2\t./.hidden\n3\t./a\n12\t./dir\n0\t./empty\n17\t.\n'))
  })
  for (const depth of ['1', '01', '0x1', '+1', "' 1'"]) {
    it(`GNU integer depth ${depth}`, async () => assert.deepEqual(await run(`du -b -d${depth}`), result('12\t./dir\n17\t.\n')))
  }
  it('separates subdirectory totals', async () => assert.deepEqual(await run('du -bS'), result('5\t./dir/sub\n7\t./dir\n5\t.\n')))
  it('adds only counted file bytes to a grand total', async () => {
    assert.deepEqual(await run('du -bc a dir empty'), result('3\ta\n5\tdir/sub\n12\tdir\n0\tempty\n15\ttotal\n'))
  })
  it('deduplicates repeat and overlapping operands by canonical identity', async () => {
    assert.deepEqual(await run('du -bc a ./a dir dir/sub'), result('3\ta\n5\tdir/sub\n12\tdir\n15\ttotal\n'))
    assert.deepEqual(await run('du -bcs dir/sub dir'), result('5\tdir/sub\n7\tdir\n12\ttotal\n'))
  })
  it('count-links counts repeated operands and subtrees', async () => {
    assert.deepEqual(await run('du -blsc dir dir/sub'), result('12\tdir\n5\tdir/sub\n17\ttotal\n'))
    assert.deepEqual(await run('du -blc a ./a'), result('3\ta\n3\t./a\n6\ttotal\n'))
  })
  it('preserves operand spelling and NUL-delimits names', async () => {
    assert.deepEqual(await run('du -b0 dir/../a /dir//sub/'), result('3\tdir/../a\u00005\t/dir//sub/\0'))
  })
  it('normalizes repeated trailing slashes while retaining a double-slash root', async () => {
    const terminal = createTerminal({ 'dir/file': 'abc' })
    assert.deepEqual(await terminal.run('du -ab dir///'), result('3\tdir/file\n3\tdir/\n'))
    assert.deepEqual(await terminal.run('du -ab //'), result('3\t//dir/file\n3\t//dir\n3\t//\n'))
    assert.deepEqual(await terminal.run('du -ab ///'), result('3\t/dir/file\n3\t/dir\n3\t/\n'))
  })
  for (const flag of ['-L', '-D', '-H', '-P', '--dereference', '--dereference-args', '--no-dereference']) {
    it(`accepts link mode in a filesystem without links: ${flag}`, async () => assert.deepEqual(await run(`du -bs ${flag} dir`), result('12\tdir\n')))
  }
  it('does not consume piped standard input', async () => assert.deepEqual(await run("printf 'input\\n' | { du -b a; cat; }"), result('3\ta\ninput\n')))
  it('treats a dash operand as a filename', async () => assert.deepEqual(await createTerminal({ '-': 'hi' }).run('du -b -'), result('2\t-\n')))
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
    it(flags, async () => assert.deepEqual(await terminal.run(`du ${flags} a b empty`), result(stdout)))
  }
  for (const [bytes, expected] of [[0n, '0'], [1023n, '1023'], [1024n, '1.0K'], [1025n, '1.1K'], [10137n, '9.9K'], [10138n, '10K'], [1047553n, '1.0M']]) {
    it(`human-readable boundary ${bytes}`, () => assert.equal(duSize(bytes, { base: 1024n, unit: 1n }), expected))
  }
  it('respects block environment settings and explicit overrides', async () => {
    assert.deepEqual(await terminal.run('DU_BLOCK_SIZE=1 du --apparent-size a'), result('1025\ta\n'))
    assert.deepEqual(await terminal.run('BLOCK_SIZE=512 du --apparent-size a'), result('3\ta\n'))
    assert.equal((await terminal.run('POSIXLY_CORRECT=1 du --apparent-size a')).unsupported[0].detail, 'POSIXLY_CORRECT')
    assert.deepEqual(await terminal.run('DU_BLOCK_SIZE=2 du -b a'), result('1025\ta\n'))
  })
  it('uses the first configured block-size variable, including explicit overrides', async () => {
    assert.deepEqual(await terminal.run('DU_BLOCK_SIZE=2 BLOCK_SIZE=1 BLOCKSIZE=512 du -A a'), result('513\ta\n'))
    assert.deepEqual(await terminal.run('BLOCK_SIZE=2 BLOCKSIZE=1 du -A a'), result('513\ta\n'))
    assert.deepEqual(await terminal.run('BLOCKSIZE=2 du -A a'), result('513\ta\n'))
    assert.deepEqual(await terminal.run('DU_BLOCK_SIZE=invalid du -b a'), result('1025\ta\n'))
  })
  for (const setting of ['DU_BLOCK_SIZE=', 'DU_BLOCK_SIZE=invalid', 'BLOCK_SIZE=2junk', 'BLOCKSIZE=0']) {
    it(`diagnoses GNU fallback semantics for ${setting}`, async () => {
      const actual = await terminal.run(`${setting} du -A a 2>/dev/null | cat`)
      assert.equal(actual.stdout, '')
      assert.equal(actual.stderr, '')
      assert.equal(actual.unsupported[0].detail, 'invalid block size environment')
    })
  }
  for (const mode of ['h', 'hu', 'human', 's', 'si']) {
    it(`unique automatic-unit abbreviation ${mode}`, async () => {
      assert.deepEqual(await terminal.run(`du --apparent-size -B${mode} a`), result(`1.1${mode.startsWith('s') ? 'k' : 'K'}\ta\n`))
    })
  }
})

describe('du counts modeled inodes', () => {
  it('counts files and directories', async () => assert.deepEqual(await run('du --inodes'), result('2\t./dir/sub\n5\t./dir\n9\t.\n')))
  it('supports summarize, all entries, separate dirs and totals', async () => {
    assert.deepEqual(await run('du --inodes -sc dir a'), result('5\tdir\n1\ta\n6\ttotal\n'))
    assert.deepEqual(await run('du --inodes -aSd1 dir'), result('1\tdir/.hidden\n1\tdir/b\n2\tdir/sub\n3\tdir\n'))
  })
  it('ignores numeric size units and diagnoses ineffective apparent-size flags', async () => {
    assert.deepEqual(await run('du --inodes -ks dir'), result('5\tdir\n'))
    assert.deepEqual(await run('du --inodes -bs dir'), result('5\tdir\n', 0, 'du: warning: options --apparent-size and -b are ineffective with --inodes\n'))
  })
  for (const [size, suffix] of [['M', ''], ['MB', 'B'], ['MiB', 'B']]) {
    it(`inode counts with -B${size}`, async () => assert.deepEqual(await run(`du --inodes -s -B${size} dir`), result(`5${suffix}\tdir\n`)))
  }
  it('counts an empty writable directory as one inode and zero apparent bytes', async () => {
    const terminal = createTerminal({}, { mount: '/src', writable: '/tmp/' })
    assert.deepEqual(await terminal.run('du -b /tmp; du --inodes /tmp'), result('0\t/tmp\n1\t/tmp\n', 0, '', '/src'))
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

// Without --apparent-size the sizes are what ext4 would allocate for the same
// tree, the model `ls -l` reads its `total` from: 4 KiB blocks, a directory
// taking one, an empty file none, and a link whose target is under 60 bytes
// none. Every figure here is what GNU du 9.4 printed over this tree on ext4.
describe('du allocated sizes follow the ext4 model', () => {
  it('rounds every entry up to whole blocks and gives a directory one of its own', async () => {
    assert.deepEqual(await run('du'), result('8\t./dir/sub\n20\t./dir\n32\t.\n'))
    assert.deepEqual(await run('du -a dir'), result('4\tdir/.hidden\n4\tdir/b\n4\tdir/sub/c\n8\tdir/sub\n20\tdir\n'))
    assert.deepEqual(await run('du -S'), result('8\t./dir/sub\n12\t./dir\n12\t.\n'))
    assert.deepEqual(await run('du -c a dir empty'), result('4\ta\n8\tdir/sub\n20\tdir\n0\tempty\n24\ttotal\n'))
    assert.deepEqual(await run('du -d0'), result('32\t.\n'))
  })

  it('scales the allocation as the byte counts are scaled', async () => {
    assert.deepEqual(await run('du -h'), result('8.0K\t./dir/sub\n20K\t./dir\n32K\t.\n'))
    assert.deepEqual(await run('du -sh .'), result('32K\t.\n'))
    assert.deepEqual(await run('du -k dir'), result('8\tdir/sub\n20\tdir\n'))
    assert.deepEqual(await run('du -m dir'), result('1\tdir/sub\n1\tdir\n'))
    assert.deepEqual(await run('du -B 3000 dir'), result('3\tdir/sub\n7\tdir\n'))
    assert.deepEqual(await run('du --si -s .'), result('33k\t.\n'))
    assert.deepEqual(await run('du -ch a empty'), result('4.0K\ta\n0\tempty\n4.0K\ttotal\n'))
  })

  it('gives a link no block while its target fits the inode', async () => {
    const t = createTerminal({ ...sources, near: { type: 'symlink', target: 'a' }, far: { type: 'symlink', target: 'x'.repeat(60) } })
    assert.deepEqual(await t.run('du near far'), result('0\tnear\n4\tfar\n'))
    assert.deepEqual(await t.run('du -b near far'), result('1\tnear\n60\tfar\n'))
    assert.deepEqual(await t.run('du -s .'), result('36\t.\n'))
  })

  it('measures the overlay by the same model', async () => {
    const t = createTerminal(sources, { mount: '/src/', writable: '/tmp/' })
    assert.deepEqual(await t.run('mkdir /tmp/d; printf x > /tmp/d/one; touch /tmp/d/empty; du /tmp'), result('8\t/tmp/d\n12\t/tmp\n', 0, '', '/src'))
  })
})

describe('du reports failures without inventing metadata', () => {
  it('reports missing paths and continues with valid operands', async () => {
    assert.deepEqual(await run('du -bc missing a'), result('3\ta\n3\ttotal\n', 1, "du: cannot access 'missing': No such file or directory\n"))
  })
  for (const path of ['a/../empty', 'a/', 'missing/../a']) {
    it(`validates components of ${path}`, async () => {
      const actual = await run('du -b ' + path)
      assert.equal(actual.exitCode, 1)
      assert.equal(actual.stdout, '')
      assert.deepEqual(actual.unsupported, [])
    })
  }
  it('adds relative-cwd hints through the shared filesystem error path', async () => {
    const terminal = createTerminal(sources, { mount: '/repo' })
    const actual = await terminal.run('cd dir; du -b a')
    assert.equal(actual.exitCode, 1)
    assert.deepEqual(actual.notes, ['du: relative path "a" was not found from cwd "/repo/dir". A file exists at "/repo/a".'])
  })
  for (const flag of ['--time', '--time=ctime', '-x', '--exclude=x', '--exclude-from=x', '--files0-from=-', '--threshold=1', '--bad']) {
    it(`diagnoses ${flag}`, async () => {
      const actual = await run(`du -b ${flag} a 2>/dev/null | cat`)
      assert.equal(actual.unsupported[0].kind, 'option')
      assert.equal(actual.unsupported[0].command, 'du')
    })
  }
  for (const flags of ['-as', '-sd1', '-d-1', '-d1.5', '-d08', '-d9223372036854775808', '-B0', '-B08', '-B1.5K', '-B18446744073709551616', '-B1e', '-B1p', '-B+M', "-B' M'"]) {
    it(`rejects invalid option values ${flags}`, async () => {
      const actual = await run(`du -b ${flags} a`)
      assert.equal(actual.exitCode, 1)
      assert.equal(actual.stdout, '')
    })
  }
  it('reports redundant depth-zero summarize without failing', async () => {
    assert.deepEqual(await run('du -bsd0 a'), result('3\ta\n', 0, 'du: warning: summarizing is the same as using --max-depth=0\n'))
  })
  it('accepts a signed zero depth', async () => assert.deepEqual(await run('du -b -d-0 dir'), result('12\tdir\n')))
  it('measures invalid UTF-8 overlay bytes without decoding them', () => {
    const fs = writableFs(createFs({}, '/src'))
    const first = fs.openWritable('/', '/tmp/file'), second = fs.openWritable('/', '/tmp/file')
    first.write('é'); second.write('X')
    assert.throws(() => fs.readFile('/tmp/file'), /spell no text/u)
    const ctx = { fs, cwd: '/', vars: new Map(), notes: new Set(), unsupported: { add() {} }, flushOutput: (r) => r }
    assert.equal(du('', ['-b', '/tmp/file'], ctx).stdout, '2\t/tmp/file\n')
  })
  it('flushes earlier output before measuring a writable output operand', async () => {
    const terminal = createTerminal({}, { mount: '/src', writable: '/tmp/' })
    assert.deepEqual(await terminal.run("printf abc >/tmp/a; du -b /tmp/a /tmp/out >/tmp/out; cat /tmp/out"), result('3\t/tmp/a\n9\t/tmp/out\n', 0, '', '/src'))
  })
  it('diagnoses recursive output overlap where metadata prefetch can change totals', async () => {
    const terminal = createTerminal({}, { mount: '/src', writable: '/tmp/' })
    const actual = await terminal.run('du -ab /tmp >/tmp/out')
    assert.equal(actual.exitCode, 1)
    assert.equal(actual.unsupported[0].detail, 'recursive metadata output overlap')
  })
  it('permits inode counts when only a descendant file content changes', async () => {
    const terminal = createTerminal({}, { mount: '/src', writable: '/tmp/' })
    assert.deepEqual(await terminal.run('du --inodes /tmp >/tmp/out; cat /tmp/out'), result('2\t/tmp\n', 0, '', '/src'))
  })
  it('retains the parent reader in nested self-output diagnostics', async () => {
    const terminal = createTerminal({ a: 'abc' }, { mount: '/src', writable: '/tmp/' })
    await terminal.run('echo a >/tmp/args')
    const actual = await terminal.run('xargs -n1 du -b </tmp/args >>/tmp/args 2>/dev/null')
    assert.equal(actual.exitCode, 123)
    assert.deepEqual(actual.unsupported.map(({ command, detail }) => [command, detail]), [['xargs', 'streaming self-output']])
    assert.deepEqual(await terminal.run('cat /tmp/args'), result('a\n', 0, '', '/src'))
  })
  it('reports a closed stdout as a failed write', async () => {
    assert.deepEqual(await run('du -b a 1>&-'), result('', 1, 'du: write error: Bad file descriptor\n'))
  })
  it('flushes warnings before inspecting a writable operand', async () => {
    const terminal = createTerminal({}, { mount: '/src', writable: '/tmp/' })
    const warning = 'du: warning: summarizing is the same as using --max-depth=0\n'
    assert.deepEqual(await terminal.run('du -bsd0 /tmp/out 2>/tmp/out'), result(`${warning.length}\t/tmp/out\n`, 0, '', '/src'))
    assert.deepEqual(await terminal.run('cat /tmp/out'), result(warning, 0, '', '/src'))
  })
})
