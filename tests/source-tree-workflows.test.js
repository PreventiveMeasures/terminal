import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { after, describe, it } from 'node:test'
import { URL } from 'node:url'
import { createTerminal } from '@preventive/terminal'
import { SOURCE_TREES } from './fixtures/source-tree-files.js'
import { COMMANDS, materialize, missing, native, snapshotRepository } from './helpers/source-tree-reference.js'

const expected = JSON.parse(readFileSync(new URL('./fixtures/source-tree-expected.json', import.meta.url), 'utf8'))
function result(files, command) {
  const r = createTerminal(files).run(command)
  assert.deepEqual(r.unsupported, [], command + ': unsupported does not count as success')
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }
}

it('defines exactly 50 source analysis workflows', () => {
  assert.deepEqual(COMMANDS.map((c) => c.id), Array.from({ length: 50 }, (_, i) => i + 1))
  assert.equal(new Set(COMMANDS.map((c) => c.command)).size, 50)
})
for (const [tree, files] of Object.entries(SOURCE_TREES)) {
  describe(`50 source analysis workflows — ${tree}, frozen native results`, () => {
    for (const [i, { id, purpose, command }] of COMMANDS.entries()) {
      it(`${id}. ${purpose}`, () => {
        assert.equal(expected.trees[tree][i].id, id)
        const ref = { ...expected.trees[tree][i] }
        delete ref.id
        assert.deepEqual(result(files, command), ref, command)
      })
    }
  })
}

describe('50 source analysis workflows — live native comparison', { skip: missing.length ? `Missing native tools: ${missing.join(', ')}` : false }, () => {
  for (const [tree, files] of Object.entries({ ...SOURCE_TREES, repository: snapshotRepository() })) {
    const dir = materialize(files)
    after(() => rmSync(dir, { recursive: true, force: true }))
    for (const { id, command } of COMMANDS) {
      it(`${tree} ${id}: ${command}`, () => {
        assert.deepEqual(result(files, command), native(command, dir), command)
      })
    }
  }
})
