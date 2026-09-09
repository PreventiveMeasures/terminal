import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU sed's match_slash removes the backslash before a literal newline,
// while snarf_char_class rejects a newline anywhere inside a bracket.
// setup_replacement treats \0 as the whole match, not an octal escape.
// https://github.com/mirror/sed/blob/v4.9/sed/compile.c
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'"
const result = (stdout) => ({ stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [] })
const continued = '\\\n'

describe('sed substitutes literal newlines continued within a script', () => {
  const cases = [
    [`s/a/b${continued}c/`, 'a\n', 'b\nc\n'],
    [`s/a/${continued}/`, 'a\n', '\n\n'],
    [`s/a/b${continued}c${continued}d/g`, 'aa\n', 'b\nc\ndb\nc\nd\n'],
    [`s/a/b${continued}c/2p`, 'aa\n', 'ab\nc\n', '-n'],
    [`s/a/b${continued}c/`, 'a', 'b\nc'],
    [`s/a/${continued}\\0${continued}/`, 'a\n', '\na\n\n'],
    [`s/\\(a\\)/\\0${continued}\\1/`, 'a\n', 'a\na\n'],
    [`s#a#b${continued}c#g`, 'aa\n', 'b\ncb\nc\n'],
    [`s a b${continued}c `, 'a\n', 'b\nc\n'],
    [`s/a/first${continued}};#last/`, 'a\n', 'first\n};#last\n'],
    [`s/a/a${continued}b/;s/a${continued}b/X/`, 'a\n', 'X\n'],
    [`s/a/a${continued}b/\ns/a${continued}b/X/`, 'a\n', 'X\n'],
    [`s/a/\\\\${continued}/`, 'a\n', '\\\n\n'],
    [`s/a${continued}b/X/`, 'a\nb\0c\0', 'X\0c\0', '-z'],
    [`s/${continued}/X/g`, 'a\nb\n\0', 'aXbX\0', '-z'],
    [`s/a${continued}b/x${continued}y/`, 'a\nb\0', 'x\ny\0', '-z'],
    [`s/(a${continued}b)/<\\0>/`, 'a\nb\0', '<a\nb>\0', '-Ez'],
    [`/a${continued}b/p`, 'a\nb\0c\0', 'a\nb\0', '-zn'],
    [`\\#a${continued}b#p`, 'a\nb\0c\0', 'a\nb\0', '-zn'],
    [`s/a${continued}b/X/`, 'a\nb\n', 'a\nb\n'],
    [`s/a/b${continued}c/`, 'a\0a\0', 'b\nc\0b\nc\0', '-z'],
  ]
  for (const [script, input, stdout, flags = ''] of cases) {
    it(JSON.stringify(script) + ' ' + flags, () => {
      const files = { input, program: script }
      for (const command of [`sed ${flags} ${quote(script)} input`, `sed ${flags} -e ${quote(script)} input`, `sed ${flags} -f program input`]) {
        assert.deepEqual(createTerminal(files).run(command), result(stdout), command)
      }
    })
  }
  it('retains shell versus sed newline quoting semantics', () => {
    const terminal = createTerminal({ input: 'a\n' })
    assert.deepEqual(terminal.run('sed "s/a/b\\\nc/" input'), result('bc\n'))
    assert.deepEqual(terminal.run("sed 's/a/b\\\nc/' input"), result('b\nc\n'))
  })
})

