import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createTerminal } from '@preventive/terminal'

const FILES = { 'src/a.js': 'alpha\n', 'src/b.js': 'beta\n', 'two words': 'spaced\n' }

function check(line, stdout) {
  const result = createTerminal(FILES).run(line)
  assert.equal(result.stdout, stdout, line)
  assert.equal(result.stderr, '', line)
  assert.equal(result.exitCode, 0, line)
  assert.deepEqual(result.unsupported, [], line)
}

describe('printf format and argument handling', () => {
  for (const [line, stdout] of [
    ["printf 'hello'", 'hello'],
    ["printf ''", ''],
    ["printf '' ignored arguments", ''],
    ["printf 'literal' ignored arguments", 'literal'],
    ["printf '%%'", '%'],
    ["printf '%%:%s:%%' first second", '%:first:%%:second:%'],
    [String.raw`printf '%s\n' one 'two words' ''`, 'one\ntwo words\n\n'],
    ["printf '[%s:%d]' a 1 b 2 c", '[a:1][b:2][c:0]'],
    ["printf '%s:%b:%d:%u:%f'", '::0:0:0.000000'],
    ["printf '%s' -- '-n' '-e' '100%'", '---n-e100%'],
    ["printf -- '---%s---' hi", '---hi---'],
    [String.raw`printf '%s' 'a\nb\t%%'`, String.raw`a\nb\t%%`],
    [String.raw`printf '%s\n' src/*.js`, 'src/a.js\nsrc/b.js\n'],
  ]) {
    it(line, () => check(line, stdout))
  }
})

describe('printf string and character fields', () => {
  for (const [line, stdout] of [
    ["printf '[%5s][%-5s]' ab ab", '[   ab][ab   ]'],
    ["printf '[%.3s][%6.3s][%-6.3s]' abcdef abcdef abcdef", '[abc][   abc][abc   ]'],
    ["printf '[%.s][%3.0s]' value value", '[][   ]'],
    ["printf '[%*.*s]' 6 3 abcdef", '[   abc]'],
    ["printf '[%*.*s]' -6 3 abcdef", '[abc   ]'],
    ["printf '[%.*s]' -1 abcdef", '[abcdef]'],
    ["printf '[%*s]' 3", '[   ]'],
    ["printf '[%*s]' 3 a 4 b", '[  a][   b]'],
    ["printf '[%*s]' 010 x", '[       x]'],
    ["printf '[%.-3s]' abc", '[abc]'],
    ["printf '[%4s][%.2s][%.4s]' é élan 😀x", '[  é][é][😀]'],
    ["printf '%c%c%c' abc 65 Z", 'a6Z'],
    ["printf '[%3c][%-3c]' abc def", '[  a][d  ]'],
    ["printf '<%c><%c>' ''", '<\0><\0>'],
  ]) {
    it(line, () => check(line, stdout))
  }
})

describe('printf backslash escapes', () => {
  for (const [line, stdout] of [
    [String.raw`printf 'a\nb\tc\r\f\v\b\a\\'`, 'a\nb\tc\r\f\v\b\u0007\\'],
    [String.raw`printf '\101\x42\u0043\U00000044'`, 'ABCD'],
    [String.raw`printf '\045s:\x25d' ignored`, '%s:%d'],
    [String.raw`printf 'a\cb'`, String.raw`a\cb`],
    [String.raw`printf "\\'\\\"\\?"`, '\'"?'],
    [String.raw`printf '%b' "\\'\\\"\\?"`, String.raw`\'\"\?`],
    [String.raw`printf '\0123'`, '\n3'],
    [String.raw`printf '%b' '\0101\0102'`, 'AB'],
    [String.raw`printf '%b' 'a\nb\tc\\d'`, 'a\nb\tc\\d'],
    [String.raw`printf '\x1b[31mred\033[0m'`, '\u001B[31mred\u001B[0m'],
    [String.raw`printf '\303\251'`, 'é'],
    [String.raw`printf '%b' '\0303\0251'`, 'é'],
    [String.raw`printf '\xc3%b' '\xa9'`, 'é'],
    [String.raw`printf '%b' '\xc3' '\xa9'`, 'é'],
    [String.raw`printf '\u03bb\U0001f600'`, 'λ😀'],
    [String.raw`printf 'a\0b'`, 'a\0b'],
    [String.raw`printf '%s\0' one two`, 'one\0two\0'],
    [String.raw`printf '[%5.2b]' 'A\nB'`, '[   A\n]'],
    [String.raw`printf '[%-5.2b]' 'A\nB'`, '[A\n   ]'],
    [String.raw`printf '%b' 'before\cafter' ignored`, 'before'],
    [String.raw`printf 'head:%b:tail\n' 'before\cafter' ignored`, 'head:before'],
    [String.raw`printf '%b%q' 'before\cafter' ignored`, 'before'],
  ]) {
    it(line, () => check(line, stdout))
  }
})

