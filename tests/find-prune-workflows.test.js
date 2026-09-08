import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { after, describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { materialize, missing, native } from './helpers/source-tree-reference.js'

const FILES = {
  'README.md': 'readme\n',
  'src/index.js': 'main\n',
  'src/[b]/c.ts': 'brackets\n',
  'src/space name.js': 'space\n',
  'src/nested/child.js': 'nested\n',
  'src/nested/node_modules/dep.js': 'nested dependency\n',
  'node_modules/top/index.js': 'top dependency\n',
  '.git/config': 'git metadata\n',
  'dist/bundle.js': 'generated\n',
}
const EXCLUDE = String.raw`\( -name node_modules -o -name .git -o -name dist \) -prune`
const SOURCE_PATHS = './README.md\n./src/[b]/c.ts\n./src/index.js\n./src/nested/child.js\n./src/space name.js\n'
const CASES = [
  ['find . ' + EXCLUDE + ' -o -type f -print | sort', SOURCE_PATHS],
  ['find . -type d ' + EXCLUDE + ' -o -type f -print | sort', SOURCE_PATHS],
  [String.raw`find src -path 'src/[[]b]' -prune -o -name node_modules -prune -o -type f -print | sort`,
    'src/index.js\nsrc/nested/child.js\nsrc/space name.js\n'],
  [String.raw`find src/\[b\] -prune`, 'src/[b]\n'],
  ['find . -name node_modules -prune | sort',
    './node_modules\n./src/nested/node_modules\n'],
  ['find . ' + EXCLUDE + ' -o -type f -print0 | sort -z | xargs -0 cat',
    'readme\nbrackets\nmain\nnested\nspace\n'],
  ['find . ' + EXCLUDE + String.raw` -o -type f -exec echo {} \; | sort`, SOURCE_PATHS],
  ['find . ' + EXCLUDE + ' -o -type f -exec cat {} + | sort',
    'brackets\nmain\nnested\nreadme\nspace\n'],
  ['find . ! -prune -o -print', '.\n'],
]

function virtual(command) {
  const r = createTerminal(FILES).run(command)
  assert.deepEqual(r.unsupported, [], command)
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }
}

describe('find -prune — source-tree exclusion regressions', () => {
  for (const [command, stdout] of CASES) {
    it(command, () => assert.deepEqual(virtual(command), { stdout, stderr: '', exitCode: 0 }))
  }
  it('does not execute or diagnose commands behind a successful prune branch', () => {
    const command = String.raw`find node_modules -prune -o -exec jq . {} \;`
    assert.deepEqual(virtual(command), { stdout: '', stderr: '', exitCode: 0 })
  })
  it('preserves diagnostics from commands reached in the unpruned branch', () => {
    const command = 'find . ' + EXCLUDE + String.raw` -o -type f -exec jq . {} \; 2>/dev/null | true`
    const r = createTerminal(FILES).run(command)
    assert.equal(r.stderr, '')
    assert.equal(r.exitCode, 0)
    assert.deepEqual(r.unsupported.map(({ kind, command: owner, detail }) => ({ kind, command: owner, detail })), [
      { kind: 'command', command: 'jq', detail: 'jq' },
    ])
  })
})

describe('find -prune — strict GNU comparison', {
  skip: missing.length ? 'Missing native tools: ' + missing.join(', ') : false,
}, () => {
  const dir = materialize(FILES)
  after(() => rmSync(dir, { recursive: true, force: true }))
  for (const [command, stdout] of CASES) {
    it(command, () => {
      const ref = native(command, dir)
      assert.deepEqual(ref, { stdout, stderr: '', exitCode: 0 })
      assert.deepEqual(virtual(command), ref)
    })
  }
})
