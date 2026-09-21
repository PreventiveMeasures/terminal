import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { createFs } from '../src/fs.js'
import { writableFs } from '../src/writable.js'
import { createIoGuard } from '../src/shell/io.js'
import { unsupportedNote } from '../src/unsupported.js'

const setup = () => writableFs(createFs({ source: 'source\0😀' }, '/repo'))

describe('cp preserves file bytes without weakening shared write guards', () => {
  it('copies malformed UTF-8, NUL, and non-ASCII bytes without decoding', () => {
    const fs = setup()
    const bytes = Uint8Array.of(255, 0, 195, 128, 128, 239, 187, 191)
    fs.openWritable('/', '/tmp/source').writeBytes(bytes)
    assert.equal(fs.copyWritable('/', '/tmp/source', '/tmp/copy'), true)
    assert.deepEqual(fs.fileIdentity('/tmp/copy').bytes, bytes)
    assert.notEqual(fs.fileIdentity('/tmp/source'), fs.fileIdentity('/tmp/copy'))
    assert.notEqual(fs.fileIdentity('/tmp/source').bytes.buffer, fs.fileIdentity('/tmp/copy').bytes.buffer)
    assert.throws(() => fs.readFile('/tmp/copy'), /spell no text/u)
    fs.openWritable('/', '/tmp/source').write('changed')
    assert.deepEqual(fs.fileIdentity('/tmp/copy').bytes, bytes)
  })

  it('preserves the mounted source and overwrites an existing destination inode', () => {
    const fs = setup()
    const append = fs.openWritable('/', '/tmp/copy', true)
    append.write('longer stale content')
    assert.equal(fs.copyWritable('/tmp', '/repo/source', './copy'), true)
    assert.equal(fs.fileIdentity('/tmp/copy'), append.identity)
    append.write(' tail')
    assert.equal(fs.readFile('/tmp/copy'), 'source\0😀 tail')
    assert.equal(fs.readFile('/repo/source'), 'source\0😀')
    assert.equal(fs.copyWritable('/', '/tmp/copy', '/repo/source'), false)
    assert.equal(fs.readFile('/repo/source'), 'source\0😀')
  })

  it('rejects copying an inode to itself before truncating its bytes', () => {
    const fs = setup()
    fs.openWritable('/', '/tmp/source').write('unchanged')
    assert.throws(() => fs.copyWritable('/', '/tmp/source', '/tmp/./source'), /same file/u)
    assert.equal(fs.readFile('/tmp/source'), 'unchanged')
  })

  for (const target of ['/tmp/args', '/tmp/./args']) {
    it(`cannot truncate an ancestor's active input at ${target}`, async () => {
      const fs = setup()
      fs.openWritable('/', '/tmp/args').write('arguments')
      const io = createIoGuard(fs)
      await assert.rejects(() => io.run('future-reader', async () => {
        fs.readFile('/tmp/args')
        await io.run('cp', () => fs.copyWritable('/', '/repo/source', target))
      }), (error) => {
        assert.equal(unsupportedNote(error).command, 'future-reader')
        assert.equal(unsupportedNote(error).detail, 'streaming self-output')
        return true
      })
      assert.equal(fs.readFile('/tmp/args'), 'arguments')
    })
  }

  it('keeps byte writes guarded even when the descriptor predates the read', async () => {
    const fs = setup()
    const handle = fs.openWritable('/', '/tmp/source', true)
    handle.write('unchanged')
    const io = createIoGuard(fs)
    await assert.rejects(() => io.run('future-reader', () => {
      fs.readFile('/tmp/source')
      handle.writeBytes(Uint8Array.of(255))
    }), /actively read input/u)
    assert.equal(fs.readFile('/tmp/source'), 'unchanged')
  })

  it('copies an invalid byte sequence created through shell descriptors successfully', async () => {
    const terminal = createTerminal({}, { mount: '/repo', writable: '/tmp/' })
    const success = { stdout: '', stderr: '', exitCode: 0, cwd: '/repo', notes: [], unsupported: [] }
    assert.deepEqual(await terminal.run('{ printf é >/tmp/raw; printf X; } >/tmp/raw'), success)
    assert.deepEqual(await terminal.run('cp /tmp/raw /tmp/copy'), success)
    assert.deepEqual(await terminal.run('printf changed >/tmp/raw'), success)
    // The bytes travel: the pipe takes them, and a reader of bytes reads the
    // copy the shell made.
    assert.equal((await terminal.run('cat /tmp/copy | base64')).stdout, 'WKk=\n')
    assert.equal((await terminal.run('cat /tmp/copy | wc -c')).stdout, '2\n')
    // It is the terminal's own output, a string, that cannot carry them — so
    // the command writing them there is the one that says so.
    const result = await terminal.run('cat /tmp/copy 2>/dev/null | cat')
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'cat: byte output that is not valid UTF-8 cannot be represented by this string-based terminal\n')
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.unsupported.map(({ detail }) => detail), ['partial UTF-8 byte sequence'])
  })
})
