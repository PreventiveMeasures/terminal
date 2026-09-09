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

function check(command, stdout, files = FILES) {
  const result = createTerminal(files).run(command)
  assert.deepEqual([result.stdout, result.stderr, result.exitCode, result.unsupported], [stdout, '', 0, []], command)
}

describe('tree -L depth limits', () => {
  const shallow = '.\n├── README.md\n├── src\n└── test\n\n3 directories, 1 file\n'
  for (const command of ['tree -L 1', 'tree -L1', 'tree . -L1', 'tree -L3 -L1']) {
    it(command + ' lists direct children only', () => check(command, shallow))
  }

  it('limits displayed entries and report totals at depth two', () => {
    check('tree -L 2', '.\n├── README.md\n├── src\n│   ├── main.js\n│   └── nested\n└── test\n    └── main.test.js\n\n4 directories, 3 files\n')
  })

  it('counts depth relative to the selected root', () => {
    check('tree -L2 src', 'src\n├── main.js\n└── nested\n    ├── deep\n    └── util.js\n\n3 directories, 2 files\n')
    check('cd src && tree -L1', '.\n├── main.js\n└── nested\n\n2 directories, 1 file\n')
  })

  it('combines bundled flags, hidden entries, and omitted reports', () => {
    check('tree -aFL1 --noreport', './\n├── .cache/\n├── README.md\n├── src/\n└── test/\n')
    check('tree -adL2 src', 'src\n└── nested\n    └── deep\n\n3 directories\n')
  })

  it('handles an empty directory and limits beyond the deepest entry', () => {
    check('tree -L1', '.\n\n0 directories, 0 files\n', {})
    const terminal = createTerminal(FILES)
    assert.deepEqual(terminal.run('tree -L2147483647'), terminal.run('tree'))
  })

  it('does not inspect names below the depth cutoff', () => {
    const files = { 'src/bad\nname': '' }
    check('tree -L1', '.\n└── src\n\n2 directories, 0 files\n', files)
    const result = createTerminal(files).run('tree -L2 2>/dev/null | cat')
    assert.equal(result.stderr, '')
    assert.deepEqual(result.unsupported.map(({ command, detail }) => [command, detail]), [['tree', 'filename escaping']])
  })

  for (const args of ['-L', '-L0', '-L-1', '-Lnope', '-L1.5', '-L2147483648']) {
    it(args + ' fails as an ordinary argument error', () => {
      const result = createTerminal(FILES).run('tree ' + args)
      assert.equal(result.stdout, '')
      assert.notEqual(result.stderr, '')
      assert.notEqual(result.exitCode, 0)
      assert.deepEqual(result.unsupported, [])
    })
  }

  it('retains diagnostics for unavailable options alongside a valid depth', () => {
    for (const [args, detail] of [['--gitignore', '--gitignore'], ["-I 'test|.cache'", '-I'], ['--dirsfirst', '--dirsfirst']]) {
      const command = 'tree -L2 ' + args
      const direct = createTerminal(FILES).run(command)
      const hidden = createTerminal(FILES).run(command + ' 2>/dev/null | head')
      assert.notEqual(direct.exitCode, 0)
      assert.notEqual(direct.stderr, '')
      assert.deepEqual(direct.unsupported.map((note) => [note.command, note.detail]), [['tree', detail]])
      assert.deepEqual(hidden.unsupported, direct.unsupported)
      assert.equal(hidden.stderr, '')
    }
  })
})
