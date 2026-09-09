import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = {
  'src/app.ts': 'import x\nexport const alpha = 1\nexport function beta() {}\n// TODO gamma\n',
  'src/lib.ts': 'export const delta = 2\n',
  'src/ignored.js': 'export const ignore = 3\n',
  input: 'aa\na\nb\n-E\na|aa\n',
  unicode: 'é\n',
}

function check(command, stdout, exitCode = 0) {
  assert.deepEqual(createTerminal(FILES).run(command), { stdout, stderr: '', exitCode, cwd: '/', unsupported: [] }, command)
}

describe('egrep compatibility alias', () => {
  it('selects ERE alternation and grouping without an obsolete-name warning', () => {
    check("egrep -n '^export (const|function) ' src/app.ts", '2:export const alpha = 1\n3:export function beta() {}\n')
  })

  it('filters piped input with ERE quantifiers', () => {
    check("cat input | egrep '^a+$'", 'aa\na\n')
  })

  it('uses POSIX longest-match output', () => {
    check("egrep -o 'a|aa' input", 'aa\na\na\naa\n')
  })

  it('retains repeated patterns and recursive filename filters', () => {
    check("egrep -n -e '^export ' -e TODO src/app.ts", '2:export const alpha = 1\n3:export function beta() {}\n4:// TODO gamma\n')
    check("egrep -rn '^export ' src --include='*.ts'", 'src/app.ts:2:export const alpha = 1\nsrc/app.ts:3:export function beta() {}\nsrc/lib.ts:1:export const delta = 2\n')
  })

  it('accepts repeated -E and protects a leading-dash pattern after --', () => {
    check("egrep -E -n '^a+$' input", '1:aa\n2:a\n')
    check("egrep -- '-E|^b$' input", 'b\n-E\n')
  })

  it('returns ordinary no-match status', () => {
    check("egrep '^missing$' input", '', 1)
  })

  for (const prefix of ['/bin/', '/sbin/', '/usr/bin/', '/usr/local/bin/']) {
    it(`resolves ${prefix}egrep`, () => {
      check(`${prefix}egrep -n '^a+$' input`, '1:aa\n2:a\n')
    })
  }

  it('dispatches through xargs with normal multi-file labels', () => {
    check("printf '%s\\n' src/app.ts src/lib.ts | xargs egrep -n '^export '",
      'src/app.ts:2:export const alpha = 1\nsrc/app.ts:3:export function beta() {}\nsrc/lib.ts:1:export const delta = 2\n')
  })

  it('dispatches bin aliases through find -exec', () => {
    check("find src -name '*.ts' -exec /usr/bin/egrep -n '^export ' {} ';'",
      '2:export const alpha = 1\n3:export function beta() {}\n1:export const delta = 2\n')
  })

  it('resolves through which while remaining hidden from completion and hints', () => {
    const terminal = createTerminal(FILES)
    assert.equal(terminal.run('which egrep').stdout, '/usr/bin/egrep\n')
    for (const prefix of ['', '/usr/bin/', 'cat input | ']) assert.deepEqual(terminal.complete(prefix + 'egr'), [])
    assert.doesNotMatch(terminal.run('unknown-command').stderr, /\begrep\b/u)
  })

  it('cannot be replaced by a custom command', () => {
    for (const commands of [{ egrep: () => 'wrong' }, new Map([['egrep', () => 'wrong']])]) {
      assert.throws(() => createTerminal(FILES, { commands }), /egrep: cannot redefine a built-in command/u)
    }
    const terminal = createTerminal(FILES, { commands: { custom: () => 'custom\n' } })
    assert.equal(terminal.run("egrep '^a+$' input").stdout, 'aa\na\n')
    assert.equal(terminal.run('custom').stdout, 'custom\n')
  })
})

describe('egrep errors and unsupported diagnostics', () => {
  it('retains grep status 2 when stdout is closed', () => {
    const result = createTerminal(FILES).run('egrep a input >&-')
    assert.equal(result.stdout, '')
    assert.equal(result.exitCode, 2)
    assert.match(result.stderr, /write error: Bad file descriptor/u)
    assert.deepEqual(result.unsupported, [])
  })

  for (const dialect of ['F', 'G', 'P']) {
    it(`rejects -${dialect} conflicting with its implicit -E`, () => {
      const result = createTerminal(FILES).run(`egrep -${dialect} a input`)
      assert.equal(result.stdout, '')
      assert.equal(result.exitCode, 2)
      assert.match(result.stderr, /mutually exclusive/u)
      assert.deepEqual(result.unsupported, [])
    })
  }

  it('reports missing files as grep errors without unsupported notes', () => {
    const result = createTerminal(FILES).run('egrep a missing')
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^grep: missing: no such file/u)
    assert.equal(result.exitCode, 2)
    assert.deepEqual(result.unsupported, [])
  })

  for (const command of [
    'egrep -Z a input', '/bin/egrep -Z a input',
    "printf '%s\\n' input | xargs /usr/bin/egrep -Z a",
    "find input -exec egrep -Z a {} ';'",
  ]) {
    it(`retains underlying grep diagnostics for ${command}`, () => {
      const terminal = createTerminal(FILES)
      const expected = terminal.run('grep -E -Z a input').unsupported.map((note) => ({ ...note, command: 'egrep' }))
      const result = terminal.run(command)
      assert.equal(result.stdout, '')
      assert.notEqual(result.stderr, '')
      assert.equal(expected.length, 1)
      assert.equal(expected[0].command, 'egrep')
      assert.deepEqual(result.unsupported, expected)
      const hidden = terminal.run(`{ ${command}; } 2>/dev/null | cat`)
      assert.equal(hidden.stderr, '')
      assert.deepEqual(hidden.unsupported, expected)
    })
  }

  it('preserves runtime regex limitations after stderr redirection', () => {
    const result = createTerminal(FILES).run("egrep '[[:alpha:]]' unicode 2>/dev/null | cat")
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.deepEqual(result.unsupported.map(({ command, detail }) => [command, detail]), [['egrep', 'non-ASCII regex semantics']])
  })
})
