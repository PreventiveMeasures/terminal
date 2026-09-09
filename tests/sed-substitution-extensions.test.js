import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU sed 4.9 compile.c match_slash/mark_subst_opts and execute.c do_subst
// define delimiter quoting and numeric occurrence counting. regexp.c
// match_regex remembers the last evaluated regex, including failed matches.
// https://github.com/mirror/sed/blob/v4.9/sed/compile.c
// https://github.com/mirror/sed/blob/v4.9/sed/execute.c
// https://github.com/mirror/sed/blob/v4.9/sed/regexp.c
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
const result = (stdout) => ({ stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [] })

function check(script, input, stdout, flags = '') {
  const actual = createTerminal({ input }).run(`sed ${flags} ${quote(script)} input`)
  assert.deepEqual(actual, result(stdout), script)
}

describe('sed accepts single-byte substitution delimiters', () => {
  for (const sep of ['a', 's', '1', '_', ' ', '\t', '\r', '|', '#', ':', '@', '%', ';', '}', ']', '[', '\\', '&', '\u0001']) {
    it(`delimiter ${JSON.stringify(sep)}`, () => {
      const program = `s${sep}x${sep}Y${sep}g`
      const actual = createTerminal({ input: 'x-x\n', program }).run('sed -f program input')
      assert.deepEqual(actual, result('Y-Y\n'))
    })
  }
  const cases = [
    [String.raw`s|a\|b|X|`, 'a|b\n', 'X\n'],
    [String.raw`s|a\|b|X|`, 'a|b\n', 'X|b\n', '-E'],
    [String.raw`s_[a_]+_X_`, '_aa_b\n', 'Xb\n', '-E'],
    [String.raw`s&x&\&&`, 'x\n', '&\n'],
    [String.raw`s0x0\00`, 'x\n', '0\n'],
    [String.raw`s1x1\11`, 'x\n', '1\n'],
    [String.raw`snxn\nn`, 'x\n', 'n\n'],
    [String.raw`s!x!\!!`, 'x\n', '!\n'],
    [String.raw`s&x&\0&`, 'x\n', 'x\n'],
    [String.raw`s.[.].X.`, '.\n', 'X\n'],
  ]
  for (const [script, input, stdout, flags] of cases) it(script, () => check(script, input, stdout, flags))
  for (const script of ['s', 's\nx\nY\n', 'séxéYé', 's😀x😀Y😀']) {
    it(`invalid delimiter is an ordinary script error: ${JSON.stringify(script)}`, () => {
      const actual = createTerminal({ input: 'x\n', program: script }).run('sed -f program input')
      assert.equal(actual.exitCode, 1)
      assert.equal(actual.stdout, '')
      assert.notEqual(actual.stderr, '')
      assert.deepEqual(actual.unsupported, [])
    })
  }
})

describe('sed whole-match replacement zero', () => {
  const cases = [
    [String.raw`s/a/[\0]/g`, 'aba\n', '[a]b[a]\n'],
    [String.raw`s/\(a\)\(b\)/\0-\2-\1-&/`, 'ab\n', 'ab-b-a-ab\n'],
    [String.raw`s/a/\01/`, 'a\n', 'a1\n'],
    [String.raw`s/a/\\0/`, 'a\n', '\\0\n'],
    [String.raw`s/^/\0X/`, 'a\n', 'Xa\n'],
    [String.raw`s/.*/\0\0/`, 'é😀\n', 'é😀é😀\n'],
    [String.raw`s/a|aa/<\0>/`, 'aa\n', '<aa>\n', '-E'],
  ]
  for (const [script, input, stdout, flags] of cases) it(script, () => check(script, input, stdout, flags))
})

describe('sed numeric substitution occurrences', () => {
  const cases = [
    ['s/a/X/1', 'aaaa\n', 'Xaaa\n'],
    ['s/a/X/2', 'aaaa\n', 'aXaa\n'],
    ['s/a/X/3', 'aaaa\n', 'aaXa\n'],
    ['s/a/X/5', 'aaaa\n', 'aaaa\n'],
    ['s/a/X/02', 'aaaa\n', 'aXaa\n'],
    ['s/a/X/2g', 'aaaa\n', 'aXXX\n'],
    ['s/a/X/g2', 'aaaa\n', 'aXXX\n'],
    ['s/a/X/2 g', 'aaaa\n', 'aXXX\n'],
    ['s/a/X/2gp', 'aaaa\n', 'aXXX\n', '-n'],
    ['s/a/X/p2', 'aaaa\n', 'aXaa\n', '-n'],
    ['s/a/X/5p', 'aaaa\n', '', '-n'],
    ['s/a/X/2', 'aa\naa\n', 'aX\naX\n'],
    ['s/^/X/2', 'aa\n', 'aa\n'],
    ['s/a*/X/2', 'baaaac\n', 'bXc\n'],
    ['s/a*/X/3', 'baaaac\n', 'baaaacX\n'],
    ['s/a*/X/3p', 'baaaa\n', '', '-n'],
    ['s/a*/X/2g', 'baaaac\n', 'bXcX\n'],
    ['s/b*/X/2', 'aaa\n', 'aXaa\n'],
    ['s/b*/X/2g', 'aaa\n', 'aXaXaX\n'],
    ['s/.*/X/2', 'abc\n', 'abc\n'],
    ['s/a/X/2', 'éa😀az\n', 'éa😀Xz\n'],
    ['s/a/X/9007199254740991p', 'a\n', '', '-n'],
    [String.raw`s/\(a\)/<\0-\1>/2`, 'aaa\n', 'a<a-a>a\n'],
    ['s/a|aa/X/2', 'aa aa\n', 'aa X\n', '-E'],
  ]
  for (const [script, input, stdout, flags] of cases) it(script + ' on ' + JSON.stringify(input), () => check(script, input, stdout, flags))
  for (const script of ['s/a/X/0', 's/a/X/00', 's/a/X/1 2', 's/a/X/2g3', 's/a/X/2gg', 's/a/X/2pp', 's/a/X/-1', 's/a/X/1.5']) {
    it(`invalid occurrence syntax is an ordinary script error: ${script}`, () => {
      const actual = createTerminal({ input: 'a\n' }).run(`sed ${quote(script)} input`)
      assert.equal(actual.exitCode, 1)
      assert.equal(actual.stdout, '')
      assert.notEqual(actual.stderr, '')
      assert.deepEqual(actual.unsupported, [])
    })
  }
  it('keeps locale-dependent regex limitations visible for numeric selectors', () => {
    const actual = createTerminal({ input: 'é😀z\n' }).run("sed 's/./X/2' input 2>/dev/null | cat")
    assert.equal(actual.exitCode, 0)
    assert.equal(actual.stderr, '')
    assert.equal(actual.unsupported.length, 1)
    assert.equal(actual.unsupported[0].detail, 'non-ASCII regex semantics')
  })
  it('reports unsupported numeric precision even when stderr is redirected', () => {
    const actual = createTerminal({ input: 'a\n' }).run("sed 's/a/X/9007199254740992' input 2>/dev/null | cat")
    assert.equal(actual.exitCode, 0)
    assert.equal(actual.stderr, '')
    assert.equal(actual.unsupported.length, 1)
    assert.equal(actual.unsupported[0].detail, 'substitution occurrence limit')
  })
})