describe('sed distinguishes malformed multiline syntax from unsupported features', () => {
  const scripts = [
    's/a\nb/X/', 's/a/b\nc/', 's/a/\\\\\n/', 's/a/b\\', 's/a\\',
    `s/[a${continued}b]/X/`, `s/[a\nb]/X/`, `s/[[:a${continued}lpha:]]/X/`,
    `s/[[:a\nlpha:]]/X/`, `/a\nb/p`, `/[a${continued}b]/p`,
  ]
  for (const script of scripts) {
    it(`rejects ${JSON.stringify(script)} before producing output`, () => {
      const actual = createTerminal({ input: 'a\n', program: script }).run('sed -e p -f program input')
      assert.equal(actual.exitCode, 1)
      assert.equal(actual.stdout, '')
      assert.match(actual.stderr, /unterminated/u)
      assert.deepEqual(actual.unsupported, [])
    })
  }
  it('cannot finish a partial substitution in a later expression or script file', () => {
    const files = { input: 'a\n', first: 's/a/b\\', second: 'c/' }
    for (const command of [
      "sed -e 's/a/b\\' -e 'c/' input", 'sed -f first -f second input',
      "sed -e 's/a/b\\' -f second input", "sed -f first -e 'c/' input",
    ]) {
      const actual = createTerminal(files).run(command)
      assert.equal(actual.exitCode, 1)
      assert.equal(actual.stdout, '')
      assert.match(actual.stderr, /unterminated/u)
      assert.deepEqual(actual.unsupported, [])
    }
  })
  it('reports remaining unsupported replacement modes after a valid continuation', () => {
    const command = `sed ${quote(`s/a/b${continued}\\U&/`)} input 2>/dev/null | cat`
    const actual = createTerminal({ input: 'a\n' }).run(command)
    assert.equal(actual.exitCode, 0)
    assert.equal(actual.stderr, '')
    assert.equal(actual.unsupported.length, 1)
    assert.equal(actual.unsupported[0].detail, 'replacement escape')
  })
})

describe('sed zero escapes have distinct regex and replacement meanings', () => {
  const cases = [
    [String.raw`s/\0/X/g`, '0\0x00\\0\n', 'X\0xXX\\X\n'],
    [String.raw`s/\00/X/g`, '0\0x00\\0\n', '0\0xX\\0\n'],
    [String.raw`s/\012/X/g`, '012\n', 'X\n'],
    [String.raw`s/\\0/X/g`, '\\0 0\n', 'X 0\n'],
    [String.raw`s/(\0+)/<\0>/g`, '1002\n', '1<00>2\n', '-E'],
    [String.raw`/\0/p`, '0\n\0\n', '0\n', '-n'],
    [String.raw`s/x/\0/`, 'x\n', 'x\n'],
    [String.raw`s/x/\00/`, 'x\n', 'x0\n'],
    [String.raw`s/x/\012/`, 'x\n', 'x12\n'],
    [String.raw`s/x/\\0/`, 'x\n', '\\0\n'],
    [String.raw`s/^/\0X/`, '\n', 'X\n'],
    [String.raw`s/(.)(.)(.)(.)(.)(.)(.)(.)(.)/\0/`, '123456789\n', '123456789\n', '-E'],
    [String.raw`s/(a)/\0:\1/`, 'a\n', 'a:a\n', '-E'],
    [String.raw`s/.*/<\0>/`, 'a\0b\n', '<a\0b>\n'],
    [String.raw`s/a/\0\0/g`, 'a\0a\0', 'aa\0aa\0', '-z'],
    [String.raw`s0x0\00`, 'x\n', '0\n'],
    [String.raw`s0x0\\0`, 'x\n', '\\\n'],
  ]
  for (const [script, input, stdout, flags = ''] of cases) {
    it(JSON.stringify(script) + ' ' + flags, () => {
      assert.deepEqual(createTerminal({ input }).run(`sed ${flags} ${quote(script)} input`), result(stdout))
    })
  }
  it('keeps unsupported zero escapes inside bracket expressions on diagnostics', () => {
    const actual = createTerminal({ input: '0\\\n' }).run(String.raw`sed 's/[\0]/X/g' input 2>/dev/null | cat`)
    assert.equal(actual.exitCode, 0)
    assert.equal(actual.stderr, '')
    assert.equal(actual.unsupported.length, 1)
    assert.equal(actual.unsupported[0].detail, 'regex escape')
  })
})
