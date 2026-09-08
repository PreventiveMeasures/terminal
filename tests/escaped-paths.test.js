import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { after, describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { materialize, missing, native } from './helpers/source-tree-reference.js'

const CONTENT = 'export const bracketed = true;\n'
const SECOND = 'export const second = true;\n'
const FILES = {
  'a/[b]/c.ts': CONTENT,
  'a/[b]/d.ts': SECOND,
  // This decoy catches loss of the quote mask: [b] would glob to b.
  'a/b/c.ts': 'wrong glob match\n',
  // Double quotes preserve backslashes before brackets. Those bytes must
  // remain distinguishable from the escaping in the user's bare path.
  'a/\\[b\\]/c.ts': 'literal backslashes\n',
}
const CASES = [
  [String.raw`cat a/\[b\]/c.ts`, CONTENT],
  [`cat 'a/[b]/c.ts'`, CONTENT],
  [`cat "a/[b]/c.ts"`, CONTENT],
  [`cat a/'[b]'/c.ts`, CONTENT],
  [String.raw`cat a/\[b]/c.ts`, CONTENT],
  [String.raw`cat a/\[b\]/*.ts`, CONTENT + SECOND],
  [`cat "a/[b]/"*.ts`, CONTENT + SECOND],
  [String.raw`cat < a/\[b\]/c.ts`, CONTENT],
  [String.raw`(cd a/\[b\]; cat c.ts)`, CONTENT],
  [String.raw`file=a/\[b\]/c.ts; cat "$file"`, CONTENT],
  [`file='a/[b]/c.ts'; cat "$file"`, CONTENT],
  [String.raw`for file in a/\[b\]/*.ts; do cat "$file"; done`, CONTENT + SECOND],
  [String.raw`find a/\[b\] -name c.ts -exec cat {} \;`, CONTENT],
  [`echo 'a/[b]/c.ts' | xargs cat`, CONTENT],
  [String.raw`grep -n export a/\[b\]/c.ts`, '1:' + CONTENT],
  ['cat a/[b]/c.ts', 'wrong glob match\n'],
  [`file='a/[b]/c.ts'; cat $file`, 'wrong glob match\n'],
  [String.raw`cat "a/\[b\]/c.ts"`, 'literal backslashes\n'],
  [String.raw`file='a/\[b\]/c.ts'; cat "$file"`, 'literal backslashes\n'],
]

function virtual(command) {
  const r = createTerminal(FILES).run(command)
  assert.deepEqual(r.unsupported, [], command)
  assert.equal(r.cwd, '/', command)
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }
}

describe('escaped bracket paths — shell regression cases', () => {
  for (const [command, stdout] of CASES) {
    it(command, () => assert.deepEqual(virtual(command), { stdout, stderr: '', exitCode: 0 }))
  }

  it('reports an absent literal path without retaining shell escape characters', () => {
    assert.deepEqual(virtual(String.raw`cat a/\[missing\]/c.ts`), {
      stdout: '', stderr: 'cat: a/[missing]/c.ts: no such file or directory\n', exitCode: 1,
    })
  })
})

describe('escaped bracket paths — strict Bash and GNU comparison', {
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

