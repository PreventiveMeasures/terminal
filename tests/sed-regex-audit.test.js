import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU sed 4.9 compile.c get_openfile treats script filenames as C strings;
// regexp.c match_regex recompiles a no-subexpression address only on first use
// by a substitution. These fixtures exercise scripts as data, without a shell oracle.
// https://github.com/mirror/sed/blob/v4.9/sed/compile.c
// https://github.com/mirror/sed/blob/v4.9/sed/regexp.c
const expected = (stdout = '', stderr = '', exitCode = 0) => ({ stdout, stderr, exitCode, cwd: '/', notes: [], unsupported: [] })
const terminal = (program, files = {}) => createTerminal({ program, input: 'aAa\n', ...files }, { mount: '/src', writable: '/tmp/' })

describe('sed write filenames in script files', () => {
  for (const prefix of ['w', 's/a/X/w']) {
    it(`uses the filename before NUL for ${prefix}`, () => {
      const t = terminal(`${prefix} /tmp/out\0ignored; p\np`)
      const text = prefix === 'w' ? 'aAa\n' : 'XAa\n'
      assert.deepEqual(t.run('sed -nf /src/program /src/input'), expected(text))
      assert.deepEqual(t.run('cat /tmp/out'), expected(text))
    })

    it(`rejects an empty C-string filename for ${prefix}`, () => {
      const t = terminal(`${prefix} \0/tmp/out`)
      assert.deepEqual(t.run('sed -f /src/program /src/input'), expected('', 'sed: missing filename in r/R/w/W commands\n', 1))
      assert.deepEqual(t.run('test -e /tmp/out'), expected('', '', 1))
    })
  }

  it('shares the resulting filename between standalone and substitution writes', () => {
    const t = terminal('w /tmp/out\0first\ns/a/X/w /tmp/out\0second')
    assert.deepEqual(t.run('sed -nf /src/program /src/input'), expected())
    assert.deepEqual(t.run('cat /tmp/out'), expected('aAa\nXAa\n'))
  })

  it('recognizes the standard-output special file before a NUL suffix', () => {
    const t = terminal('w /dev/stdout\0suffix')
    assert.deepEqual(t.run('sed -nf /src/program /src/input'), expected('aAa\n'))
  })
})

describe('sed case-insensitive previous-regex state', () => {
  const cases = [
    ['/a/Is//X/g', 'XXX\n'],
    ['/a/I{s//A/;s//\\1/}', 'Aa\n'],
    ['s/a/A/i;s//\\1/', 'Aa\n'],
    ['s/\\(a\\)/A/i;s//[\\1]/', '[A]Aa\n'],
    ['s/\\(a\\)/A/i;s//[\\2]/', '[]Aa\n'],
    ['/a/I{p};/z/p;s//X/g', 'aAa\naAa\n'],
    ['/a/Ip;s/z/X/i;s//Y/g', 'aAa\naAa\n'],
    ['/a/I{p};s//X/2g', 'aAa\naXX\n'],
    ['s/a/X/i;s/A/Y/', 'XYa\n'],
  ]
  for (const [program, stdout] of cases) {
    it(program, () => assert.deepEqual(terminal(program).run('sed -f /src/program /src/input'), expected(stdout)))
  }

  it('checks unavailable captures on the first substitution reuse of an address', () => {
    const t = terminal('/a/Is//\\1/')
    assert.deepEqual(t.run('sed -f /src/program /src/input'), expected('', 'sed: invalid reference \\1 in replacement\n', 1))
  })

  it('does not validate a previous regex on a skipped substitution', () => {
    const t = terminal('/z/Is//\\1/')
    assert.deepEqual(t.run('sed -f /src/program /src/input'), expected('aAa\n'))
  })
})

describe('copy, hold-space editing, and explicit writes compose', () => {
  for (const ending of ['', '\n']) {
    it(`preserves the final terminator ${JSON.stringify(ending)}`, () => {
      const t = terminal('', { input: 'One\nTWO\nTHREE' + ending })
      assert.deepEqual(t.run('cp /src/input /tmp/input'), expected())
      assert.deepEqual(t.run("sed -i -e '1h;1!H;$!d;g;s/two/X/Ig' -e 'w /tmp/snapshot' /tmp/input"), expected())
      assert.deepEqual(t.run('cat /tmp/input'), expected('One\nX\nTHREE' + ending))
      assert.deepEqual(t.run('cat /tmp/snapshot'), expected('One\nX\nTHREE' + ending))
      assert.deepEqual(t.run("sed -n 'N;P;D' /tmp/input"), expected('One\nX\n'))
      assert.deepEqual(t.run('cat /src/input'), expected('One\nTWO\nTHREE' + ending))
    })
  }
})
