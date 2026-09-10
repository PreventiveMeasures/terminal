import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { createFs } from '../src/fs.js'
import { writableFs } from '../src/writable.js'
import { missingPathNote } from '../src/notes.js'

const options = { mount: '/repo', cwd: '/repo/sub', writable: '/tmp/' }
const prefix = 'cat: relative path "tmp/file" was not found from cwd "/repo/sub". '
const both = 'Both of "/repo/tmp/file" and "/tmp/file" exist'
const expected = (ending) => ({ stdout: '', stderr: 'cat: tmp/file: no such file or directory\n', exitCode: 1, cwd: '/repo/sub', unsupported: [], notes: [prefix + ending] })

function terminalWithFiles(mounted, overlay) {
  const terminal = createTerminal({ 'tmp/file': mounted, 'sub/keep': '', overlay }, options)
  assert.equal(terminal.run('cp /repo/overlay /tmp/file').exitCode, 0)
  return terminal
}

describe('missing-path notes describe alternative file kinds and contents', () => {
  for (const [label, mounted, overlay, differ] of [
    ['empty files', '', '', false],
    ['equal text', 'same\n', 'same\n', false],
    ['equal NUL bytes', 'a\0b\0', 'a\0b\0', false],
    ['equal Unicode', 'é😀日本語\n', 'é😀日本語\n', false],
    ['different ASCII', 'mounted\n', 'overlay\n', true],
    ['one empty file', '', 'x', true],
    ['different final newline', 'text\n', 'text', true],
    ['different line endings', 'text\r\n', 'text\n', true],
    ['different NUL bytes', 'a\0b', 'a\0c', true],
    ['different Unicode', 'é😀', 'é😁', true],
    ['different Unicode normalization', 'é', 'e\u0301', true],
  ]) {
    it(label, () => {
      const terminal = terminalWithFiles(mounted, overlay)
      assert.deepEqual(terminal.run('cat tmp/file'), expected(both + (differ ? ', and they differ in contents.' : '.')))
      assert.equal(terminal.run('cat /repo/tmp/file').stdout, mounted)
      assert.equal(terminal.run('cat /tmp/file').stdout, overlay)
    })
  }

  for (const [sources, path, kind, absolute] of [
    [{ file: '' }, 'file', 'file', '/repo/file'],
    [{ 'dir/keep': '' }, 'dir', 'dir', '/repo/dir'],
    [{}, 'tmp', 'dir', '/tmp'],
  ]) {
    it(`describes a single ${kind} alternative at ${absolute}`, () => {
      const result = createTerminal({ ...sources, 'sub/keep': '' }, options).run('cat ' + path)
      assert.equal(result.exitCode, 1)
      assert.deepEqual(result.unsupported, [])
      assert.deepEqual(result.notes, [`cat: relative path "${path}" was not found from cwd "/repo/sub". A ${kind} exists at "${absolute}".`])
    })
  }

  for (const [name, sources] of [
    ['two directories with different entries', { 'tmp/only-in-mount': 'contents' }],
    ['one file and one directory', { tmp: 'contents' }],
  ]) {
    it(`does not claim a content difference for ${name}`, () => {
      const terminal = createTerminal({ ...sources, 'sub/keep': '' }, options)
      const result = terminal.run('cat tmp')
      assert.equal(result.exitCode, 1)
      assert.deepEqual(result.unsupported, [])
      assert.deepEqual(result.notes, ['cat: relative path "tmp" was not found from cwd "/repo/sub". Both of "/repo/tmp" and "/tmp" exist.'])
    })
  }

  it('describes root-mounted paths only once', () => {
    const terminal = createTerminal({ file: '', 'sub/keep': '' }, { cwd: '/sub' })
    assert.deepEqual(terminal.run('cat file').notes, ['cat: relative path "file" was not found from cwd "/sub". A file exists at "/file".'])
  })

  for (const [root, mounted, differ] of [['same', 'same', false], ['first', 'other', true], ['\uD800', '\uD800', false]]) {
    it('compares two mounted source files without an overlay', () => {
      const terminal = createTerminal({ file: root, 'repo/file': mounted, 'sub/keep': '' }, { mount: '/repo', cwd: '/repo/sub' })
      const result = terminal.run('cat repo/file')
      assert.equal(result.exitCode, 1)
      assert.deepEqual(result.unsupported, [])
      assert.deepEqual(result.notes, [`cat: relative path "repo/file" was not found from cwd "/repo/sub". Both of "/repo/file" and "/repo/repo/file" exist${differ ? ', and they differ in contents' : ''}.`])
    })
  }
})

