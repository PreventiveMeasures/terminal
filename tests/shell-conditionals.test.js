import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU Bash5.2.37 parse.y cond_term and execute_cmd.c execute_cond_node:
// operands do not split/glob, quoted pattern fragments are literal, boolean
// branches expand lazily, and numeric operands use shell arithmetic.
const FILES = { 'plain.txt': 'data\n', 'empty.txt': '', 'dir/a b.txt': 'x', 'dir/a.js': '' }
const terminal = (options) => createTerminal(FILES, options)
const result = (exitCode = 0, stdout = '') => ({ stdout, stderr: '', exitCode, cwd: '/', notes: [], unsupported: [] })

function check(command, exitCode = 0, stdout = '') {
  assert.deepEqual(terminal().run(command), result(exitCode, stdout), command)
}

describe('[[ scalar and file predicates', () => {
  for (const [expression, status] of [
    ['-f plain.txt', 0], ['-f empty.txt', 0], ['-f dir', 1], ['-f missing', 1],
    ['-d dir', 0], ['-d plain.txt', 1], ['-e plain.txt', 0], ['-a dir', 0],
    ['-e missing', 1], ['-f "dir/a b.txt"', 0], ['-f plain.txt/../empty.txt', 1],
    ['-e /dev/null', 0], ['-f /dev/null', 1], ['-d /', 0],
    ['-n text', 0], ['-n ""', 1], ['-z ""', 0], ['-z text', 1],
    ['text', 0], ['""', 1], ["'-f'", 0], ['a==b', 0],
    ['! text', 1], ['! ""', 0], ['! ! text', 0], ['( text )', 0],
  ]) {
    it(expression, () => { check(`[[ ${expression} ]]`, status) })
  }

  for (const command of [
    'path="dir/a b.txt"; [[ -f $path ]]',
    'value="a b"; [[ $value == "a b" ]]',
    'value="*"; [[ $value == "*" ]]',
    'value=""; [[ -z $value ]]',
    'unset value; [[ -z $value ]]',
    '[[ -d ~ ]]',
    '[[ -n "$HOME" ]]',
    '[[ -n $"value" ]]',
  ]) {
    it(command, () => { check(command) })
  }
})

describe('[[ boolean grouping and lazy evaluation', () => {
  for (const [expression, status] of [
    ['a && b', 0], ['a && ""', 1], ['"" || b', 0], ['"" || ""', 1],
    ['a || "" && ""', 0], ['( a || "" ) && ""', 1],
    ['! ( a && b )', 1], ['! ( "" || "" )', 0],
    ['-f plain.txt && ( -d dir || -f missing )', 0],
    ['"" && -r plain.txt', 1], ['a || -r plain.txt', 0],
    ['"" && -n "$UNIMPLEMENTED_ENVIRONMENT"', 1],
    ['a || -n "$(grep --unknown plain.txt)"', 0],
    ['"" && -n "$(printf bad)"', 1],
  ]) {
    it(expression, () => { check(`[[ ${expression} ]]`, status) })
  }

  it('skips arithmetic and command-substitution side effects', () => {
    check('n=0; [[ a || n++ -eq 0 ]]; [[ "" && n++ -eq 0 ]]; echo "$n"', 0, '0\n')
    check('n=0; [[ a || -n "$(n=9; printf bad)" ]]; echo "$n"', 0, '0\n')
  })

  it('runs ordinary surrounding shell gates, groups, loops, and substitutions', () => {
    check('if [[ -f plain.txt ]]; then echo yes; else echo no; fi', 0, 'yes\n')
    check('if [[ -f missing ]]; then echo no; elif [[ -d dir ]]; then echo dir; fi', 0, 'dir\n')
    check('for f in plain.txt missing; do [[ -f $f ]] && echo "$f"; done', 1, 'plain.txt\n')
    check('echo "$(if [[ -n one && -f plain.txt ]]; then printf yes; fi)"', 0, 'yes\n')
    check('[[ -f missing ]] || { [[ -f plain.txt ]] && echo yes; }', 0, 'yes\n')
    check('printf input | { [[ -f plain.txt ]]; cat; }', 0, 'input')
    check('echo [[ -f plain.txt ]]', 0, '[[ -f plain.txt ]]\n')
  })
})

describe('[[ pattern operands preserve shell quoting', () => {
  for (const [expression, status] of [
    ['abc == a*', 0], ['abc = a?c', 0], ['abc != a*', 1], ['abc != b*', 0],
    ['abc == "a*"', 1], ["'a*' == 'a*'", 0], ['abc == a"*"', 1],
    ['abc == [a-z]*', 0], ['abc == [[:lower:]]*', 0], ["'a[' == 'a['", 0],
    ['dir/file == *', 0], ['.hidden == *', 0], ['"" == *', 0],
    ["$'a\\n' == a", 1], ["$'a\\n' == '*'", 1], ["$'a\\n' == *", 0],
    ['café == café', 0], ["'@(a|b)' == '@(a|b)'", 0],
    [String.raw`'a*' == a\*`, 0], [String.raw`'a\b' == 'a\b'`, 0],
  ]) {
    it(expression, () => { check(`[[ ${expression} ]]`, status) })
  }

  for (const [command, status] of [
    ['pattern="a*"; [[ abc == $pattern ]]', 0],
    ['pattern="a*"; [[ abc == "$pattern" ]]', 1],
    ['pattern="a*"; [[ "a*" == "$pattern" ]]', 0],
    ['pattern="@(a|b)"; [[ a || a == $pattern ]]', 0],
    ['pattern="?"; [[ x == "${pattern}" ]]', 1],
    ['pattern="?"; [[ x == ${pattern} ]]', 0],
  ]) {
    it(command, () => { check(command, status) })
  }
})

