import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createFs } from '../src/fs.js'
import { writableFs } from '../src/writable.js'

const setup = () => writableFs(createFs({ source: 'original' }, '/repo'))

describe('separate writable filesystem layer', () => {
  it('leaves the mounted layer and its directory index untouched', () => {
    const base = createFs({ source: 'original' }, '/repo')
    const fs = writableFs(base)
    fs.openWritable('/', '/tmp/source').write('copy')
    assert.equal(fs.readFile('/repo/source'), 'original')
    assert.equal(fs.readFile('/tmp/source'), 'copy')
    assert.equal(base.readFile('/tmp/source'), undefined)
    assert.equal(base.isDir('/tmp'), false)
    assert.deepEqual(base.listDir('/'), { dirs: ['repo'], files: [] })
    assert.deepEqual(fs.listDir('/'), { dirs: ['repo', 'tmp'], files: [] })
  })

  it('creates or truncates at open, and advances the shared descriptor offset', () => {
    const fs = setup()
    const handle = fs.openWritable('/', '/tmp/file')
    assert.equal(handle.path, '/tmp/file')
    assert.equal(fs.readFile(handle.path), '')
    handle.write('abc')
    handle.write('def')
    assert.equal(fs.readFile(handle.path), 'abcdef')
    fs.openWritable('/', handle.path)
    assert.equal(fs.readFile(handle.path), '')
    handle.write('X')
    assert.equal(fs.readFile(handle.path), '\0'.repeat(6) + 'X')
  })

  it('append descriptors seek to the current end on every write', () => {
    const fs = setup()
    const first = fs.openWritable('/', '/tmp/file', true)
    const second = fs.openWritable('/', '/tmp/file', true)
    first.write('a')
    second.write('b')
    first.write('c')
    assert.equal(fs.readFile('/tmp/file'), 'abc')
    fs.openWritable('/', '/tmp/file').write('new')
    second.write(' tail')
    assert.equal(fs.readFile('/tmp/file'), 'new tail')
  })

  it('independent opens have independent offsets, measured in UTF-8 bytes', () => {
    const fs = setup()
    const first = fs.openWritable('/', '/tmp/file')
    const second = fs.openWritable('/', '/tmp/file')
    first.write('éZ')
    second.write('XY')
    assert.equal(fs.readFile('/tmp/file'), 'XYZ')
    first.write('!')
    assert.equal(fs.readFile('/tmp/file'), 'XYZ!')
  })

  it('does not silently replace invalid UTF-8 left by overlapping writes', () => {
    const fs = setup()
    const first = fs.openWritable('/', '/tmp/file')
    const second = fs.openWritable('/', '/tmp/file')
    first.write('é')
    second.write('X')
    assert.throws(() => fs.readFile('/tmp/file'), /not valid UTF-8/u)
  })

  it('uses full normalized paths, even when a file is opened relative to cwd', () => {
    const fs = setup()
    const file = fs.openWritable('/tmp', './file')
    assert.equal(file.path, '/tmp/file')
    file.write('content\0tail')
    assert.equal(fs.readFile('/tmp/file'), 'content\0tail')
    assert.equal(fs.readFile('file'), undefined)
    assert.equal(fs.readFile('./file'), undefined)
    assert.deepEqual([...fs.walkFiles('/')], ['/repo/source', '/tmp/file'])
  })

  it('never writes to the source tree or paths outside the overlay', () => {
    const fs = setup()
    for (const path of ['/repo/source', '/tmp/../repo/source', '/tmp2/file', '/tmp-other/file', '/']) {
      assert.equal(fs.openWritable('/', path), null, path)
    }
    assert.equal(fs.readFile('/repo/source'), 'original')
    assert.deepEqual(fs.listDir('/tmp'), { dirs: [], files: [] })
  })

  it('rejects missing or nondirectory components before collapsing dot-dot', () => {
    const fs = setup()
    fs.openWritable('/', '/tmp/file').write('file')
    for (const path of ['/tmp', '/tmp/', '/tmp/missing/child', '/tmp/missing/../sibling', '/tmp/file/../sibling', '/tmp/bad\0name']) {
      assert.throws(() => fs.openWritable('/', path), undefined, path)
    }
    assert.deepEqual(fs.listDir('/tmp'), { dirs: [], files: ['file'] })
  })

  it('invalidates directory listings when another overlay file is created', () => {
    const fs = setup()
    assert.deepEqual(fs.listDir('/tmp'), { dirs: [], files: [] })
    fs.openWritable('/', '/tmp/z')
    assert.deepEqual(fs.listDir('/tmp'), { dirs: [], files: ['z'] })
    fs.openWritable('/', '/tmp/a')
    assert.deepEqual(fs.listDir('/tmp'), { dirs: [], files: ['a', 'z'] })
    assert.deepEqual([...fs.walkFiles('/tmp')], ['/tmp/a', '/tmp/z'])
  })

  it('atomic replacement leaves open descriptors attached to the backed-up file', () => {
    const fs = setup()
    const handle = fs.openWritable('/tmp', 'file')
    handle.write('original')
    const append = fs.openWritable('/tmp', 'file', true)
    assert.equal(fs.replaceWritable('/tmp', 'file', 'replacement', 'file.bak'), true)
    handle.write('!')
    append.write('?')
    assert.equal(fs.readFile('/tmp/file'), 'replacement')
    assert.equal(fs.readFile('/tmp/file.bak'), 'original!?')
  })

  it('replacement without backup detaches open descriptors from the pathname', () => {
    const fs = setup()
    const handle = fs.openWritable('/tmp', 'file', true)
    handle.write('old')
    assert.equal(fs.replaceWritable('/tmp', 'file', 'new'), true)
    handle.write('!')
    assert.equal(fs.readFile('/tmp/file'), 'new')
    fs.openWritable('/tmp', 'file', true).write(' tail')
    assert.equal(fs.readFile('/tmp/file'), 'new tail')
  })

  it('validates both paths before replacing or backing up anything', () => {
    const fs = setup()
    fs.openWritable('/tmp', 'file').write('old')
    assert.equal(fs.replaceWritable('/tmp', 'file', 'new', '/repo/source'), false)
    assert.throws(() => fs.replaceWritable('/tmp', 'file', 'new', 'missing/backup'), /No such file/u)
    assert.throws(() => fs.replaceWritable('/tmp', 'file/../file', 'new', 'backup'), /Not a directory/u)
    assert.equal(fs.readFile('/tmp/file'), 'old')
    assert.equal(fs.readFile('/repo/source'), 'original')
    assert.deepEqual(fs.listDir('/tmp'), { dirs: [], files: ['file'] })
  })
})