describe('printf integer conversions', () => {
  for (const [line, stdout] of [
    ["printf '%d %i %u %o %x %X' 17 -17 17 17 17 17", '17 -17 17 21 11 11'],
    ["printf '%d ' 010 0x10 +12 -010 -0x10", '8 16 12 -8 -16 '],
    ["printf '%d %d' \"'A\" '\"Z'", '65 90'],
    ["printf '%d' '  +42'", '42'],
    ["printf '%d' 9007199254740993", '9007199254740993'],
    ["printf '%d %d' 9223372036854775807 -9223372036854775808", '9223372036854775807 -9223372036854775808'],
    ["printf '%u %x' 18446744073709551615 18446744073709551615", '18446744073709551615 ffffffffffffffff'],
    ["printf '%u %x %o' -1 -1 -1", '18446744073709551615 ffffffffffffffff 1777777777777777777777'],
    ["printf '[%+d][% d][%+ d]' 2 2 2", '[+2][ 2][+2]'],
    ["printf '[%06d][%+06d][%-06d]' -12 12 12", '[-00012][+00012][12    ]'],
    ["printf '[%8.4d][%08.4d]' -12 12", '[   -0012][    0012]'],
    ["printf '[%#o][%#x][%#X]' 8 26 26", '[010][0x1a][0X1A]'],
    ["printf '[%#06x][%#06o]' 26 8", '[0x001a][000010]'],
    ["printf '[%.0d][%.0u][%.0x][%.0o][%#.0o]' 0 0 0 0 0", '[][][][][0]'],
    ["printf '[%#.0x][%#.0X]' 0 0", '[][]'],
    ["printf '[%*.*d]' 7 4 12", '[   0012]'],
    ["printf '[%.*d]' -1 12", '[12]'],
    ["printf '[%.-3d]' 12", '[12]'],
  ]) {
    it(line, () => check(line, stdout))
  }
})

describe('printf floating-point conversions', () => {
  for (const [line, stdout] of [
    ["printf '%f %F' 1.5 -2.5", '1.500000 -2.500000'],
    ["printf '%.2f %.2e %.2E' 1.5 125 125", '1.50 1.25e+02 1.25E+02'],
    ["printf '%.4g %.4G' 12500 12500", '1.25e+04 1.25E+04'],
    ["printf '%.4g %.4g' 12.5 0.000125", '12.5 0.000125'],
    ["printf '[%#.0f][%#.4g][%#.0e]' 2 12.5 2", '[2.][12.50][2.e+00]'],
    ["printf '[%+08.2f][%-8.2f]' 1.5 1.5", '[+0001.50][1.50    ]'],
    ["printf '[%*.*f]' 8 2 1.5", '[    1.50]'],
    ["printf '%g %g %f' 1e3 -1e-3 -0", '1000 -0.001 -0.000000'],
    ["printf '%.0f %.0f %.0f' 2.5 3.5 -2.5", '2 4 -2'],
  ]) {
    it(line, () => check(line, stdout))
  }
})