describe('[[ variable presence distinguishes unset and empty', () => {
  for (const [command, status] of [
    ['[[ -v absent ]]', 1], ['value=; [[ -v value ]]', 0],
    ['value=text; [[ -v value ]]', 0], ['value=text; unset value; [[ -v value ]]', 1],
    ['[[ -v HOME && -v PWD && -v USER && -v LOGNAME ]]', 0],
    ['unset HOME; [[ -v HOME ]]', 1], ['name=value; value=; [[ -v "$name" ]]', 0],
    ['[[ -v 1 ]]', 1], ['[[ -v -1 ]]', 1], ['[[ -v "invalid name" ]]', 1],
  ]) {
    it(command, () => { check(command, status) })
  }
})

describe('[[ numeric predicates use shell arithmetic', () => {
  for (const [expression, status] of [
    ['1 -eq 1', 0], ['1 -ne 1', 1], ['1 -lt 2', 0], ['1 -le 1', 0],
    ['2 -gt 1', 0], ['2 -ge 2', 0], ['0x10 -eq 16', 0], ['010 -eq 8', 0],
    ['"1 + 2" -eq 3', 0], ['"" -eq 0', 0], ['9007199254740993 -gt 9007199254740992', 0],
  ]) {
    it(expression, () => { check(`[[ ${expression} ]]`, status) })
  }

  it('compares statuses and updates scalar arithmetic state', () => {
    check('false; if [[ $? -ne 0 ]]; then echo failed; fi', 0, 'failed\n')
    check('n=1; [[ n++ -eq 1 && n -eq 2 ]]; echo "$n"', 0, '2\n')
    check('n=1; [[ "n += 2" -eq 3 ]]; echo "$n"', 0, '3\n')
  })
})

describe('[[ scanning retains compound words and real source boundaries', () => {
  for (const command of [
    '[[ "$(printf "a b")" == "a b" ]]',
    '[[ "$(printf "]]")" == "]]" ]]',
    "[[ 'a)b' == 'a)b' ]]",
    '[[ -n x\n&& -f plain.txt\n]]',
    '[[ -n x # comment\n && -f plain.txt ]]',
    '[[ -n \\\nx ]]; [[ -f plain.txt ]]',
    'value=x; [[ $\\\nvalue == x ]]; [[ -f plain.txt ]]',
    'value=x; [[ $value""y == xy ]]',
    'value=x; [[ "$value"y == xy ]]',
    '[[ ${absent:-fallback} == fallback ]]',
    '[[ ${absent:-"a b"} == "a b" ]]',
    "[[ ${absent:-'a b'} == 'a b' ]]",
    '[[ $((1 + 2)) -eq 3 ]]',
  ]) {
    it(command, () => { check(command) })
  }

  it('recognizes only bare condition keywords in command position', () => {
    const quoted = terminal().run(`'[[' -f plain.txt ']]'`)
    assert.equal(quoted.exitCode, 127)
    assert.match(quoted.stderr, /command not found/u)
    assert.equal(quoted.unsupported[0].kind, 'command')
    check('echo "[[" -f plain.txt "]]"', 0, '[[ -f plain.txt ]]\n')
  })
})

describe('[[ unsupported and malformed input always reaches diagnostics', () => {
  for (const command of [
    '[[ ]]', '[[ a b ]]', '[[ -f ]]', '[[ a == ]]', '[[ a == b extra ]]',
    '[[ a && ]]', '[[ (a ]]', '[[ a; b ]]', '[[ -Q value ]]', '[[ a -Q b ]]',
    `[[ a '==' a ]]`, '[[ -n"" value ]]', '[[ -f\nplain.txt ]]', '[[ a\n== b ]]',
    '[[ a == b', '[[ a == b ]] extra', '[[ a < b ]]', '[[ b > a ]]', '[[ -r plain.txt ]]',
    '[[ -s plain.txt ]]', '[[ -L plain.txt ]]', '[[ plain.txt -nt empty.txt ]]',
    '[[ -v array[0] ]]', '[[ -v 0 ]]', '[[ -v BASH_REMATCH ]]',
    '[[ -e /dev/stdin ]]', '[[ a =~ a ]]', '[[ a == @(a|b) ]]',
    'pattern="@(a|b)"; [[ a == $pattern ]]', '[[ é == ? ]]',
    '[[ -n "$PATH" ]]', '[[ 08 -eq 8 ]]', '[[ -e <(printf input) ]]',
  ]) {
    it(command, () => {
      const r = terminal().run(command)
      assert.equal(r.stdout, '', command)
      assert.notEqual(r.exitCode, 0, command)
      assert.ok(r.unsupported.length > 0, command)
      assert.equal(r.unsupported[0].kind, 'feature', command)
    })
  }

  it('keeps runtime diagnostics after stderr redirection and pipeline status replacement', () => {
    const r = terminal().run('[[ -r plain.txt ]] 2>/dev/null | cat')
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '')
    assert.equal(r.exitCode, 0)
    assert.deepEqual(r.unsupported.map(({ detail }) => detail), ['[[ -r'])
  })

  it('bounds nested and chained conditional ASTs explicitly', () => {
    for (const source of ['( '.repeat(70) + 'x' + ' )'.repeat(70), Array.from({ length: 140 }, () => 'x').join(' && ')]) {
      const r = terminal().run(`[[ ${source} ]]`)
      assert.equal(r.unsupported.length, 1)
      assert.match(r.unsupported[0].detail, /^\[\[ (?:nesting|complexity)$/u)
    }
  })
})
