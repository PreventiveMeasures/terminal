import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// tee writes what it reads twice over, and a file it cannot open is that
// file's trouble rather than the read's: GNU names it, writes the rest, and
// still hands on everything it read. Recorded from GNU coreutils 9.4 over the
// same input. The overlay is the only place here that can be written, so a
// name outside it is this terminal's gap rather than one of GNU's errors.
const SOURCES = { 'a.txt': 'a\nb\n', 'img.bin': Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0xff, 0x0a) }
const terminal = () => createTerminal(SOURCES, { mount: '/repo', writable: '/tmp/' })
const result = (stdout = '', { stderr = '', exitCode = 0, notes = [], unsupported = [] } = {}) =>
  ({ stdout, stderr, exitCode, cwd: '/repo', notes, unsupported })

describe('tee writes what it reads twice over', () => {
  it('hands its input on, with or without a file to keep it in', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('cat a.txt | tee'), result('a\nb\n'))
    assert.deepEqual(await t.run('cat a.txt | tee /tmp/one'), result('a\nb\n'))
    assert.deepEqual(await t.run('cat /tmp/one'), result('a\nb\n'))
    // Every file named gets the whole of it.
    assert.deepEqual(await t.run('cat a.txt | tee /tmp/two /tmp/three > /dev/null'), result())
    assert.deepEqual(await t.run('cat /tmp/two /tmp/three'), result('a\nb\na\nb\n'))
    // The sink keeps nothing, which is what keeping nothing of it is.
    assert.deepEqual(await t.run('cat a.txt | tee /dev/null'), result('a\nb\n'))
  })

  it('truncates what it writes unless told to add to it', async () => {
    const t = terminal()
    await t.run('cat a.txt | tee /tmp/f > /dev/null')
    await t.run('cat a.txt | tee /tmp/f > /dev/null')
    assert.deepEqual(await t.run('cat /tmp/f'), result('a\nb\n'))
    await t.run('cat a.txt | tee -a /tmp/f > /dev/null')
    assert.deepEqual(await t.run('cat /tmp/f'), result('a\nb\na\nb\n'))
    await t.run('cat a.txt | tee --append /tmp/f > /dev/null')
    assert.deepEqual(await t.run('wc -l /tmp/f'), result('6 /tmp/f\n'))
  })

  it('carries the bytes a pipe carried, as the bytes they are', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('cat img.bin | tee /tmp/copy | wc -c'), result('6\n'))
    assert.deepEqual(await t.run('cat /tmp/copy | base64'), result('iVBOR/8K\n'))
    // Bytes that spell text are that text, through tee as through a pipe.
    assert.deepEqual(await t.run('cat a.txt | tee /tmp/text | cat'), result('a\nb\n'))
  })

  it('names the file it could not open and writes the rest all the same', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('cat a.txt | tee /tmp'), result('a\nb\n', { stderr: 'tee: /tmp: Is a directory\n', exitCode: 1 }))
    assert.deepEqual(await t.run('cat a.txt | tee /tmp/nodir/f'), result('a\nb\n', { stderr: 'tee: /tmp/nodir/f: No such file or directory\n', exitCode: 1 }))
    assert.deepEqual(await t.run('cat a.txt | tee /tmp /tmp/kept > /dev/null'), result('', { stderr: 'tee: /tmp: Is a directory\n', exitCode: 1 }))
    assert.deepEqual(await t.run('cat /tmp/kept'), result('a\nb\n'))
  })

  it('reports a name it cannot write over what it did write', async () => {
    const t = terminal()
    const r = await t.run('cat a.txt | tee /tmp/here there')
    assert.equal(r.stdout, 'a\nb\n')
    assert.equal(r.exitCode, 1)
    assert.deepEqual(r.unsupported.map((u) => ({ kind: u.kind, command: u.command, detail: u.detail })),
      [{ kind: 'feature', command: 'tee', detail: 'read-only target' }])
    assert.equal(r.stderr, 'tee: there: Read-only file system\n')
    // The file it could write was written.
    assert.deepEqual(await t.run('cat /tmp/here'), result('a\nb\n'))
  })

  it('is a command a pipe offers, and not one the hint announces', async () => {
    const t = terminal()
    assert.deepEqual(t.complete('te'), ['test', 'tee'])
    assert.deepEqual(t.complete('tee'), ['tee'])
    assert.ok(t.complete('cat a.txt | ').includes('cat a.txt | tee'))
    const hint = (await t.run('nope')).unsupported[0].message
    assert.ok(!hint.includes('tee'), hint)
  })
})
