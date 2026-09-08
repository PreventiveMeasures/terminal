import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { after, describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { materialize, missing, native } from './helpers/source-tree-reference.js'

const COMMAND = String.raw`find a b -type f \( -name "*.ts" -o -name "*.js" -o -name "*.tsx" \) | grep -v node_modules | head -60`
const FILES = {
  'a/index.ts': 'export const a = 1\n',
  'a/nested/component.tsx': 'export const component = null\n',
  'a/nested/helper.js': 'export const helper = 1\n',
  'a/node_modules/dep/index.ts': 'dependency\n',
  'a/readme.md': 'documentation\n',
  'a/looks.js/notes.txt': 'a directory ending in .js is not a source file\n',
  'b/app.tsx': 'export const app = null\n',
  'b/lib.js': 'export const lib = 1\n',
  'b/nested/types.ts': 'export type B = string\n',
  'b/nested/node_modules/dep/index.tsx': 'nested dependency\n',
  'b/source.ts.bak': 'backup\n',
  'b/looks.ts/notes.txt': 'a directory ending in .ts is not a source file\n',
  'outside/unrelated.ts': 'another root\n',
}
const EXPECTED = 'a/index.ts\na/nested/component.tsx\na/nested/helper.js\nb/app.tsx\nb/lib.js\nb/nested/types.ts\n'

function virtual() {
  const result = createTerminal(FILES).run(COMMAND)
  assert.deepEqual(result.unsupported, [])
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
}

describe('find — escaped grouping from an agent source-tree search', () => {
  it(COMMAND, () => {
    assert.deepEqual(virtual(), { stdout: EXPECTED, stderr: '', exitCode: 0 })
  })
})

describe('find escaped grouping — GNU comparison', {
  skip: missing.length ? 'Missing native tools: ' + missing.join(', ') : false,
}, () => {
  const dir = materialize(FILES)
  after(() => rmSync(dir, { recursive: true, force: true }))
  it(COMMAND, () => {
    const reference = native(COMMAND, dir)
    // Directory enumeration order is filesystem-dependent; this fixture is
    // below the head limit, so compare the complete selected set of lines.
    reference.stdout = reference.stdout.split('\n').filter(Boolean).sort().join('\n') + '\n'
    assert.deepEqual(reference, { stdout: EXPECTED, stderr: '', exitCode: 0 })
    assert.deepEqual(virtual(), reference)
  })
})