describe('printf in shell workflows', () => {
  it('is discoverable as a command', () => {
    const terminal = createTerminal(FILES)
    assert.deepEqual(terminal.complete('pri'), ['printf'])
    assert.equal(terminal.run('which printf').stdout, '/usr/bin/printf\n')
    assert.match(terminal.run('unknown').stderr, /\bprintf\b/u)
  })

  for (const [line, stdout] of [
    [String.raw`printf '%s\n' beta alpha | sort`, 'alpha\nbeta\n'],
    [String.raw`printf '%s\0' 'two words' src/a.js | xargs -0 cat`, 'spaced\nalpha\n'],
    ["printf '%s' input | { printf '%s' prefix; cat; }", 'prefixinput'],
    [String.raw`find src -type f -exec printf '[%s]\n' {} \;`, '[src/a.js]\n[src/b.js]\n'],
    [String.raw`printf '%s\n' src/a.js src/b.js | xargs -n1 printf '<%s>\n'`, '<src/a.js>\n<src/b.js>\n'],
    ["/usr/bin/printf '%s' yes", 'yes'],
    [String.raw`for file in src/*.js; do printf '%s\n' "$file"; done`, 'src/a.js\nsrc/b.js\n'],
  ]) {
    it(line, () => check(line, stdout))
  }

  it('can write only to stderr', () => {
    const result = createTerminal(FILES).run(String.raw`printf '%s\n' diagnostic >&2`)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'diagnostic\n')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.unsupported, [])
  })
})

describe('printf ordinary failures preserve numeric prefix conversions', () => {
  for (const [line, stdout] of [
    ["printf '[%d]' nope", '[0]'],
    ["printf '[%d][%d]' 12oops 7", '[12][7]'],
    ["printf '[%d]' 09", '[0]'],
    ["printf '[%d]' 12.5", '[12]'],
    ["printf '[%.1f][%d]' 1.5oops 7", '[1.5][7]'],
  ]) {
    it(line, () => {
      const result = createTerminal(FILES).run(line)
      assert.equal(result.stdout, stdout)
      assert.notEqual(result.exitCode, 0)
      assert.match(result.stderr, /printf:/u)
      assert.deepEqual(result.unsupported, [])
    })
  }

  it('requires a format operand', () => {
    const result = createTerminal(FILES).run('printf')
    assert.equal(result.stdout, '')
    assert.notEqual(result.exitCode, 0)
    assert.match(result.stderr, /printf/u)
    assert.deepEqual(result.unsupported, [])
  })

  it('retains literal output before an invalid format', () => {
    const result = createTerminal(FILES).run("printf 'before%y' value")
    assert.equal(result.stdout, 'before')
    assert.notEqual(result.exitCode, 0)
    assert.match(result.stderr, /invalid format/u)
    assert.deepEqual(result.unsupported, [])
  })
})

describe('printf unsupported diagnostics', () => {
  for (const line of [
    "printf -v target '%s' value",
    "printf '%q' 'a b'",
    "printf '%a' 1.5",
    "printf '%A' 1.5",
    "printf '%2$s' a b",
    "printf '%n' target",
    "printf '%(Y)T' 0",
    "printf '%lc' é",
    "printf '%ls' é",
    "printf '%1000001s' a",
    "printf '%.1000001s' a",
    "printf '%*s' 1000001 a",
    "printf '%.*s' -2147483649 a",
    "printf '%5%'",
    "printf '%p' value",
    "printf '%c' é",
    "printf '%.1s' é",
    String.raw`printf '\xff'`,
    String.raw`printf '%b' '\xff'`,
    String.raw`printf '%.1b' '\xc3\xa9'`,
  ]) {
    it(`${line} survives stderr redirection and a successful pipeline`, () => {
      const plain = createTerminal(FILES).run(line)
      assert.notEqual(plain.exitCode, 0)
      assert.notEqual(plain.stderr, '')
      assert.equal(plain.unsupported.length, 1)
      assert.equal(plain.unsupported[0].command, 'printf')
      const hidden = createTerminal(FILES).run(`${line} 2>/dev/null | cat`)
      assert.equal(hidden.stderr, '')
      assert.equal(hidden.exitCode, 0)
      assert.deepEqual(hidden.unsupported, plain.unsupported)
    })
  }

  it('retains an unsupported format when preceding bytes cannot be represented', () => {
    const line = String.raw`printf '\xff%q' value`
    const result = createTerminal(FILES).run(line)
    assert.notEqual(result.exitCode, 0)
    assert.deepEqual(result.unsupported.map((entry) => entry.detail).sort(), ['%q', 'partial UTF-8 byte sequence'])
    assert.ok(result.unsupported.every((entry) => entry.command === 'printf'))
    const hidden = createTerminal(FILES).run(`${line} 2>/dev/null | cat`)
    assert.equal(hidden.stderr, '')
    assert.equal(hidden.exitCode, 0)
    assert.deepEqual(hidden.unsupported, result.unsupported)
  })
})
