import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const result = (stdout = '', exitCode = 0, stderr = '') => ({ stdout, stderr, exitCode, cwd: '/', unsupported: [] })
const setup = (input = 'hello\nworld\n') => {
  const terminal = createTerminal({ input }, { mount: '/src/', writable: '/tmp/' })
  assert.deepEqual(terminal.run('cat /src/input >/tmp/args'), result())
  return terminal
}

describe('xargs cannot silently snapshot arguments while children rewrite them', () => {
  for (const command of ['xargs -n1 echo', 'xargs -I{} echo {}', 'xargs -n1 xargs echo']) {
    it(command, () => {
      const t = setup()
      const actual = t.run(`${command} </tmp/args 2>/dev/null >>/tmp/args | cat`)
      assert.equal(actual.exitCode, 0)
      assert.equal(actual.stdout, '')
      assert.equal(actual.stderr, '')
      assert.deepEqual(actual.unsupported.map((entry) => [entry.command, entry.detail]), [['xargs', 'streaming self-output']])
      assert.deepEqual(t.run('cat /tmp/args'), result('hello\nworld\n'))
    })
  }
  it('covers NUL-separated argument batches', () => {
    const t = setup('hello\0world\0')
    const actual = t.run('xargs -0 -n1 echo </tmp/args >>/tmp/args 2>/dev/null | cat')
    assert.deepEqual(actual.unsupported.map(({ detail }) => detail), ['streaming self-output'])
    assert.deepEqual(t.run('cat /tmp/args'), result('hello\0world\0'))
  })
  it('checks stderr writes as well as stdout writes', () => {
    const t = setup()
    const actual = t.run('xargs -n1 cat </tmp/args 2>>/tmp/args | cat')
    assert.equal(actual.exitCode, 0)
    assert.equal(actual.stdout, '')
    assert.equal(actual.stderr, '')
    assert.deepEqual(actual.unsupported.map(({ detail }) => detail), ['streaming self-output'])
    assert.match(t.run('cat /tmp/args').stdout, /^hello\nworld\n/u)
    assert.doesNotMatch(t.run('cat /tmp/args').stdout, /cat: hello/u)
  })
  it('normalizes aliased paths when guarding child output', () => {
    const t = setup()
    const actual = t.run('xargs -n1 echo </tmp/args >>/tmp/./args 2>/dev/null | cat')
    assert.deepEqual(actual.unsupported.map(({ detail }) => detail), ['streaming self-output'])
    assert.deepEqual(t.run('cat /tmp/args'), result('hello\nworld\n'))
  })
  it('preserves an original unsupported-command diagnostic when its stderr write is blocked', () => {
    const t = setup()
    const actual = t.run('xargs -n1 nonexistent-command </tmp/args 2>>/tmp/args | cat')
    assert.equal(actual.exitCode, 0)
    assert.ok(actual.unsupported.some(({ kind, command }) => kind === 'command' && command === 'nonexistent-command'))
    assert.ok(actual.unsupported.some(({ command, detail }) => command === 'xargs' && detail === 'streaming self-output'))
  })
})

describe('xargs self-output guards allow commands that do not write', () => {
  it('allows successful silent children sharing their argument descriptor', () => {
    const t = setup()
    assert.deepEqual(t.run('xargs -n1 true </tmp/args >>/tmp/args'), result())
    assert.deepEqual(t.run('cat /tmp/args'), result('hello\nworld\n'))
  })
  it('allows silent failing children and preserves xargs status', () => {
    const t = setup()
    assert.deepEqual(t.run('xargs -n1 false </tmp/args >>/tmp/args'), result('', 123))
    assert.deepEqual(t.run('cat /tmp/args'), result('hello\nworld\n'))
  })
  it('does not invoke a child for empty replacement input', () => {
    const t = setup('')
    assert.deepEqual(t.run('xargs -I{} echo {} </tmp/args >>/tmp/args'), result())
    assert.deepEqual(t.run('cat /tmp/args'), result())
  })
  it('allows child output to a different writable file', () => {
    const t = setup()
    assert.deepEqual(t.run('xargs -n1 echo </tmp/args >/tmp/output; cat /tmp/output'), result('hello\nworld\n'))
  })
  it('allows child errors directed away from its arguments', () => {
    const t = setup('missing\n')
    assert.deepEqual(t.run('xargs -n1 cat </tmp/args >>/tmp/args 2>/tmp/errors'), result('', 123))
    assert.deepEqual(t.run('cat /tmp/args'), result('missing\n'))
    assert.match(t.run('cat /tmp/errors').stdout, /cat: missing/u)
  })
})
