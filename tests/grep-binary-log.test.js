import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const COMMAND = String.raw`cd / && grep -rIn "a\|\.x\b\|y" d/f packages --include="*.ts" | head -20`
const FILES = {
  'd/f/first.ts': 'a\nobj.x\nobj.xq\nobj.x_\nobj.x2\nobj.x;\nA\nY\nquiet\nonly y\n',
  'd/f/binary.ts': 'a\n\0\nobj.x\ny\n',
  'd/f/excluded.js': 'a\nobj.x\ny\n',
  'd/f/excluded.tsx': 'a\n',
  'd/f/with space.ts': 'a\n',
  'packages/index.ts': 'y\n.x!\nx\n',
  'packages/nested/helper.ts': 'Y\nobj.x_\nobj.x2\nz.x-\nz\n',
  'packages/nested/binary.ts': 'a\nobj.x\n\0\n',
  'other/ignored.ts': 'a\n',
}
const EXPECTED = 'd/f/first.ts:1:a\nd/f/first.ts:2:obj.x\nd/f/first.ts:6:obj.x;\nd/f/first.ts:10:only y\n'
  + 'd/f/with space.ts:1:a\npackages/index.ts:1:y\npackages/index.ts:2:.x!\npackages/nested/helper.ts:4:z.x-\n'

function virtual() {
  // The logged cd must change the working directory before either relative
  // search root resolves. Uppercase -I must not become case-insensitive -i.
  const result = createTerminal(FILES, { cwd: '/packages/nested' }).run(COMMAND)
  assert.deepEqual(result.unsupported, [])
  assert.equal(result.cwd, '/')
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
}

describe('grep — recursive binary exclusion from an agent log', () => {
  it(COMMAND, () => {
    assert.deepEqual(virtual(), { stdout: EXPECTED, stderr: '', exitCode: 0 })
  })
})
