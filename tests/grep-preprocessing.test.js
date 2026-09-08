import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

function diagnoses(command, files, detail, message, exitCode = 2) {
  const unsupported = [{ kind: 'feature', command: 'grep', detail, message }]
  assert.deepEqual(createTerminal(files).run(command), {
    stdout: '', stderr: message + '\n', exitCode, cwd: '/', unsupported,
  }, command)
  assert.deepEqual(createTerminal(files).run(`${command} 2>/dev/null | cat`), {
    stdout: '', stderr: '', exitCode: 0, cwd: '/', unsupported,
  }, command)
}

const localeMessage = 'grep: locale-sensitive regular expression matching on non-ASCII input is not supported'

describe('grep input preprocessing', () => {
  it('checks Unicode whitespace in every relevant pattern when a literal also matches', () => {
    const files = { text: 'TODO café\n', space: 'TODO\u2003\n' }
    assert.deepEqual(createTerminal(files).run("grep -e TODO -e '[[:space:]]' text"), {
      stdout: 'TODO café\n', stderr: '', exitCode: 0, cwd: '/', unsupported: [],
    })
    diagnoses("grep -e TODO -e '[[:space:]]' space", files, 'non-ASCII regex semantics', localeMessage)
  })

  it('diagnoses a locale-sensitive Unicode pattern even on an empty file', () => {
    diagnoses("grep -e TODO -e 'é.*' empty", { empty: '' }, 'non-ASCII regex semantics', localeMessage)
  })

  it('reports binary input before a locale gap in an earlier file', () => {
    diagnoses("grep -e TODO -e '[[:space:]]' space binary", { space: 'TODO\u2003\n', binary: '\0x\n' },
      'binary input', 'grep: binary input detection and output are not supported')
  })

  const filteredFiles = { 'late.js': 'x'.repeat(100000) + '\0', 'café.js': 'TODO\n' }

  it('finishes filename filtering before inspecting binary contents', () => {
    diagnoses("grep -I --include='?*.js' TODO late.js café.js", filteredFiles,
      'non-ASCII glob matching', 'grep: locale-dependent glob matching of non-ASCII names is not supported', 1)
  })

  it('keeps quiet-mode filename and content checks in operand order', () => {
    diagnoses("grep -Iq --include='?*.js' TODO late.js café.js", filteredFiles,
      'late binary detection', 'grep: grep: binary detection after the initial input buffer is not supported', 1)
  })
})