describe('alternative comparisons are observational', () => {
  for (const [line, output, stderr, fileContent] of [
    ['cat tmp/file 2>>/tmp/file', '', '', 'overlay\ncat: tmp/file: no such file or directory\n'],
    ['cat tmp/file /repo/overlay >>/tmp/file', '', 'cat: tmp/file: no such file or directory\n', 'overlay\noverlay\n'],
  ]) {
    it(`preserves output behavior for ${line}`, () => {
      const terminal = terminalWithFiles('mounted\n', 'overlay\n')
      const result = terminal.run(line)
      assert.deepEqual(result, { ...expected(both + ', and they differ in contents.'), stdout: output, stderr })
      assert.equal(terminal.run('cat /tmp/file').stdout, fileContent)
    })
  }

  it('does not convert malformed overlay bytes into a diagnostic or replacement characters', () => {
    const fs = writableFs(createFs({ 'tmp/file': '\uFFFD', 'sub/keep': '' }, '/repo'))
    fs.openWritable('/', '/tmp/file').writeBytes(Uint8Array.of(255))
    const notes = new Set()
    assert.doesNotThrow(() => missingPathNote({ fs, notes, mount: '/repo', cwd: '/repo/sub' }, 'cat', 'tmp/file', 'No such file or directory'))
    assert.deepEqual([...notes], [prefix + both + ', and they differ in contents.'])
    assert.deepEqual(fs.fileIdentity('/tmp/file').bytes, Uint8Array.of(255))
  })

  it('compares only the live bytes of an overlay file', () => {
    const fs = writableFs(createFs({ 'tmp/file': 'same', 'sub/keep': '' }, '/repo'))
    const handle = fs.openWritable('/', '/tmp/file')
    handle.write('sam')
    handle.write('e')
    assert.ok(handle.identity.bytes.byteLength < handle.identity.bytes.buffer.byteLength)
    const notes = new Set()
    missingPathNote({ fs, notes, mount: '/repo', cwd: '/repo/sub' }, 'cat', 'tmp/file', 'No such file or directory')
    assert.deepEqual([...notes], [prefix + both + '.'])
  })

  it('does not register comparison reads with the command I/O observer', () => {
    const fs = writableFs(createFs({ 'tmp/file': 'same', 'sub/keep': '' }, '/repo'))
    fs.openWritable('/', '/tmp/file').write('same')
    fs.observeIo({ read: () => assert.fail('notes must not register command reads'), write: () => assert.fail('notes must not write') })
    const notes = new Set()
    missingPathNote({ fs, notes, mount: '/repo', cwd: '/repo/sub' }, 'cat', 'tmp/file', 'No such file or directory')
    assert.deepEqual([...notes], [prefix + both + '.'])
  })

  it('does not confuse an ill-formed source string with replacement-character bytes', () => {
    const fs = writableFs(createFs({ 'tmp/file': '\uD800', 'sub/keep': '' }, '/repo'))
    fs.openWritable('/', '/tmp/file').write('\uFFFD')
    const notes = new Set()
    assert.doesNotThrow(() => missingPathNote({ fs, notes, mount: '/repo', cwd: '/repo/sub' }, 'cat', 'tmp/file', 'No such file or directory'))
    assert.deepEqual([...notes], [prefix + both + ', and they differ in contents.'])
  })

  it('does not read or descend into directory alternatives', () => {
    const fs = writableFs(createFs({ 'tmp/child/keep': 'different', 'sub/keep': '' }, '/repo'))
    fs.readFile = () => assert.fail('directory alternatives must not be read')
    fs.listDir = () => assert.fail('directory alternatives must not be compared recursively')
    fs.sameFileContents = () => assert.fail('directory alternatives must not be compared')
    const notes = new Set()
    missingPathNote({ fs, notes, mount: '/repo', cwd: '/repo/sub' }, 'cat', 'tmp', 'No such file or directory')
    assert.deepEqual([...notes], ['cat: relative path "tmp" was not found from cwd "/repo/sub". Both of "/repo/tmp" and "/tmp" exist.'])
  })
})
