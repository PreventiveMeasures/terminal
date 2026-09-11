import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Independently expressed cases from GNU Bash5.2.37 parse.y cond_term,
// execute_cmd.c execute_cond_node and test.c arithcomp. The upstream cond.tests
// fixture also covers predicate ambiguity, quoting, and arithmetic precedence.
const terminal = () => createTerminal({ data: 'input\n', dir: { file: '' } })
const expected = (exitCode = 0, stdout = '', stderr = '', notes = []) => ({ stdout, stderr, exitCode, cwd: '/', notes, unsupported: [] })

describe('conditional quoting survives continuations and concatenated words', () => {
  for (const [source, status] of [
    ['[[ $\\\n"foo" == foo ]]', 0], ['[[ $\\\n"" ]]', 1],
    ['[[ $\\\n\\\n"foo" == foo ]]', 0], ['[[ -n $\\\n"" ]]', 1],
    ['[[ -z $\\\n"" ]]', 0], ['[[ $\\\n"*" == "*" ]]', 0],
    ["[[ $\\\n'foo' == foo ]]", 0],
    ['[[ a$\\\n"b"c == abc ]]', 0],
    ['[[ $\\\n"!" ]]', 0], ['[[ $\\\n"-n" ]]', 0],
    ['[[ "literal$\\\n"value"" == \'literal$value\' ]]', 0],
  ]) {
    it(source, () => { assert.deepEqual(terminal().run(source), expected(status)) })
  }

  it('consumes original source positions after removing local continuations', () => {
    const source = '[[ $\\\n"one" == one ]]; printf before; [[ $\\\n"two" == two ]] && printf after'
    assert.deepEqual(terminal().run(source), expected(0, 'beforeafter'))
  })

  it('keeps continuation recognition in a nested command substitution', () => {
    assert.deepEqual(terminal().run('printf "%s" "$(if [[ $\\\n"foo" == foo ]]; then printf yes; fi)"'), expected(0, 'yes'))
  })
})

describe('conditional predicates retain the Bash expression grammar', () => {
  for (const [expression, status] of [
    ["'!'", 0], ["'-n'", 0], ["'-v'", 0], ["'=='", 0],
    ['-n -n', 0], ['-n ==', 0], ['-z ==', 1], ['-n -Q', 0],
    ['(a)', 0], ['(-n a)', 0], ['! ! ! 1 -eq 1', 1], ['! ! ! ! 1 -eq 1', 0],
    ['a || "" && ""', 0], ['(a || "") && ""', 1], ['"" && a || b', 0],
  ]) {
    it(expression, () => { assert.deepEqual(terminal().run(`[[ ${expression} ]]`), expected(status)) })
  }

  for (const source of [
    "[[ '-n' x ]]", "[[ x '==' x ]]", 'operator=-n; [[ $operator x ]]',
    'operator="=="; [[ x $operator x ]]', '[[ ! ]]', '[[ -n ]]', '[[ ! = ! ]]',
  ]) {
    it(`diagnoses ${source}`, () => {
      const result = terminal().run(source)
      assert.notEqual(result.exitCode, 0)
      assert.equal(result.stdout, '')
      assert.ok(result.unsupported.length > 0)
    })
  }
})

describe('conditional operands expand in order with lazy state and input consumption', () => {
  for (const [source, status, stdout, notes] of [
    ['n=1; [[ n -eq $((n=2)) ]]; echo "$? $n"', 0, '0 2\n'],
    ['n=1; [[ n++ -eq $n ]]; echo "$? $n"', 0, '0 2\n'],
    ['n=1; [[ $((n=2)) -eq $((n=3)) ]]; echo "$? $n"', 0, '1 3\n'],
    ['false; [[ -n x && $? -eq 1 ]]', 0, ''],
    ['false; [[ "$(true)" == "" && $? -eq 0 ]]', 0, ''],
    ['n=0; [[ -n a || n++ -eq 0 ]]; echo "$n"', 0, '0\n'],
    ['n=0; [[ -z a && n++ -eq 0 ]]; echo "$n"', 0, '0\n'],
    ['printf input | { [[ -z "" || -n "$(cat)" ]]; cat; }', 0, 'input'],
    ['printf input | { [[ -n "" && -n "$(cat)" ]]; cat; }', 0, 'input'],
    ['printf input | { [[ -n "$(cat)" || -n "$(cat)" ]]; cat; }', 0, ''],
    ['printf input | [[ "$(head -c 1)" == i && "$(cat)" == nput ]]', 0, '', ['head: selected 1 of 5 bytes from standard input.']],
    ['{ [[ "$(head -c 1)" == i && "$(cat)" == $\'nput\\n\' ]]; } < data', 1, '', ['head: selected 1 of 6 bytes from standard input.']],
    ['{ [[ "$(head -c 1)" == i && "$(cat)" == nput ]]; } < data', 0, '', ['head: selected 1 of 6 bytes from standard input.']],
  ]) {
    it(source, () => { assert.deepEqual(terminal().run(source), expected(status, stdout, '', notes)) })
  }

  it('preserves ordinary inner command errors without inventing unsupported notes', () => {
    const result = terminal().run('[[ ! -n "$(cat absent)" ]]')
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /absent: no such file or directory/iu)
    assert.deepEqual(result.unsupported, [])
  })

  it('applies conditional redirects before expanding command substitutions', () => {
    assert.deepEqual(terminal().run('[[ ! -n "$(cat absent)" ]] 2>/dev/null'),
      expected(0, '', '', ['cat: no such file or directory: "absent".']))
    assert.deepEqual(terminal().run('[[ "$(cat)" == input ]] < data'), expected())
  })
})
