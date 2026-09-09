import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createTerminal } from '@preventive/terminal'

const FILES = {
  numbers: 'id=42\nid=007\nID=99\nid=abc\n',
  words: 'foo foo\nfoo bar\nword_word word_word\n',
  tags: '<x>a</x><x>b</x>\n',
  alternatives: 'ab\n',
  calls: 'foo()\nfoobar()\n',
  ascii: 'A\t7\nB 9\nzz\n',
  punctuation: 'a.b\naxb\n#tag\n[]-\n',
  controls: 'A\u0007\u001B\tZ\n',
  endings: 'a\r\na\u2028\na\u2029\na\n',
  literal: 'a{value}\na}b\na]b\n',
}

function check(line, stdout, exitCode = 0, files = FILES) {
  const result = createTerminal(files).run(line)
  assert.equal(result.stdout, stdout, line)
  assert.equal(result.stderr, '', line)
  assert.equal(result.exitCode, exitCode, line)
  assert.deepEqual(result.unsupported, [], line)
}

describe('grep -P supports compatible PCRE expressions', () => {
  for (const [line, stdout, exitCode = 0] of [
    [String.raw`grep -Pn '^id=\d+$' numbers`, '1:id=42\n2:id=007\n'],
    [String.raw`grep -Poin '^id=\d+$' numbers`, '1:id=42\n2:id=007\n3:ID=99\n'],
    [String.raw`grep -Po '\d+' numbers`, '42\n007\n99\n'],
    [String.raw`grep -Po '(?<=id=)\d+' numbers`, '42\n007\n'],
    [String.raw`grep -Po '\d+(?=$)' numbers`, '42\n007\n99\n'],
    [String.raw`grep -Po '(?<!\d)\d{2}(?!\d)' numbers`, '42\n99\n'],
    [String.raw`grep -P '(?:foo|bar)\(' calls`, 'foo()\nfoobar()\n'],
    [String.raw`grep -Po 'foo(?=\()' calls`, 'foo\n'],
    [String.raw`grep -P 'foo(?!bar)' calls`, 'foo()\n'],
    [String.raw`grep -Po '<x>.*?</x>' tags`, '<x>a</x>\n<x>b</x>\n'],
    [String.raw`grep -Po '<x>.*</x>' tags`, '<x>a</x><x>b</x>\n'],
    [String.raw`grep -Po 'a|ab' alternatives`, 'a\n'],
    [String.raw`grep -Pxo 'a|ab' alternatives`, 'ab\n'],
    [String.raw`grep -Px '(\w+)\s+\1' words`, 'foo foo\nword_word word_word\n'],
    [String.raw`grep -Pxo '(?<word>\w+)\s+\k<word>' words`, 'foo foo\nword_word word_word\n'],
    [String.raw`grep -Po '(a)(b)\2\1' text`, 'abba\n'],
    [String.raw`grep -Po '\bfoo\b' words`, 'foo\nfoo\nfoo\n'],
    [String.raw`grep -Po '\w+\s\d' ascii`, 'A\t7\nB 9\n'],
    [String.raw`grep -Po '\D+' numbers`, 'id=\nid=\nID=\nid=abc\n'],
    [String.raw`grep -Po '\S+' ascii`, 'A\n7\nB\n9\nzz\n'],
    [String.raw`grep -Po '\W+' numbers`, '=\n=\n=\n=\n'],
    [String.raw`grep -P '\Aa\z' endings`, 'a\n'],
    [String.raw`grep -P '^a$' endings`, 'a\n'],
    [String.raw`grep -P '\Aa\Z' endings`, 'a\n'],
    [String.raw`grep -P '\Qa.b\E' punctuation`, 'a.b\n'],
    [String.raw`grep -P '\Qa.b' punctuation`, 'a.b\n'],
    [String.raw`grep -P 'a\E.b' punctuation`, 'a.b\naxb\n'],
    [String.raw`grep -P '\#tag' punctuation`, '#tag\n'],
    [String.raw`grep -Po '[][-]+' punctuation`, '[]-\n'],
    [String.raw`grep -Po '[\x41-\x42]' ascii`, 'A\nB\n'],
    [String.raw`grep -Po '\x{41}|[\102]' ascii`, 'A\nB\n'],
    [String.raw`grep -P '\x41\a\e\tZ' controls`, 'A\u0007\u001B\tZ\n'],
    [String.raw`grep -P 'a{value}' literal`, 'a{value}\n'],
    [String.raw`grep -P 'a}b|a]b' literal`, 'a}b\na]b\n'],
    [String.raw`grep -Pc '\d+' numbers`, '3\n'],
    [String.raw`grep -Pvc '\d+' numbers`, '1\n'],
    [String.raw`grep -Pm1 '\d+' numbers`, 'id=42\n'],
    [String.raw`grep -Pq '\d+' numbers`, ''],
    [String.raw`grep -Pq 'missing' numbers`, '', 1],
    [String.raw`grep -P 'a*' alternatives`, 'ab\n'],
  ]) {
    it(line, () => check(line, stdout, exitCode, { ...FILES, text: 'xabbaa\n' }))
  }

  it('preserves escaped astral literals', () => {
    check(String.raw`grep -P '\😀' text`, '😀\n', 0, { text: '😀\nx\n' })
  })

  it('works in a source-tree pipeline', () => {
    check(String.raw`grep -rPn '(?<=id=)\d+' src --include=*.js | head -1`, 'src/a.js:1:id=42\n', 0,
      { 'src/a.js': 'id=42\n', 'src/b.txt': 'id=9\n' })
  })
})

