import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { compileGlob, hasExtglob } from '../src/glob.js'

// Bash5.2.37 lib/glob/sm_loop.c BRACKMATCH finds raw ':]' before
// dequoting class names; glob.c udequote_pathname also drops a trailing '\\'.
// smatch.c cclass_name includes the GNU ascii and word classes.
const result = (exitCode = 0, stdout = '') => ({ stdout, stderr: '', exitCode, cwd: '/', notes: [], unsupported: [] })

describe('glob named classes use shell matching rules', () => {
  for (const [pattern, matched, rejected] of [
    ['[[:di\\git:]]', '019', 'd:]'],
    ['[[:digit\\:]]', '019', 'd:]'],
    ['[[:BOGUS:]]', '', 'BOGUS:]'],
    ['[[:not-a-class:]]', '', 'not-a:'],
    ['[[:BOGUS:]a]', 'a', 'b:]'],
    ['[![:BOGUS:]]', 'aB:]', ''],
    ['[[:ascii:]]', '\u0000\t\n AZaz09\u007F', ''],
    ['[[:word:]]', 'Az09_', ': !'],
    ['[[:digit]', ':digit', '[019'],
    ['[a[:digit]', 'a:digit', '[019'],
  ]) {
    it(pattern, () => {
      const re = compileGlob(pattern, { bash: true })
      for (const character of matched) assert.equal(re.test(character), true, JSON.stringify(character))
      for (const character of rejected) assert.equal(re.test(character), false, JSON.stringify(character))
      assert.equal(re.test(''), false)
      assert.equal(re.test('aa'), false)
    })
  }

  for (const [command, status] of [
    ["[[ 1 == [[:'digit':]] ]]", 0],
    ["[[ 1 == [[:digit':']] ]]", 0],
    ["[[ 1 == [[':'digit:]] ]]", 1],
    ["[[ 'd]' == [[':'digit:]] ]]", 0],
    ["[[ 'a]' == [['.'a'.']] ]]", 0],
    ["[[ 'a]' == [['='a'=']] ]]", 0],
    ["[[ 'B]' == [[:BOGUS:]] ]]", 1],
    ["[[ a == [[:BOGUS:]a] ]]", 0],
    ["pattern='[[:di\\git:]]'; [[ 1 == $pattern ]]", 0],
    ["[[ Z == [[:ascii:]] ]]", 0],
  ]) {
    it(command, () => { assert.deepEqual(createTerminal({}).run(command), result(status)) })
  }

  it('preserves the different Bash pathname and GNU fnmatch class dialects', () => {
    const files = { 1: '', a: '', 'B]': '', 'd]': '' }
    for (const [command, stdout] of [
      ["printf '<%s>' [[:di'git':]]", '<1>'],
      ["printf '<%s>' [[:BOGUS:]]", '<[[:BOGUS:]]>'],
      ["find . -name '[[:di\\git:]]'", './d]\n'],
      ["find . -name '[[:BOGUS:]]'", './B]\n'],
    ]) {
      assert.deepEqual(createTerminal(files).run(command), result(0, stdout), command)
    }
  })
})

describe('glob matching consumes a complete filename including final newlines', () => {
  for (const pattern of ['file', 'fi*e', 'file?']) {
    it(pattern, () => {
      assert.equal(compileGlob(pattern).test('file\n'), pattern === 'file?')
      assert.equal(compileGlob(pattern).test('file\r\n'), false)
    })
  }

  for (const [command, stdout] of [
    ["find . -name 'file'", './file\n'],
    ["find . -iname 'FILE'", './file\n'],
    ["printf '<%s>' fi*e", '<file>'],
    ["grep -rl x . --include='file'", './file\n'],
  ]) {
    it(command, () => {
      const files = { file: 'x\n', 'file\n': 'x\n', 'file\r\n': 'x\n' }
      assert.deepEqual(createTerminal(files).run(command), result(0, stdout))
    })
  }
})

// GNU findutils4.10.0 gl/lib/fnmatch_loop.c rejects unknown class names;
// unlike Bash, complementing an empty class must not make it match all files.
describe('unknown command filename classes remain diagnostic', () => {
  for (const command of [
    "find . -name '[[:bogus:]]'", "find . -name '[![:bogus:]]'",
    "find . -name '[a[:bogus:]]'", "grep -r x . --include='[![:bogus:]]'",
  ]) {
    it(command, () => {
      const actual = createTerminal({ a: 'x\n' }).run(command + ' 2>/dev/null | cat')
      assert.equal(actual.stdout, '')
      assert.equal(actual.stderr, '')
      assert.equal(actual.unsupported[0]?.detail, 'glob character class')
    })
  }
})

describe('extended glob diagnostics respect quoting and bracket boundaries', () => {
  for (const [pattern, extended] of [
    ['@(a|b)', true], ['?(a)', true], ['a*(b)', true],
    ['[?(]', false], ['[!@(]', false], [String.raw`\@(a)`, false],
    ['[[:digit:]@(]', false], ['[a]@(b)', true], ['[?(', true],
    ['[[:digit:]a]@(b)', true], [String.raw`[\]@(]`, false],
  ]) {
    it(pattern, () => { assert.equal(hasExtglob({ value: pattern, mask: null }), extended) })
  }

  for (const [command, status] of [
    ["pattern='[?(]'; [[ '(' == $pattern ]]", 0],
    ["pattern='[?(]'; [[ a == $pattern ]]", 1],
    ["pattern='[!@(]'; [[ a == $pattern ]]", 0],
    ["pattern='[[:digit:]@(]'; [[ 1 == $pattern ]]", 0],
    [String.raw`pattern='\@(a)'; [[ '@(a)' == $pattern ]]`, 0],
    ["pattern='@(a)'; [[ '@(a)' == \"$pattern\" ]]", 0],
  ]) {
    it(command, () => { assert.deepEqual(createTerminal({}).run(command), result(status)) })
  }

  it('still diagnoses an unquoted extended pattern after a bracket', () => {
    const actual = createTerminal({}).run("pattern='[a]@(b)'; [[ ab == $pattern ]] 2>/dev/null | cat")
    assert.equal(actual.stdout, '')
    assert.equal(actual.stderr, '')
    assert.equal(actual.unsupported[0]?.detail, '[[ extglob')
  })
})

describe('non-ASCII glob syntax cannot silently choose ASCII results', () => {
  for (const command of [
    "[[ z == [a-é] ]]", "[[ a != [é-z] ]]",
    "p='[a-é]'; [[ z == $p ]]", "find . -name '[a-é]'", "printf '%s' [a-é]",
  ]) {
    it(command, () => {
      const actual = createTerminal({ a: '', z: '' }).run('{ ' + command + '; } 2>/dev/null | cat')
      assert.equal(actual.stdout, '')
      assert.equal(actual.stderr, '')
      assert.equal(actual.unsupported[0]?.detail, 'non-ASCII glob matching')
    })
  }

  it('continues to match non-ASCII literal text and star patterns', () => {
    assert.deepEqual(createTerminal({}).run('[[ café == café* ]]'), result())
    assert.deepEqual(createTerminal({}).run('[[ a == [aé] ]]'), result())
    assert.deepEqual(createTerminal({}).run('[[ a == [[:é:]] ]]'), result(1))
  })
})
