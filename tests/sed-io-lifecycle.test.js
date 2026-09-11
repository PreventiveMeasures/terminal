import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const result = (stdout = '') => ({ stdout, stderr: '', exitCode: 0, cwd: '/src', notes: [], unsupported: [] })
const terminal = () => createTerminal({ single: 'a\n' }, { mount: '/src/', writable: '/tmp/' })

describe('sed releases fully buffered scripts and completed input descriptors', () => {
  it('can replace its script after compiling that script into commands', () => {
    const t = terminal()
    t.run("printf 's/a/A/w /tmp/program\\n' >/tmp/program")
    assert.deepEqual(t.run('sed -f /tmp/program /src/single'), result('A\n'))
    assert.deepEqual(t.run('cat /tmp/program'), result('A\n'))
  })
  it('can write a script source from a later expression', () => {
    const t = terminal()
    t.run("printf 's/a/A/\\n' >/tmp/program")
    assert.deepEqual(t.run("sed -f /tmp/program -e 's/A/B/w /tmp/program' /src/single"), result('B\n'))
    assert.deepEqual(t.run('cat /tmp/program'), result('B\n'))
  })
  it('keeps an ancestor xargs reader protected while buffering the child script', () => {
    const t = terminal()
    const script = 's/a/A/w /tmp/args\n'
    t.run("printf 's/a/A/w /tmp/args\\n' >/tmp/args")
    const actual = t.run('xargs -I{} sed -f /tmp/args /src/single </tmp/args')
    assert.equal(actual.exitCode, 123)
    assert.equal(actual.stdout, '')
    assert.deepEqual(actual.unsupported.map(({ detail }) => detail), ['streaming self-output'])
    assert.deepEqual(t.run('cat /tmp/args'), result(script))
  })
})

describe('sed input descriptors retain their opened inode', () => {
  it('loads a script from unlinked redirected stdin', () => {
    const t = terminal()
    t.run("printf 'p\\n' >/tmp/script")
    assert.deepEqual(t.run('{ rm /tmp/script; sed -nf /dev/stdin /src/single; } </tmp/script'), result('a\n'))
  })
  it('reads unlinked redirected stdin while writing its recreated filename', () => {
    const t = terminal()
    t.run("printf 'a\\n' >/tmp/in")
    const command = '{ rm /tmp/in; printf "new\\n" >/tmp/in; sed -n p >/tmp/in; } </tmp/in'
    assert.deepEqual(t.run(command), result())
    assert.deepEqual(t.run('cat /tmp/in'), result('a\n'))
  })
  for (const operand of ['', ' /dev/stdin']) {
    it(`reads the original inode after -i replaces its filename${operand}`, () => {
      const t = terminal()
      t.run("printf 'a\\n' >/tmp/in")
      const command = `{ sed -i s/a/b/ /tmp/in; sed 's/a/A/w /tmp/in'${operand}; } </tmp/in`
      assert.deepEqual(t.run(command), result('A\n'))
      assert.deepEqual(t.run('cat /tmp/in'), result('A\n'))
    })
  }
})
