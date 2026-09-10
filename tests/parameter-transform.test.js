import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Independently expressed from Bash5.2.37 subst.c verify_substring_values,
// match_upattern, pat_subst, parameter_brace_patsub, and quote_string_for_repl.
// The upstream new-exp.tests/new-exp16.sub fixtures cover these same families.
const expected = (stdout = '', exitCode = 0) => ({ stdout, stderr: '', exitCode, cwd: '/', unsupported: [] })
const check = (source, stdout, files = {}) => assert.deepEqual(createTerminal(files).run(source), expected(stdout), source)

describe('scalar substring bounds and arithmetic', () => {
  for (const [expression, result] of [
    ['1', 'bcdef'], ['1:2', 'bc'], ['0', 'abcdef'], ['0:0', ''], ['0:99', 'abcdef'],
    ['6', ''], ['7', ''], [' -1', 'f'], [' -2:1', 'e'], [' -6', 'abcdef'], [' -7', ''],
    ['0:-1', 'abcde'], ['1:-1', 'bcde'], ['1:-5', ''], [' -3:-1', 'de'],
    [':', ''], ['', 'abcdef'], ['1:', ''], [':2', 'ab'],
    ['1+1:2*2', 'cdef'], ['1?2:4:2', 'cd'], ['0?2:4:2', 'ef'],
    ['(1?2:4):2', 'cd'], ['1?(0?1:3):4:2', 'de'],
    ['0x2:010', 'cdef'], ['2#10:2', 'cd'], ['~0', 'f'],
    ['9223372036854775807', ''], [' -9223372036854775808', ''],
  ]) {
    it(expression, () => { check('x=abcdef; printf "%s" "${x:' + expression + '}"', result) })
  }

  for (const [source, stdout] of [
    ['x=abcdef; n=2; printf "%s" "${x:n:2}"', 'cd'],
    ['x=abcdef; n=2; printf "%s" "${x:$n:${#x}-n}"', 'cdef'],
    ['x=abcdef; printf "%s" "${x:$(printf 2):$(printf 3)}"', 'cde'],
    ['x=abcdef; printf "%s" "${x:$((1+1)):$((2+1))}"', 'cde'],
    ['x=abcdef; printf "%s" "${x:${n:-2}:${m:-3}}"', 'cde'],
    ['x=abcdef; n=0; printf "%s" "${x:n++:++n}"; printf ":%s" "$n"', 'ab:2'],
    ['x=abc; n=0; printf "%s" "${x:9:n++}"; printf ":%s" "$n"', ':0'],
    ['x=abc; n=0; printf "%s" "${x:3:n++}"; printf ":%s" "$n"', ':1'],
    ['n=0; printf "%s" "${missing:n++}"; printf ":%s" "$n"', ':0'],
    ['x=; n=0; printf "%s" "${x:n++}"; printf ":%s" "$n"', ':1'],
    ['x=abcdef; printf "%s" "${x:-fallback}" "${x: -1}"', 'abcdeff'],
    ['false; printf "%s" "${?:0:1}"', '1'],
    ["x=$'a\nb\n'; printf '%s' \"${x:1:2}\"", '\nb'],
    ['x="a b c"; printf "<%s>" ${x:2} "${x:2}"', '<b><c><b c>'],
    ['x="*.txt"; printf "<%s>" ${x:0} "${x:0}"', '<a.txt><b.txt><*.txt>'],
  ]) {
    it(source, () => { check(source, stdout, { 'a.txt': '', 'b.txt': '' }) })
  }

  it('reports invalid negative lengths as ordinary errors and stops expansion', () => {
    for (const expression of ['2:-5', '0:-7', '6:-1']) {
      const actual = createTerminal({}).run('x=abcdef; printf "%s" "${x:' + expression + '}"; echo unexpected')
      assert.equal(actual.stdout, '')
      assert.equal(actual.exitCode, 1)
      assert.match(actual.stderr, /substring expression < 0/u)
      assert.deepEqual(actual.unsupported, [])
    }
  })
})

