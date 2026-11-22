import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Every expectation here was recorded from tree 2.1.1 in C.UTF-8 over the same
// tree on disk, never from what this implementation happened to print.
const FILES = {
  'apps/.cache': { type: 'directory' },
  'apps/.env': '',
  'apps/web/src/index.js': '',
  empty: { type: 'directory' },
  'file.txt': '',
  gone: { type: 'symlink', target: 'nowhere' },
  lnk: { type: 'symlink', target: 'apps' },
  'packages/.npmrc': '',
  'packages/ui/a.js': '',
}

const APPS = 'apps\n└── web\n    └── src\n        └── index.js\n'
const PACKAGES = 'packages\n└── ui\n    └── a.js\n'

const hidden = (paths) => `tree: omitted ${paths.length} hidden ${paths.length === 1 ? 'entry' : 'entries'}: ` +
  paths.map((path) => JSON.stringify(path)).join(', ') + '. Hidden entries are included with -a.'

async function check(command, stdout, { exitCode = 0, notes = [] } = {}) {
  const result = await createTerminal(FILES).run(command)
  assert.deepEqual(
    [result.stdout, result.stderr, result.exitCode, result.unsupported, result.notes],
    [stdout, '', exitCode, [], notes],
    command,
  )
}

describe('tree with several roots', () => {
  it('lists each root in turn and totals them all in one report', async () => {
    await check('tree -a apps packages',
      'apps\n├── .cache\n├── .env\n└── web\n    └── src\n        └── index.js\n' +
      'packages\n├── .npmrc\n└── ui\n    └── a.js\n\n6 directories, 4 files\n')
    await check('tree apps packages', APPS + PACKAGES + '\n5 directories, 2 files\n',
      { notes: [hidden(['/apps/.cache', '/apps/.env', '/packages/.npmrc'])] })
    await check('tree apps apps', APPS + APPS + '\n6 directories, 2 files\n', { notes: [hidden(['/apps/.cache', '/apps/.env'])] })
  })

  it('applies every option to every root', async () => {
    await check('tree -ad apps packages', 'apps\n├── .cache\n└── web\n    └── src\npackages\n└── ui\n\n6 directories\n')
    await check('tree -aF apps/ packages',
      'apps//\n├── .cache/\n├── .env\n└── web/\n    └── src/\n        └── index.js\n' +
      'packages/\n├── .npmrc\n└── ui/\n    └── a.js\n\n6 directories, 4 files\n')
    await check('tree -a --noreport apps packages',
      'apps\n├── .cache\n├── .env\n└── web\n    └── src\n        └── index.js\npackages\n├── .npmrc\n└── ui\n    └── a.js\n')
    await check('tree -a -L 1 apps packages', 'apps\n├── .cache\n├── .env\n└── web\npackages\n├── .npmrc\n└── ui\n\n5 directories, 2 files\n',
      { notes: ['tree: depth limit omitted contents of 2 directories: "/apps/web", "/packages/ui".'] })
  })

  it('counts a root that is empty, a file or a link as it does alone', async () => {
    await check('tree -a empty apps', 'empty\napps\n├── .cache\n├── .env\n└── web\n    └── src\n        └── index.js\n\n4 directories, 2 files\n')
    await check('tree empty empty', 'empty\nempty\n\n0 directories, 0 files\n')
    await check('tree -d empty empty', 'empty\nempty\n\n0 directories\n')
    await check('tree gone file.txt', 'gone  [error opening dir]\nfile.txt  [error opening dir]\n\n0 directories, 2 files\n')
    await check('tree -aF --noreport lnk gone packages',
      'lnk@\n├── .cache/\n├── .env\n└── web/\n    └── src/\n        └── index.js\n' +
      'gone@  [error opening dir]\npackages/\n├── .npmrc\n└── ui/\n    └── a.js\n')
  })

  it('goes on past a root that is not there, and fails with status 2 at the end', async () => {
    await check('tree -a apps missing packages',
      'apps\n├── .cache\n├── .env\n└── web\n    └── src\n        └── index.js\nmissing  [error opening dir]\n' +
      'packages\n├── .npmrc\n└── ui\n    └── a.js\n\n6 directories, 4 files\n', { exitCode: 2 })
    await check('tree missing missing2', 'missing  [error opening dir]\nmissing2  [error opening dir]\n\n0 directories, 0 files\n', { exitCode: 2 })
  })

  it('refuses the whole listing when a later root holds a name it cannot print', async () => {
    const result = await createTerminal({ 'a/file': '', 'b/.hidden': '', 'b/z\nname': '' }).run('tree a b')
    assert.equal(result.stdout, '')
    assert.notEqual(result.exitCode, 0)
    assert.ok(result.unsupported.some(({ command, detail }) => command === 'tree' && detail === 'filename escaping'))
    assert.deepEqual(result.notes, [hidden(['/b/.hidden'])])
  })
})
