import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = {
  '.cache/saved': '',
  'README.md': '',
  'src/.secret': '',
  'src/main.js': '',
  'src/nested/deep/leaf.js': '',
  'src/nested/util.js': '',
  'test/main.test.js': '',
}

async function check(command, stdout, files = FILES) {
  const result = await createTerminal(files).run(command)
  assert.deepEqual([result.stdout, result.stderr, result.exitCode, result.unsupported], [stdout, '', 0, []], command)
}

describe('tree -L depth limits', () => {
  const shallow = '.\n├── README.md\n├── src\n└── test\n\n3 directories, 1 file\n'
  for (const command of ['tree -L 1', 'tree . -L 1', 'tree -L 3 -L 1', 'tree -L 0x1', 'tree -L 1.5']) {
    it(command + ' lists direct children only', () => check(command, shallow))
  }

  // tree 2.1.1 takes the argument after `-L` as the level, wherever in a run
  // of letters the `L` was, and reads it as strtoul does: what follows the
  // `L` in the same argument is more letters, read only once the level is.
  for (const [command, stderr] of [
    ['tree -L1', 'tree: Missing argument to -L option.\n'],
    ['tree . -L1', 'tree: Missing argument to -L option.\n'],
    ['tree -L1 src', 'tree: Invalid level, must be greater than 0.\n'],
    ['tree -L3 -L1', 'tree: Invalid level, must be greater than 0.\n'],
  ]) {
    it(command + ' reads the next argument as the level', async () => {
      const result = await createTerminal(FILES).run(command)
      assert.deepEqual([result.stdout, result.stderr, result.exitCode, result.unsupported], ['', stderr, 1, []])
    })
  }

  it('limits displayed entries and report totals at depth two', async () => {
    await check('tree -L 2', '.\n├── README.md\n├── src\n│   ├── main.js\n│   └── nested\n└── test\n    └── main.test.js\n\n4 directories, 3 files\n')
  })

  it('counts depth relative to the selected root', async () => {
    await check('tree -L 2 src', 'src\n├── main.js\n└── nested\n    ├── deep\n    └── util.js\n\n3 directories, 2 files\n')
    await check('cd src && tree -L 1', '.\n├── main.js\n└── nested\n\n2 directories, 1 file\n')
  })

  it('combines bundled flags, hidden entries, and omitted reports', async () => {
    await check('tree -aFL 1 --noreport', './\n├── .cache/\n├── README.md\n├── src/\n└── test/\n')
    await check('tree -adL 2 src', 'src\n└── nested\n    └── deep\n\n3 directories\n')
  })

  it('handles an empty directory and limits beyond the deepest entry', async () => {
    await check('tree -L 1', '.\n\n0 directories, 0 files\n', {})
    const terminal = createTerminal(FILES)
    assert.deepEqual(await terminal.run('tree -L 2147483647'), await terminal.run('tree'))
  })

  it('does not inspect names below the depth cutoff', async () => {
    const files = { 'src/bad\nname': '' }
    await check('tree -L 1', '.\n└── src\n\n2 directories, 0 files\n', files)
    const result = await createTerminal(files).run('tree -L 2 2>/dev/null | cat')
    assert.equal(result.stderr, '')
    assert.deepEqual(result.unsupported.map(({ command, detail }) => [command, detail]), [['tree', 'filename escaping']])
  })

  for (const args of ['-L', '-L 0', '-L -1', '-L nope', '-L 4294967296', '-L0', '-L1 src']) {
    it(args + ' fails as an ordinary argument error', async () => {
      const result = await createTerminal(FILES).run('tree ' + args)
      assert.equal(result.stdout, '')
      assert.notEqual(result.stderr, '')
      assert.notEqual(result.exitCode, 0)
      assert.deepEqual(result.unsupported, [])
    })
  }

  it('retains diagnostics for unavailable options alongside a valid depth', async () => {
    for (const [args, detail] of [['--gitignore', '--gitignore'], ["-I 'test|.cache'", '-I'], ['--dirsfirst', '--dirsfirst']]) {
      const command = 'tree -L 2 ' + args
      const direct = await createTerminal(FILES).run(command)
      const hidden = await createTerminal(FILES).run(command + ' 2>/dev/null | head')
      assert.notEqual(direct.exitCode, 0)
      assert.notEqual(direct.stderr, '')
      assert.deepEqual(direct.unsupported.map((note) => [note.command, note.detail]), [['tree', detail]])
      assert.deepEqual(hidden.unsupported, direct.unsupported)
      assert.equal(hidden.stderr, '')
    }
  })
})
