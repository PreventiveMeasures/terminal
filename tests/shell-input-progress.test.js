import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { parseLine, parseUnits } from '../src/shell/parse.js'

describe('incremental parsing retains compound-command progress', () => {
  it('copies only a linear amount of token data for a growing brace group', () => {
    const count = 2000
    const source = '{\n' + ':\n'.repeat(count) + '}\n'
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'slice')
    let copied = 0, units
    // Count copying work instead of elapsed time. Repeatedly parsing growing
    // prefixes copies quadratically many elements, independent of CPU speed.
    /* eslint-disable no-extend-native -- Instrument an existing method only for this synchronous parse, then restore it. */
    Object.defineProperty(Array.prototype, 'slice', { ...descriptor, value: function (...args) {
      copied += this.length
      return Reflect.apply(descriptor.value, this, args)
    } })
    try { units = [...parseUnits(source)] }
    finally { Object.defineProperty(Array.prototype, 'slice', descriptor) }
    /* eslint-enable no-extend-native */
    assert.equal(units.length, 1)
    assert.equal(units[0][0].stages[0].group.length, count)
    assert.ok(copied <= count * 16, `${copied} copied elements for ${count} commands`)
  })

  for (const [prefix, suffix] of [
    ['{\n', '}'],
    ['(\n', ')'],
    ['if true; then\n', 'fi'],
    ['for value in one; do\n', 'done'],
    ['if true; then for value in one; do {\n', '}; done; fi'],
  ]) {
    it(`retains the grammar stack for ${prefix.trim()}`, () => {
      const source = prefix + ':\n'.repeat(1000) + 'echo complete\n' + suffix
      assert.deepEqual([...parseUnits(source)], [parseLine(source)])
      const result = createTerminal({}).run(source)
      assert.deepEqual(result, { stdout: 'complete\n', stderr: '', exitCode: 0, cwd: '/', unsupported: [], notes: [] })
    })
  }

  it('does not execute commands from a large compound with an invalid ending', () => {
    const t = createTerminal({}, { mount: '/src', writable: '/tmp/' })
    const source = 'echo before\n{\nprintf changed >/tmp/file\n' + ':\n'.repeat(2000) + 'echo ;;\n}\n'
    const result = t.run(source)
    assert.equal(result.stdout, 'before\n')
    assert.equal(result.exitCode, 2)
    assert.deepEqual(result.unsupported, [])
    assert.deepEqual(result.notes, [])
    assert.equal(t.run('test -f /tmp/file').exitCode, 1)
  })

  it('never requests another input unit after a completed exit', () => {
    const source = '{\n' + ':\n'.repeat(1000) + 'echo before\nexit 7\n}\necho "'
    const result = createTerminal({}).run(source)
    assert.deepEqual(result, { stdout: 'before\n', stderr: '', exitCode: 7, cwd: '/', unsupported: [], notes: [] })
  })

  it('retains background-syntax diagnostics while reading a loop header', () => {
    const result = createTerminal({}).run('echo before\nfor value in one & echo bad\n')
    assert.equal(result.stdout, 'before\n')
    assert.notEqual(result.exitCode, 0)
    assert.equal(result.unsupported.at(-1)?.detail, '&')
    assert.deepEqual(result.notes, [])
  })
})
