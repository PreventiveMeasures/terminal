import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU execute.c D advances pattern space past its first buffer delimiter and
// restarts commands without reading input or resetting other execution state.
// https://github.com/mirror/sed/blob/v4.9/sed/execute.c
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'"
const result = (stdout = '') => ({ stdout, stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [] })
const run = (script, input, flags = '') => createTerminal({ input }).run(`sed ${flags} ${quote(script)} input`)

describe('sed D deletes through the first pattern-space delimiter', () => {
  for (const [script, input, flags, stdout] of [
    ['D', 'a\nb\n', '', ''],
    ['D;p', 'a\nb\n', '-n', ''],
    ['D', '', '', ''],
    ['2D', 'a\nb\nc\n', '', 'a\nc\n'],
    ['2!D', 'a\nb\nc\n', '', 'b\n'],
    ['1,2D', 'a\nb\nc\n', '', 'c\n'],
    ['N;P;D', 'a\nb\nc\n', '-n', 'a\nb\n'],
    ['N;P;D', 'a\nb\nc\n', '', 'a\nb\nc\n'],
    ['N;P;D', 'a\nb\nc', '', 'a\nb\nc'],
    ['/^a/{N;D};p', 'a\nb\n', '-n', 'b\n'],
    ['/^a/{N;D};p', 'a\nb', '-n', 'b'],
    ['/^a/{N;D};=', 'a\nb\n', '-n', '2\n'],
    ['/^a/{h;N;D};g;p', 'a\nb\n', '-n', 'a\n'],
    [String.raw`s/a/a\nb/;/^a/D`, 'a', '', 'b'],
    ['/./{G;D};s/^/empty/', 'a\n', '', 'empty\n'],
  ]) {
    it(`${flags} ${script} on ${JSON.stringify(input)}`, () => assert.deepEqual(run(script, input, flags), result(stdout)))
  }
  it('uses NUL as the first-line delimiter under -z', () => {
    assert.deepEqual(run('N;P;D', 'a\0b\0c', '-z'), result('a\0b\0c'))
  })
  it('does not mistake an embedded LF for the -z delimiter', () => {
    assert.deepEqual(run('/^a/D', 'a\nb\0c\0', '-z'), result('c\0'))
  })
  it('retains a missing final NUL after deleting a leading record', () => {
    assert.deepEqual(run('/^a/{N;D};p', 'a\0b', '-zn'), result('b'))
  })
})

describe('sed D restarts preserve pending text and substitution state', () => {
  it('keeps queued append text until the restarted cycle finishes', () => {
    assert.deepEqual(run('/^a/{N;a tail\nD};p', 'a\nb\n', '-n'), result('b\ntail\n'))
  })
  it('inserts from the restarted script before earlier queued append text', () => {
    assert.deepEqual(run('/^a/{N;a tail\nD};i head\np', 'a\nb\n', '-n'), result('head\nb\ntail\n'))
  })
  it('flushes queued append text when D has no internal delimiter', () => {
    assert.deepEqual(run('a tail\nD', 'a\nb\n', '-n'), result('tail\ntail\n'))
  })
  it('does not clear a successful substitution before t after restart', () => {
    const script = '/^a/{N;s/a/A/;D};t yes;s/.*/BAD/;b;:yes;p'
    assert.deepEqual(run(script, 'a\nb\n', '-n'), result('b\n'))
  })
  it('does not create a successful substitution before T after restart', () => {
    const script = '/^a/{N;D};T yes;s/.*/BAD/;b;:yes;p'
    assert.deepEqual(run(script, 'a\nb\n', '-n'), result('b\n'))
  })
  it('does not consume another input record when restarting', () => {
    const t = createTerminal({ input: 'a\nb\nc\n' })
    assert.deepEqual(t.run("{ sed -n '/^a/{N;D};p;q'; cat; } <input"), result('b\nc\n'))
  })
  it('can write the remaining pattern space with standalone w', () => {
    const t = createTerminal({ input: 'a\nb' }, { mount: '/src/', writable: '/tmp/' })
    assert.deepEqual(t.run("sed -n '/^a/{N;D};w /tmp/out' /src/input"), result())
    assert.deepEqual(t.run('cat /tmp/out'), result('b'))
  })
})

describe('sed D participates in separate and in-place input cycles', () => {
  it('combines ordinary operands in the same sliding window', () => {
    const t = createTerminal({ first: 'a\n', second: 'b\nc\n' })
    assert.deepEqual(t.run("sed -n 'N;P;D' first second"), result('a\nb\n'))
  })
  it('starts a new sliding window for separate files', () => {
    const t = createTerminal({ first: 'a\n', second: 'b\nc\n' })
    assert.deepEqual(t.run("sed -sn 'N;P;D' first second"), result('b\n'))
  })
  it('writes only surviving output when editing files in place', () => {
    const t = createTerminal({}, { mount: '/src/', writable: '/tmp/' })
    t.run("printf 'a\\nb\\n' >/tmp/input")
    assert.deepEqual(t.run("sed -i '/^a/{N;D}' /tmp/input"), result())
    assert.deepEqual(t.run('cat /tmp/input'), result('b\n'))
  })
  it('reports bounded execution when restart continually restores the deleted text', () => {
    const actual = run('h;G;D', 'a\n', '-n')
    assert.equal(actual.exitCode, 1)
    assert.equal(actual.stdout, '')
    assert.deepEqual(actual.unsupported.map(({ command, detail }) => [command, detail]), [['sed', 'execution limit']])
  })
})
