import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = { 'ascii.txt': 'ascii\n', 'café.txt': 'accent\n', '😀.txt': 'astral\n', '[': 'bracket\n' }

describe('glob locale diagnostics', () => {
  it('allows Unicode literal/star matching and leaves voided patterns empty', () => {
    const cases = [
      ["find . -name 'café*'", './café.txt\n'],
      ["find . -name '*.txt' | sort", './ascii.txt\n./café.txt\n./😀.txt\n'],
      ["find . -name '[a-[:digit:]]'", ''],
      ["find . -name '[a-[:digit:]][[.a.]]'", ''],
    ]
    for (const [command, stdout] of cases) {
      assert.deepEqual(createTerminal(FILES).run(command), { stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [] }, command)
    }
  })

  it('mirrors locale gaps for unmatched and escaped metacharacters despite stderr suppression', () => {
    for (const command of [
      "find . -name '[' 2>/dev/null | cat",
      "find . -name '\\?' 2>/dev/null | cat",
      "find . -iname 'CAFÉ.TXT' 2>/dev/null | cat",
    ]) {
      assert.deepEqual(createTerminal(FILES).run(command), {
        stdout: '', stderr: '', exitCode: 0, cwd: '/',
        unsupported: [{
          kind: 'feature', command: 'find', detail: 'non-ASCII glob matching',
          message: 'find: locale-dependent glob matching of non-ASCII names is not supported',
        }],
      }, command)
    }
  })

  it('reports unsupported collating classes before locale-dependent matching', () => {
    assert.deepEqual(createTerminal(FILES).run("find . -name 'é[[.a.]]' 2>/dev/null | cat"), {
      stdout: '', stderr: '', exitCode: 0, cwd: '/',
      unsupported: [{
        kind: 'feature', command: 'find', detail: 'glob collating or equivalence class',
        message: 'find: glob collating symbols and equivalence classes are not supported',
      }],
    })
  })
})
