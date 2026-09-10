import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = {
  'src/app.ts': 'a.b\naxb\n(a|b)\na+b\n[ab]\n\\b\n',
  'src/lib.ts': 'a.b\nother\n',
  input: '-F\n^$\n',
}

function check(command, stdout, exitCode = 0) {
  assert.deepEqual(createTerminal(FILES).run(command), { stdout, stderr: '', exitCode, cwd: '/', notes: [], unsupported: [] }, command)
}

describe('fgrep compatibility alias', () => {
  for (const [pattern, stdout] of [
    ['a.b', '1:a.b\n'], ['(a|b)', '3:(a|b)\n'], ['a+b', '4:a+b\n'], ['[ab]', '5:[ab]\n'], [String.raw`\b`, '6:\\b\n'],
  ]) {
    it(`matches ${pattern} literally without an obsolete-name warning`, () => {
      check(`fgrep -n '${pattern}' src/app.ts`, stdout)
    })
  }

  it('filters stdin and accepts repeated fixed-string patterns', () => {
    check("cat src/app.ts | fgrep -F -e a.b -e '(a|b)'", 'a.b\n(a|b)\n')
  })

  it('protects leading-dash patterns after -- and retains no-match status', () => {
    check('fgrep -- -F input', '-F\n')
    check("fgrep '^missing$' input", '', 1)
  })

  for (const prefix of ['/bin/', '/sbin/', '/usr/bin/', '/usr/local/bin/']) {
    it(`resolves ${prefix}fgrep`, () => {
      check(`${prefix}fgrep -n a.b src/app.ts`, '1:a.b\n')
    })
  }

  it('dispatches through xargs and find with the usual file labels', () => {
    check("printf '%s\\n' src/app.ts src/lib.ts | xargs /bin/fgrep -n a.b", 'src/app.ts:1:a.b\nsrc/lib.ts:1:a.b\n')
    check("find src -name '*.ts' -exec fgrep -n a.b {} ';'", '1:a.b\n1:a.b\n')
  })

  it('resolves through which, stays hidden, and rejects custom overrides', () => {
    const terminal = createTerminal(FILES)
    assert.equal(terminal.run('which fgrep').stdout, '/usr/bin/fgrep\n')
    for (const prefix of ['', '/usr/bin/', 'cat input | ']) assert.deepEqual(terminal.complete(prefix + 'fgr'), [])
    assert.doesNotMatch(terminal.run('unknown-command').stderr, /\bfgrep\b/u)
    for (const commands of [{ fgrep: () => 'wrong' }, new Map([['fgrep', () => 'wrong']])]) {
      assert.throws(() => createTerminal(FILES, { commands }), /fgrep: cannot redefine a built-in command/u)
    }
  })
})

describe('fgrep errors and unsupported diagnostics', () => {
  it('retains grep status 2 when stdout is closed', () => {
    const result = createTerminal(FILES).run('fgrep a.b src/app.ts >&-')
    assert.equal(result.stdout, '')
    assert.equal(result.exitCode, 2)
    assert.match(result.stderr, /write error: Bad file descriptor/u)
    assert.deepEqual(result.unsupported, [])
  })

  for (const dialect of ['E', 'G', 'P']) {
    it(`rejects -${dialect} conflicting with its implicit -F`, () => {
      const result = createTerminal(FILES).run(`fgrep -${dialect} a input`)
      assert.equal(result.stdout, '')
      assert.equal(result.exitCode, 2)
      assert.match(result.stderr, /mutually exclusive/u)
      assert.deepEqual(result.unsupported, [])
    })
  }

  for (const command of [
    'fgrep -Z a input', '/bin/fgrep -Z a input',
    "printf '%s\\n' input | xargs fgrep -Z a",
    "find input -exec /usr/bin/fgrep -Z a {} ';'",
  ]) {
    it(`preserves underlying grep diagnostics for ${command}`, () => {
      const terminal = createTerminal(FILES)
      const expected = terminal.run('grep -F -Z a input').unsupported.map((note) => ({ ...note, command: 'fgrep' }))
      const result = terminal.run(command)
      assert.equal(result.stdout, '')
      assert.notEqual(result.stderr, '')
      assert.equal(expected.length, 1)
      assert.equal(expected[0].command, 'fgrep')
      assert.deepEqual(result.unsupported, expected)
      const hidden = terminal.run(`{ ${command}; } 2>/dev/null | cat`)
      assert.equal(hidden.stderr, '')
      assert.deepEqual(hidden.unsupported, expected)
    })
  }
})