describe('sed reuses the last evaluated regular expression', () => {
  const cases = [
    ['s/a/A/;s//X/', 'aa\n', 'AX\n'],
    ['s/a/A/;s//X/g', 'aaa\n', 'AXX\n'],
    ['/a/s//X/', 'aaa\n', 'Xaa\n'],
    ['/z/p;s//X/', 'aaa\n', 'aaa\n'],
    ['s/a/A/;/z/p;s//X/', 'aa\n', 'Aa\n'],
    ['s/a/A/;2s/z/Z/;s//X/', 'aa\n', 'AX\n'],
    ['s/a/A/;2{/b/p};s//X/', 'aab\n', 'AXb\n'],
    ['/a/{s//X/}', 'a\nb\n', 'X\nb\n'],
    ['/a/{/b/s//X/;s//Y/}', 'ab\n', 'aX\n'],
    ['/a/{/z/s//X/;s//Y/}', 'aa\n', 'aa\n'],
    ['1s/a/A/;s//X/', 'aa\naa\n', 'AX\nXa\n'],
    ['/a/,/b/s//X/', 'a\nb\na\nb\n', 'X\nX\nX\nX\n'],
    ['/a/p;//s//X/', 'a\nb\n', 'a\nX\nb\n'],
    [String.raw`/\(a\)/s//<\1>/`, 'a\n', '<a>\n'],
    [String.raw`s/\(a\)/A/;s//<\1>/`, 'aa\n', 'A<a>\n'],
    [String.raw`s/a/A/;s//<\1>/`, 'aa\n', 'A<>\n'],
    ['2s//X/', 'a\n', 'a\n'],
    ['/z/{s/a/A/};s//X/', 'a\n', 'a\n'],
  ]
  for (const [script, input, stdout, flags] of cases) it(script, () => check(script, input, stdout, flags))
  it('shares the last regex across expression and file boundaries, including -s', () => {
    const files = { first: 'aa\n', second: 'aa\n', program: 's//X/' }
    for (const flags of ['', '-s']) {
      const actual = createTerminal(files).run(`sed ${flags} -e 's/a/A/' -f program first second`)
      assert.deepEqual(actual, result('AX\nAX\n'))
    }
  })
  for (const script of ['s//X/', '//p', '2s/a/A/;s//X/']) {
    it(`missing prior regex is an ordinary runtime error: ${script}`, () => {
      const actual = createTerminal({ input: 'a\n' }).run(`sed ${quote(script)} input`)
      assert.equal(actual.exitCode, 1)
      assert.match(actual.stderr, /no previous regular expression/u)
      assert.deepEqual(actual.unsupported, [])
    })
  }
  for (const flag of ['i', 'I', 'm', 'M']) {
    it(`rejects modifier ${flag} on an empty regex before reading input`, () => {
      const actual = createTerminal({ input: 'a\n' }).run(`sed 's/a/A/;s//X/${flag}' input`)
      assert.equal(actual.exitCode, 1)
      assert.equal(actual.stdout, '')
      assert.match(actual.stderr, /cannot specify modifiers on empty regexp/u)
      assert.deepEqual(actual.unsupported, [])
    })
  }
  it('validates captures when an address regex is reused by substitution', () => {
    const actual = createTerminal({ input: 'a\n' }).run(String.raw`sed '/a/s//\1/' input`)
    assert.equal(actual.exitCode, 1)
    assert.match(actual.stderr, /invalid reference/u)
    assert.deepEqual(actual.unsupported, [])
  })
  it('does not leak a previous regex into the next command invocation', () => {
    const terminal = createTerminal({ input: 'a\n' })
    assert.deepEqual(terminal.run("sed 's/a/A/' input"), result('A\n'))
    const actual = terminal.run("sed 's//X/' input")
    assert.equal(actual.exitCode, 1)
    assert.match(actual.stderr, /no previous regular expression/u)
    assert.deepEqual(actual.unsupported, [])
  })
})