describe('scalar pattern replacement delimiters and matching', () => {
  for (const [expression, result] of [
    ['a/X', 'Xbcabc'], ['/a/X', 'XbcXbc'], ['a/', 'bcabc'], ['/a/', 'bcbc'],
    ['a', 'bcabc'], ['/a', 'bcbc'], ['z/X', 'abcabc'], ['/', 'abcabc'], ['', 'abcabc'],
    ['a*/X', 'X'], ['*b/X', 'Xc'], ['/a*b/X', 'Xc'], ['?b/X', 'Xcabc'],
    ['/?b/X', 'XcXc'], ['[ab]/X', 'Xbcabc'], ['/[ab]/X', 'XXcXXc'],
    ['[[:lower:]]/X', 'Xbcabc'], ['/[[:bogus:]]/X', 'abcabc'],
    ['#a/X', 'Xbcabc'], ['%c/X', 'abcabX'], ['#b/X', 'abcabc'], ['%b/X', 'abcabc'],
    ['#/pre', 'preabcabc'], ['%/post', 'abcabcpost'], ['*/*', '*'], ['/*/X', 'X'],
  ]) {
    it(expression, () => { check('x=abcabc; printf "%s" "${x/' + expression + '}"', result) })
  }

  for (const [source, stdout] of [
    ["x=a/b/a; printf '%s' \"${x//\\//_}\"", 'a_b_a'],
    ["x=a/b/a; printf '%s' \"${x/'/'/_}\"", 'a_b/a'],
    ['x=a/b/a; printf "%s" "${x///a}"', 'a/b'],
    ['x=a/b/a; printf "%s" "${x////X}"', 'aXbXa'],
    ['x=a/b/a; printf "%s" "${x///}"', 'aba'],
    ['x=a/b/a; printf "%s" "${x//}"', 'a/b/a'],
    ['x=abc; printf "%s" "${x/b/x/y}"', 'ax/yc'],
    ['x=abc; p=b; r="x/y"; printf "%s" "${x/$p/$r}"', 'ax/yc'],
    ['x=abc; printf "%s" "${x/$(printf b)/$(printf x/y)}"', 'ax/yc'],
    ['x=abc; printf "%s" "${x/${p:-b}/${r:-x/y}}"', 'ax/yc'],
    ['x=abc; printf "%s" "${x/$((1+1))/x}"', 'abc'],
    ['x=abc; p=""; printf "%s" "${x/$p/X}" "${x//$p/X}"', 'abcabc'],
    ['x=; printf "<%s>" "${x/*/X}" "${x//*/X}" "${x/#/X}" "${x/%/X}"', '<X><X><X><X>'],
    ['x="#a#"; printf "%s" "${x//#/X}"', 'XaX'],
    ['x="#a#"; printf "%s" "${x/"#"/X}"', 'Xa#'],
    ['x=abc; p="#a"; printf "%s" "${x/$p/X}"', 'Xbc'],
    ["x='a*b'; printf '%s' \"${x/'*'/X}\"", 'aXb'],
    ['x=abc; p="*"; printf "%s" "${x/"$p"/X}"', 'abc'],
    ['x=café; printf "%s" "${x/é/e}" "${x/*/X}"', 'cafeX'],
    ['x="a b"; printf "<%s>" ${x/a/x} "${x/a/x}"', '<x><b><x b>'],
    ['x=a; printf "<%s>" ${x/a/"b c"} "${x/a/"b c"}"', '<b><c><b c>'],
    ['HOME=/agent; x=a; printf "%s" "${x/a/~}"', '/agent'],
    ['HOME=/agent; x=a; printf "%s" "${x/a/"~"}"', '~'],
  ]) {
    it(source, () => { check(source, stdout) })
  }
})

