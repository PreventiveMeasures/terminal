import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// A file the search cannot read is that file's trouble: what the files it
// could read matched is written all the same, so `stdout` is what survives
// the gap rather than always nothing.
async function diagnoses(command, files, detail, message, exitCode = 2, stdout = '') {
  const unsupported = [{ kind: 'feature', command: 'grep', detail, message }]
  assert.deepEqual(await createTerminal(files).run(command), {
    stdout, stderr: message + '\n', exitCode, cwd: '/', notes: [], unsupported,
  }, command)
  assert.deepEqual(await createTerminal(files).run(`${command} 2>/dev/null | cat`), {
    stdout, stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported,
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
    // The binary gap still wins over the locale one, and the file that could
    // be read still reports what it matched.
    await diagnoses("grep -e TODO -e '[[:space:]]' space binary", { space: 'TODO\u2003\n', binary: '\0x\n' },
      'binary input', 'grep: binary input detection and output are not supported', 2, 'space:TODO\u2003\n')
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

// One file a search cannot read does not take the rest of the tree with it.
// GNU keeps the matches from the files it could read and names the one it
// could not; this keeps the matches and says what it could not do, which is
// the part of that it can say.
describe('a file it cannot search is that file, not the search', () => {
  const tree = { 'bt/a.txt': 'apple\n', 'bt/c.txt': 'apple pie\n', 'bt/bin.dat': Uint8Array.of(0x61, 0x70, 0x70, 0x6c, 0x65, 0x00, 0xff, 0x0a) }
  const binaryGap = [{ kind: 'feature', command: 'grep', detail: 'binary input', message: 'grep: binary input detection and output are not supported' }]

  it('keeps what the readable files matched', async () => {
    const r = await createTerminal(tree).run('grep -r apple bt')
    assert.equal(r.stdout, 'bt/a.txt:apple\nbt/c.txt:apple pie\n')
    assert.deepEqual(r.unsupported, binaryGap)
    assert.equal(r.exitCode, 2)
  })

  it('is the gap itself when nothing is left to read', async () => {
    const r = await createTerminal(tree).run('grep apple bt/bin.dat')
    assert.equal(r.stdout, '')
    assert.deepEqual(r.unsupported, binaryGap)
    assert.equal(r.exitCode, 2)
  })

  it('says nothing of a binary file no pattern selects', async () => {
    const r = await createTerminal(tree).run('grep -r pear bt')
    assert.deepEqual(r, { stdout: '', stderr: '', exitCode: 1, cwd: '/', notes: [], unsupported: [] })
  })
})
