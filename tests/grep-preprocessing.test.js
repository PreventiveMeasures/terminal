import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

async function diagnoses(command, files, detail, message, exitCode = 2) {
  const unsupported = [{ kind: 'feature', command: 'grep', detail, message }]
  assert.deepEqual(await createTerminal(files).run(command), {
    stdout: '', stderr: message + '\n', exitCode, cwd: '/', notes: [], unsupported,
  }, command)
  assert.deepEqual(await createTerminal(files).run(`${command} 2>/dev/null | cat`), {
    stdout: '', stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported,
  }, command)
}

const localeMessage = 'grep: case-insensitive matching with backreferences on non-ASCII input is not supported'

describe('grep input preprocessing', () => {
  it('reads Unicode whitespace from the C.UTF-8 tables in every pattern', async () => {
    const files = { text: 'TODO café\n', space: 'TODO\u2003\n' }
    assert.deepEqual(await createTerminal(files).run("grep -e TODO -e '[[:space:]]' text"), {
      stdout: 'TODO café\n', stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [],
    })
    assert.deepEqual(await createTerminal(files).run("grep -e TODO -e '[[:space:]]' space"), {
      stdout: 'TODO\u2003\n', stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [],
    })
  })

  it('diagnoses a pattern the tables cannot answer even on an empty file', async () => {
    await diagnoses("grep -i -e TODO -e '\\(é\\)\\1' empty", { empty: '' }, 'non-ASCII regex semantics', localeMessage)
  })

  it('reports binary input before a locale gap in an earlier file', async () => {
    await diagnoses("grep -e TODO -e '[[:space:]]' space binary", { space: 'TODO\u2003\n', binary: '\0x\n' },
      'binary input', 'grep: binary input detection and output are not supported')
  })

  const filteredFiles = { 'late.js': 'x'.repeat(100000) + '\0', 'café.js': 'TODO\n' }

  it('finishes filename filtering before inspecting binary contents', async () => {
    await diagnoses("grep -I --include='?*.js' TODO late.js café.js", filteredFiles,
      'non-ASCII glob matching', 'grep: locale-dependent glob matching of non-ASCII names is not supported', 1)
  })

  it('keeps quiet-mode filename and content checks in operand order', async () => {
    await diagnoses("grep -Iq --include='?*.js' TODO late.js café.js", filteredFiles,
      'late binary detection', 'grep: grep: binary detection after the initial input buffer is not supported', 1)
  })
})