describe('replacement ampersands retain inner quote and backslash semantics', () => {
  for (const [replacement, stdout] of [
    ['&', 'abc'], ['<&>', 'a<b>c'], ['&&', 'abbc'], [String.raw`\&`, 'a&c'],
    ['"&"', 'a&c'], ["'&'", 'a&c'], [String.raw`\\&`, String.raw`a\bc`],
    [String.raw`"\&"`, String.raw`a\&c`], [String.raw`'\&'`, String.raw`a\&c`],
    [String.raw`\\`, String.raw`a\c`], [String.raw`\q`, 'aqc'], [String.raw`'\q'`, String.raw`a\qc`],
  ]) {
    it(replacement, () => { check('x=abc; printf "%s" "${x/b/' + replacement + '}"', stdout) })
  }

  for (const [source, stdout] of [
    ['x=abc; r="<&>"; printf "%s" "${x/b/$r}"', 'a<b>c'],
    ['x=abc; r="<&>"; printf "%s" "${x/b/"$r"}"', 'a<&>c'],
    ["x=abc; r='\\&'; printf '%s' \"${x/b/$r}\"", 'a&c'],
    ["x=abc; r='\\&'; printf '%s' \"${x/b/\"$r\"}\"", String.raw`a\&c`],
    ["x=abc; r='\\\\&'; printf '%s' \"${x/b/$r}\"", String.raw`a\bc`],
    ["x=abc; r='\\'; printf '%s' \"${x/b/$r\"&\"}\"", String.raw`a\bc`],
    ['x=abc; printf "%s" "${x//?/[&]}"', '[a][b][c]'],
  ]) {
    it(source, () => { check(source, stdout) })
  }
})

describe('transforms evaluate selected operands in order', () => {
  for (const [source, stdout] of [
    ['x=abc; n=0; printf "%s" "${x/$((n=1))/$((n=2))}"; echo ":$n"', 'abc:2\n'],
    ['n=0; printf "%s" "${missing/$((n=1))/$((n=2))}"; echo ":$n"', ':0\n'],
    ['x=; n=0; printf "%s" "${x/$((n=1))/$((n=2))}"; echo ":$n"', ':2\n'],
    ['x=abc; printf "%s" "${x/${p:=a}/${r:=X}}"; echo ":$p:$r"', 'Xbc:a:X\n'],
    ['x=abc; printf "%s" "${x/$((x=7))/X}"; echo ":$x"', 'abc:7\n'],
    ['x=abc; printf "%s" "${x:$((x=7))}"; echo ":$x"', ':7\n'],
    ['printf 1 | { x=abc; printf "%s" "${x:$(cat):1}"; cat; }', 'b'],
    ['printf a | { x=abc; printf "%s" "${x/$(cat)/X}"; cat; }', 'Xbc'],
  ]) {
    it(source, () => { check(source, stdout) })
  }

  it('retains ordinary and unsupported diagnostics from operand commands', () => {
    const ordinary = createTerminal({}).run('x=abc; printf "%s" "${x/b/$(cat missing)}"')
    assert.equal(ordinary.stdout, 'ac')
    assert.match(ordinary.stderr, /missing: no such file/u)
    assert.deepEqual(ordinary.unsupported, [])
    const unsupported = createTerminal({}).run('{ x=abc; printf "%s" "${x/b/$(unknown-command)}"; } 2>/dev/null | cat')
    assert.equal(unsupported.stdout, 'ac')
    assert.equal(unsupported.stderr, '')
    assert.equal(unsupported.unsupported[0]?.command, 'unknown-command')
  })
})

describe('unsupported scalar transform cases always reach diagnostics', () => {
  for (const source of [
    'x=café; printf "%s" "${x:1}"', 'printf "%s" "${@:1}"', 'printf "%s" "${*//a/b}"',
    'x=abc; printf "%s" "${x:"1"}"', 'x=abc; printf "%s" "${x:1/0}"; echo unexpected',
    'x=abc; printf "%s" "${x:1:9223372036854775807}"',
    'x=abc; p="@(a|b)"; printf "%s" "${x/$p/X}"',
    'x=café; printf "%s" "${x//?/X}"', 'x=abc; printf "%s" "${x/[[.a.]]/X}"',
    'x=abc; printf "%s" "${x/[a-é]/X}"',
  ]) {
    it(source, () => {
      const actual = createTerminal({}).run('{ ' + source + '; } 2>/dev/null | cat')
      assert.equal(actual.stdout, '')
      assert.equal(actual.stderr, '')
      assert.ok(actual.unsupported.length > 0)
    })
  }

  it('bounds excessive wildcard search and replacement output', () => {
    const term = createTerminal({})
    for (const source of [
      `x=${'a'.repeat(600)}; printf '%s' "\${x/*z/X}"`,
      `x=${'a'.repeat(5000)}; r='${'&'.repeat(5000)}'; printf '%s' "\${x/*/$r}"`,
    ]) {
      const actual = term.run(source)
      assert.equal(actual.stdout, '')
      assert.ok(actual.unsupported.some((note) => /work limit/u.test(note.message)))
    }
  })
})
