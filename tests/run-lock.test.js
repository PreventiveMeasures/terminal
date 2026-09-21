import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as pause } from 'node:timers/promises'
import { createTerminal } from '@preventive/terminal'

// `run` answers with a promise, because a line can wait now: a command may
// have work a runtime does rather than this code, and the line waits for it
// where it meets it. What waiting brings with it is the order — a second line
// takes its turn rather than starting in the gap the first one left — and
// that is what most of this is about.
const SOURCES = { 'src/app.js': 'export const name = "oak"\n', 'src/lib.js': 'lib\n', 'README.md': '# demo\n' }
const terminal = (sources = SOURCES, options = {}) => createTerminal(sources, options)
// A command that waits, so a line can be caught in the middle of one.
const slow = (log) => async ({ args }) => {
  log.push(`${args[0]} in`)
  await pause(5)
  log.push(`${args[0]} out`)
  return `${args[0]}\n`
}

describe('run answers with a promise', () => {
  it('answers what it answered before, one await later', async () => {
    const t = terminal()
    const answer = t.run('wc -l src/app.js')
    assert.ok(answer instanceof Promise)
    assert.deepEqual(await answer, { stdout: '1 src/app.js\n', stderr: '', exitCode: 0, cwd: '/', unsupported: [], notes: [] })
  })

  it('reports a failing line rather than rejecting', async () => {
    const t = terminal()
    const r = await t.run('wc -l missing.js')
    assert.equal(r.stderr, 'wc: missing.js: No such file or directory\n')
    assert.equal(r.exitCode, 1)
    // A gap is on its own channel here too, where a redirect cannot hide it.
    const gap = await t.run('shopt -s nullglob 2>/dev/null')
    assert.deepEqual(gap.unsupported.map((u) => u.command), ['shopt'])
  })

  it('carries the session from one line to the next', async () => {
    const t = terminal()
    await t.run('cd src; TAG=v2')
    assert.equal((await t.run('pwd; echo $TAG')).stdout, '/src\nv2\n')
  })
})

describe('one line at a time', () => {
  it('runs the lines in the order they were given, however many are in the air', async () => {
    const log = []
    const t = terminal(SOURCES, { commands: { slow: slow(log) } })
    const first = t.run('slow a')
    const second = t.run('slow b')
    const third = t.run('slow c')
    assert.deepEqual((await Promise.all([first, second, third])).map((r) => r.stdout), ['a\n', 'b\n', 'c\n'])
    // Nothing started while something else was in the middle of waiting.
    assert.deepEqual(log, ['a in', 'a out', 'b in', 'b out', 'c in', 'c out'])
  })

  it('holds the turn across a fork, which is the same tree under another name', async () => {
    const log = []
    const t = terminal(SOURCES, { writable: '/tmp/', mount: '/repo', commands: { slow: slow(log) } })
    const child = t.fork()
    const parent = t.run('slow parent')
    const forked = child.run('slow child')
    await Promise.all([parent, forked])
    assert.deepEqual(log, ['parent in', 'parent out', 'child in', 'child out'])
  })

  it('leaves the next line to run when one throws', async () => {
    const log = []
    const t = terminal(SOURCES, { commands: { boom: () => { throw new Error('boom') }, slow: slow(log) } })
    const failing = t.run('boom')
    const after = t.run('slow after')
    assert.equal((await failing).stderr, 'boom: boom\n')
    assert.equal((await after).stdout, 'after\n')
  })

  it('keeps the turn while a command of its own is waiting', async () => {
    // gzip waits on the runtime's stream, which is a wait in the middle of a
    // line: a line begun while it waits still takes its turn behind it.
    const log = []
    const member = Uint8Array.of(0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x03, 0x4b, 0xcc, 0x29, 0xc8, 0x48, 0xe4, 0x4a, 0x4a, 0x2d, 0x49, 0xe4, 0x02, 0x00, 0x6e, 0x50, 0x30, 0x6e, 0x0b, 0x00, 0x00, 0x00)
    const t = terminal({ 'data.gz': member }, { commands: { mark: ({ args }) => { log.push(args[0]); return '' } } })
    const first = t.run('gzip -dc data.gz > /dev/null && mark first')
    // Far enough in for the stream to be what it is waiting on.
    await pause(1)
    const second = t.run('mark second')
    await Promise.all([first, second])
    assert.deepEqual(log, ['first', 'second'])
  })

  it('runs a line from inside a command within that command, rather than after it', async () => {
    // A handler that re-enters `run` is the line already running, one command
    // further in: waiting for its turn would be waiting for itself.
    const log = []
    let inner = null
    const t = terminal(SOURCES, {
      commands: {
        outer: async () => { log.push('outer in'); inner = await t.run('wc -l src/lib.js'); log.push('outer out'); return 'done\n' },
        slow: slow(log),
      },
    })
    const outer = t.run('outer')
    const next = t.run('slow next')
    assert.equal((await outer).stdout, 'done\n')
    assert.equal(inner.stdout, '1 src/lib.js\n')
    assert.equal((await next).stdout, 'next\n')
    // The line waiting its turn waited for the whole of the one inside.
    assert.deepEqual(log, ['outer in', 'outer out', 'next in', 'next out'])
  })
})
