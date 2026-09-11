import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const result = (stdout = '', exitCode = 0, stderr = '') => ({ stdout, stderr, exitCode, cwd: '/', notes: [], unsupported: [] })
// A writable overlay needs a mount away from `/`, and cwd follows the mount.
const mounted = (...args) => ({ ...result(...args), cwd: '/src' })
const writeError = (name) => `${name}: write error: Bad file descriptor\n`
const setup = () => createTerminal({ input: 'a\nb\n' })

describe('closed stdout is validated for commands entering any dispatch path', () => {
  for (const [command, name, status] of [
    ['echo value', 'echo', 1], ['cat /input', 'cat', 1], ['ls /input', 'ls', 2],
    ['grep a /input', 'grep', 2], ['egrep a /input', 'egrep', 2], ['fgrep a /input', 'fgrep', 2],
    ['sort /input', 'sort', 2], ['xxd /input', 'xxd', 3], ["sed -e 's/^/ /' /input", 'sed', 4],
    ['/bin/echo value', '/bin/echo', 1], ['/usr/bin/ls /input', '/usr/bin/ls', 2],
    ['/usr/local/bin/grep a /input', '/usr/local/bin/grep', 2],
  ]) {
    it(command, () => assert.deepEqual(setup().run(command + ' 1>&-'), result('', status, writeError(name))))
  }
  for (const command of ['true', 'grep missing /input', 'head -n0 /input', 'hexdump /input', 'tree /']) {
    it(`does not fabricate failures for ${command}`, () => {
      const status = command === 'grep missing /input' ? 1 : 0
      const notes = command === 'head -n0 /input' ? ['head: selected 0 of 2 lines from "/input".'] : []
      assert.deepEqual(setup().run(command + ' 1>&-'), { ...result('', status), notes })
    })
  }
  it('handles inherited closure without duplicated errors', () => {
    assert.deepEqual(setup().run('{ echo one; /bin/echo two; } 1>&-'), result('', 1, writeError('echo') + writeError('/bin/echo')))
  })
  it('keeps substitution capture usable under a closed enclosing descriptor', () => {
    assert.deepEqual(setup().run('echo "$(echo inner)" 1>&-'), result('', 1, writeError('echo')))
  })
})

describe('nested commands report their own closed-output failures', () => {
  for (const child of ['echo', '/bin/echo']) {
    it(`find -exec ${child} uses a false predicate without failing find`, () => {
      assert.deepEqual(setup().run(`find /input -exec ${child} {} \\; 1>&-`), result('', 0, writeError(child)))
    })
    it(`find batched -exec ${child} propagates child failure`, () => {
      assert.deepEqual(setup().run(`find /input -exec ${child} {} + 1>&-`), result('', 1, writeError(child)))
    })
    it(`xargs ${child} applies its child-failure status once`, () => {
      assert.deepEqual(setup().run(`printf 'a\\nb\\n' | xargs -n1 ${child} 1>&-`), result('', 123, writeError(child).repeat(2)))
    })
  }
  it('handles find dispatching xargs dispatching echo', () => {
    assert.deepEqual(setup().run('find /input -exec xargs echo {} \\; 1>&-'), result('', 0, writeError('echo')))
  })
  it('handles xargs dispatching find dispatching echo', () => {
    const command = "printf '/input\\n' | xargs -I{} find {} -exec echo FOUND \\; 1>&-"
    assert.deepEqual(setup().run(command), result('', 0, writeError('echo')))
  })
  it('routes each child error into the enclosing stderr file', () => {
    const t = createTerminal({ input: 'a\n' }, { mount: '/src/', writable: '/tmp/' })
    assert.deepEqual(t.run('find /src/input -exec echo {} \\; 1>&- 2>/tmp/errors'), mounted())
    assert.deepEqual(t.run('cat /tmp/errors'), mounted(writeError('echo')))
  })
})

describe('custom commands share built-in output validation', () => {
  const terminal = () => createTerminal({ input: 'a\n' }, { commands: {
    emit: () => 'value\n',
    mixed: () => ({ stdout: 'value\n', stderr: 'earlier diagnostic', exitCode: 7 }),
    silent: () => ({ stdout: '', exitCode: 7 }),
  } })
  for (const command of ['emit', '/bin/emit']) {
    it(command, () => assert.deepEqual(terminal().run(command + ' 1>&-'), result('', 1, writeError(command))))
  }
  it('retains earlier stderr while replacing the failed output status', () => {
    assert.deepEqual(terminal().run('mixed 1>&-'), result('', 1, 'earlier diagnostic\n' + writeError('mixed')))
  })
  it('does not change a silent custom status', () => {
    assert.deepEqual(terminal().run('silent 1>&-'), result('', 7))
  })
  it('validates custom handlers reached through find', () => {
    assert.deepEqual(terminal().run('find /input -exec emit {} \\; 1>&-'), result('', 0, writeError('emit')))
  })
  it('validates custom handlers reached through xargs', () => {
    assert.deepEqual(terminal().run('printf a | xargs emit 1>&-'), result('', 123, writeError('emit')))
  })
})

describe('output validation preserves earlier unsupported diagnostics', () => {
  it('retains a runtime limit when partial stdout cannot be written', () => {
    const actual = setup().run("awk 'BEGIN{print \"prefix\"; while(1){}}' 1>&- 2>/dev/null | cat")
    assert.equal(actual.stdout, '')
    assert.equal(actual.stderr, '')
    assert.equal(actual.exitCode, 0)
    assert.deepEqual(actual.unsupported.map(({ command, detail }) => [command, detail]), [['awk', 'execution limit']])
  })
})
