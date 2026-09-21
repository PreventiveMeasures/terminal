import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// `runAsync` is `run` handed back as a promise, for a caller who would rather
// await a result than take one. Nothing waits for anything yet, so what it
// answers, when it answers it, and what it leaves behind are all `run`'s.
const SOURCES = { 'src/app.js': 'export const name = "oak"\n', 'src/lib.js': 'lib\n', 'README.md': '# demo\n' }
const terminal = (sources = SOURCES, options = {}) => createTerminal(sources, options)

describe('runAsync runs a line and promises the result', () => {
  it('answers what run answers', async () => {
    const t = terminal()
    const promised = await t.runAsync('wc -l src/app.js')
    assert.deepEqual(promised, { stdout: '1 src/app.js\n', stderr: '', exitCode: 0, cwd: '/', unsupported: [], notes: [] })
    assert.deepEqual(promised, terminal().run('wc -l src/app.js'))
  })

  it('is a promise, so it can be waited for either way', async () => {
    const t = terminal()
    const promise = t.runAsync('echo hi')
    assert.ok(promise instanceof Promise)
    assert.equal(await promise.then((r) => r.stdout), 'hi\n')
  })

  it('reports a failing line as run does, rather than rejecting', async () => {
    const t = terminal()
    const r = await t.runAsync('wc -l missing.js')
    assert.equal(r.stderr, 'wc: missing.js: No such file or directory\n')
    assert.equal(r.exitCode, 1)
    // A gap is on its own channel here too, where a redirect cannot hide it.
    const gap = await t.runAsync('shopt -s nullglob 2>/dev/null')
    assert.deepEqual(gap.unsupported.map((u) => u.command), ['shopt'])
  })

  it('carries the session, and runs in the order the lines were given', async () => {
    const t = terminal()
    // The line has already run by the time the promise is returned, so a call
    // made without awaiting the one before it still runs after it.
    const first = t.runAsync('cd src; TAG=v2')
    assert.equal(t.run('pwd; echo $TAG').stdout, '/src\nv2\n')
    assert.equal((await first).cwd, '/src')
    assert.equal((await t.runAsync('pwd')).stdout, '/src\n')
  })

  it('is on a fork as it is on the terminal it came from', async () => {
    const t = terminal(SOURCES, { writable: '/tmp/', mount: '/repo' })
    assert.equal(t.run('cd /repo/src').exitCode, 0)
    const worker = t.fork()
    assert.equal((await worker.runAsync('pwd')).stdout, '/repo/src\n')
    assert.equal((await worker.runAsync('cd /repo; pwd')).stdout, '/repo\n')
    // The two run independently, as two forks do.
    assert.equal((await t.runAsync('pwd')).stdout, '/repo/src\n')
  })
})
