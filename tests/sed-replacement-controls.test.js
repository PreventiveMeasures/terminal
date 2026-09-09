import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU sed normalize_text handles these escapes before setup_replacement
// interprets references and ampersands; quoting a backslash keeps it literal.
// https://github.com/mirror/sed/blob/v4.9/sed/compile.c
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'"
const result = (stdout) => ({ stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [] })
const controls = [['a', '\u0007'], ['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t'], ['v', '\v']]

describe('sed replacement control escapes', () => {
  for (const [escape, value] of controls) {
    it(`expands \\${escape} in literal, expression and file scripts`, () => {
      const script = `s/r/<\\${escape}>/g`
      const terminal = createTerminal({ input: 'rr\nr', program: script })
      for (const source of [quote(script), `-e ${quote(script)}`, '-f program']) {
        assert.deepEqual(terminal.run(`sed ${source} input`), result(`<${value}><${value}>\n<${value}>`))
      }
    })
    it(`keeps an escaped backslash before ${escape} literal`, () => {
      assert.deepEqual(createTerminal({ input: 'r\n' }).run(`sed ${quote(`s/r/\\\\${escape}/`)} input`), result(`\\${escape}\n`))
    })
    it(`combines \\${escape} with captures and whole-match references`, () => {
      const script = `s/\\(r\\)/\\1\\${escape}\\0\\${escape}&\\&/`
      assert.deepEqual(createTerminal({ input: 'r\n' }).run(`sed ${quote(script)} input`), result(`r${value}r${value}r&\n`))
    })
    it(`removes delimiter quoting before interpreting \\${escape}`, () => {
      const script = `s${escape}X${escape}\\${escape}${escape}`
      assert.deepEqual(createTerminal({ input: 'X\n' }).run(`sed ${quote(script)} input`), result(`${escape}\n`))
    })
  }
  it('handles the reported CR replacement', () => {
    assert.deepEqual(createTerminal({ input: 'r r\n' }).run(String.raw`sed 's/r/\r/' input`), result('\r r\n'))
  })
  it('supports CRLF script endings after substitution flags', () => {
    const terminal = createTerminal({ input: 'rr\n', program: 's/r/\\r/gp\r\n' })
    assert.deepEqual(terminal.run('sed -n -f program input'), result('\r\r\n'))
  })
  it('preserves CR in NUL-separated and unterminated records', () => {
    const terminal = createTerminal({ input: 'rr\0r' })
    assert.deepEqual(terminal.run(String.raw`sed -z 's/r/\r/g' input`), result('\r\r\0\r'))
  })
  it('matches newly inserted controls in subsequent commands', () => {
    for (const [escape] of controls) {
      const script = `s/r/\\${escape}/;s/\\${escape}/X/`
      assert.deepEqual(createTerminal({ input: 'r\n' }).run(`sed ${quote(script)} input`), result('X\n'))
    }
  })
  it('prints controls through numeric and global substitution modes', () => {
    const terminal = createTerminal({ input: 'rrrr\n' })
    assert.deepEqual(terminal.run(String.raw`sed -n 's/r/\r/2p' input`), result('r\rrr\n'))
    assert.deepEqual(terminal.run(String.raw`sed -n 's/r/\r/2gp' input`), result('r\r\r\r\n'))
  })
})

describe('sed unsupported replacement escapes remain diagnostic', () => {
  for (const escape of ['U', 'L', 'u', 'l', 'E', 'x0d', 'o15', 'd13', 'cM']) {
    it(`reports \\${escape} even with hidden stderr and pipeline success`, () => {
      const command = `sed ${quote(`s/r/\\${escape}/`)} input 2>/dev/null | cat`
      const actual = createTerminal({ input: 'r\n' }).run(command)
      assert.equal(actual.exitCode, 0)
      assert.equal(actual.stdout, '')
      assert.equal(actual.stderr, '')
      assert.equal(actual.unsupported.length, 1)
      assert.equal(actual.unsupported[0].detail, 'replacement escape')
    })
  }
})
