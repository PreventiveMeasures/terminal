import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createFs, lookup, walkTree } from '../src/fs.js'

describe('filesystem index and traversal', () => {
  it('preserves normalized collisions and Unicode order across directory and file lists', () => {
    const fs = createFs({
      'z.txt': 'last',
      '\uE000': 'BMP',
      '😀/leaf': 'astral child',
      '😀': 'astral file',
      'a/child': 'old',
      a: 'colliding file',
      'a/./child': 'replacement',
      'root/../m.txt': 'middle',
      ignored: null,
    })
    assert.deepEqual(fs.listDir('/'), { dirs: ['a', '😀'], files: ['a', 'm.txt', 'z.txt', '\uE000', '😀'] })
    assert.equal(fs.readFile('/a/child'), 'replacement')
    assert.equal(fs.isDir('/root'), false)
    assert.deepEqual([...walkTree(fs, '/')].map(({ path, kind, depth }) => [path, kind, depth]), [
      ['/', 'dir', 0],
      ['/a', 'dir', 1],
      ['/a/child', 'file', 2],
      ['/a', 'file', 1],
      ['/m.txt', 'file', 1],
      ['/z.txt', 'file', 1],
      ['/\uE000', 'file', 1],
      ['/😀', 'dir', 1],
      ['/😀/leaf', 'file', 2],
      ['/😀', 'file', 1],
    ])
    assert.deepEqual([...fs.walkFiles('/')], ['/a/child', '/a', '/m.txt', '/z.txt', '/\uE000', '/😀/leaf', '/😀'])
    assert.deepEqual(lookup('/', 'm.txt/../a', fs), { path: null, error: 'Not a directory' })
    assert.deepEqual(lookup('/', 'missing/../a', fs), { path: null, error: 'No such file or directory' })
  })

  it('consults pruning after yielding a directory and honors depth limits', () => {
    const fs = createFs({ 'a/inner/x': 'x', 'b/y': 'y', c: 'c' })
    const pruned = new Set()
    const visited = []
    const consulted = []
    for (const entry of walkTree(fs, '/', Infinity, (path) => {
      consulted.push(path)
      return !pruned.has(path)
    })) {
      visited.push(entry.path)
      if (entry.path === '/a') pruned.add(entry.path)
    }
    assert.deepEqual(visited, ['/', '/a', '/b', '/b/y', '/c'])
    assert.deepEqual(consulted, ['/', '/a', '/b'])
    assert.deepEqual([...walkTree(fs, '/', 1)].map((entry) => entry.path), ['/', '/a', '/b', '/c'])
    assert.deepEqual([...walkTree(createFs({}), '/')], [{ path: '/', kind: 'dir', depth: 0 }])
  })
})