describe('grep -P diagnoses PCRE features with different semantics', () => {
  for (const [pattern, detail] of [
    ['(?i)foo', 'PCRE group'],
    ['(?i:foo)', 'PCRE group'],
    ['(?>foo)', 'PCRE group'],
    ['(?|a|b)', 'PCRE group'],
    ['(?(1)a|b)', 'PCRE group'],
    ['(?#comment)a', 'PCRE group'],
    ['(?R)', 'PCRE group'],
    ['(*SKIP)a', 'PCRE control verb'],
    ['a++', 'PCRE possessive repetition'],
    ['a*+', 'PCRE possessive repetition'],
    ['a{2}+', 'PCRE possessive repetition'],
    ['a{,2}', 'PCRE repetition'],
    ['a{ 2 }', 'PCRE repetition'],
    ['(?<=a+)b', 'PCRE variable-length lookbehind'],
    ['(?<=a{1,2})b', 'PCRE variable-length lookbehind'],
    [String.raw`\Kfoo`, 'PCRE escape \\K'],
    [String.raw`\R`, 'PCRE escape \\R'],
    [String.raw`\h`, 'PCRE escape \\h'],
    [String.raw`\v`, 'PCRE escape \\v'],
    [String.raw`\p{L}`, 'PCRE escape \\p'],
    [String.raw`\Gfoo`, 'PCRE escape \\G'],
    [String.raw`[[:alpha:]]`, 'PCRE character class'],
    [String.raw`\1(a)`, 'PCRE forward or ambiguous backreference'],
    [String.raw`\102`, 'PCRE forward or ambiguous backreference'],
    [String.raw`(\1a)`, 'PCRE forward or ambiguous backreference'],
    [String.raw`(a)?\1b`, 'PCRE conditional backreference'],
    [String.raw`(a)|(b)\1`, 'PCRE conditional backreference'],
    [String.raw`(?<word>a)?\k<word>`, 'PCRE conditional backreference'],
    [String.raw`(?!(a))b\1`, 'PCRE conditional backreference'],
    [String.raw`(?<=([ab]){2})c\1`, 'PCRE conditional backreference'],
  ]) {
    it(pattern, () => {
      const line = `grep -P '${pattern}' text`
      const files = { text: 'foo abcb abca b\n' }
      const direct = createTerminal(files).run(line)
      assert.equal(direct.exitCode, 2)
      assert.notEqual(direct.stderr, '')
      assert.deepEqual(direct.unsupported.map((entry) => entry.detail), [detail])
      const hidden = createTerminal(files).run(`${line} 2>/dev/null | cat`)
      assert.equal(hidden.stderr, '')
      assert.equal(hidden.exitCode, 0)
      assert.deepEqual(hidden.unsupported, direct.unsupported)
    })
  }

  it('does not silently skip a nonempty alternative after an empty PCRE match', () => {
    const result = createTerminal({ text: 'a\n' }).run("grep -Po '(?=a)|a' text 2>/dev/null | cat")
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.unsupported.map((entry) => entry.detail), ['PCRE empty match extent'])
  })

  for (const [pattern, content] of [[String.raw`\s`, '\uFEFF\n'], [String.raw`\D`, 'é\n'], [String.raw`\w`, 'é\n']]) {
    it(`retains Unicode semantic diagnostics for ${pattern}`, () => {
      const result = createTerminal({ text: content }).run(`LC_ALL=C grep -Po '${pattern}' text 2>/dev/null | cat`)
      assert.deepEqual(result.unsupported.map((entry) => entry.detail), ['non-ASCII regex semantics'])
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
    })
  }
})

describe('grep -P ordinary syntax errors stay off the unsupported channel', () => {
  for (const line of [
    "grep -P '[' numbers",
    "grep -P '(' numbers",
    "grep -P 'a{3,2}' numbers",
    "grep -P 'a{65536}' numbers",
    "grep -PE 'a' numbers",
    "grep -PF 'a' numbers",
    "grep -P -e a -e b numbers",
  ]) {
    it(line, () => {
      const result = createTerminal(FILES).run(line)
      assert.equal(result.exitCode, 2)
      assert.notEqual(result.stderr, '')
      assert.deepEqual(result.unsupported, [])
    })
  }
})
