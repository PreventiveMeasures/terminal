import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = { 'src/a.js': 'abc\n', 'src/b.js': 'é\n', 'src/sub/c.js': 'xyz\n' }

describe('filesystem tool integration', () => {
  for (const [command, stdout] of [
    ["find src -type f -exec stat -c '%s %n' '{}' ';' | sort", '3 src/b.js\n4 src/a.js\n4 src/sub/c.js\n'],
    ["find src -type f -print0 | xargs -0 du -bc | tail -1", '11\ttotal\n'],
    ["find src -type f -print0 | xargs -0 realpath --relative-to=src", 'a.js\nb.js\nsub/c.js\n'],
    ["bytes=$(du -bs src | cut -f1); test \"$bytes\" -eq 11 && echo ok", 'ok\n'],
  ]) {
    it(command, () => {
      const result = createTerminal(FILES).run(command)
      assert.equal(result.stdout, stdout)
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
      assert.deepEqual(result.unsupported, [])
    })
  }

  for (const name of ['du', 'stat', 'realpath']) {
    it(`${name} is discoverable as a command and excluded from pipe completion`, () => {
      const terminal = createTerminal(FILES)
      assert.ok(terminal.complete('').includes(name))
      assert.ok(terminal.complete('/usr/bin/').includes('/usr/bin/' + name))
      assert.deepEqual(terminal.complete('cat | ' + name), [])
      assert.deepEqual(terminal.complete('cat | /usr/bin/' + name), [])
      assert.equal(terminal.run('which ' + name).exitCode, 0)
      assert.match(terminal.run('unknown-command').stderr, new RegExp('\\b' + name + '\\b', 'u'))
      assert.throws(() => createTerminal({}, { commands: { [name]: () => '' } }), /built.?in/iu)
    })
  }

  for (const [name, args, stdout] of [['du', '-bs src', '11\tsrc\n'], ['stat', "-c '%s' src/a.js", '4\n'], ['realpath', 'src/a.js', '/src/a.js\n']]) {
    it(`${name} dispatches through supported binary prefixes`, () => {
      const terminal = createTerminal(FILES)
      for (const prefix of ['/bin/', '/usr/bin/', '/usr/local/bin/', '/sbin/']) {
        const result = terminal.run(prefix + name + ' ' + args)
        assert.equal(result.stdout, stdout)
        assert.equal(result.stderr, '')
        assert.equal(result.exitCode, 0)
        assert.deepEqual(result.unsupported, [])
      }
    })
  }
})
