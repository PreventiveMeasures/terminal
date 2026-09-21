import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// `wc -w` is coreutils' own loop rather than a list of blanks: past the six
// blanks ASCII spells, only a printable character is looked at at all. One
// glibc calls a space parts a word, and so do the four non-breaking spaces wc
// adds to them itself (its `iswnbspace`); any other printable character is a
// word's own; and everything else — a control, an unassigned code point, a
// byte that spells no character — passes through without beginning a word or
// ending one.
// Every count here was recorded from GNU coreutils 9.4 in C.UTF-8 over the
// same bytes written to disk, alongside the lines and bytes of each.
const bytes = (...values) => new Uint8Array(values)

// [what the file holds, words, lines, bytes]
const CASES = [
  ['a b\tc\nd\u000Be\ff\rg\n', 7, 2, 14, 'every blank ASCII spells parts a word'],
  ['\u0001\n', 0, 1, 2, 'a control alone is no word'],
  ['a\u0001b\n', 1, 1, 4, 'a control inside a word neither ends it nor begins one'],
  ['\u0001 \u0002\n', 0, 1, 4, 'controls between blanks are still no word'],
  ['a\u007F\u0085b\n', 1, 1, 6, 'DEL and the C1 controls pass through the same way'],
  ['a b\n', 2, 1, 5, 'a no-break space parts a word, which glibc does not call a space'],
  ['a b\n', 2, 1, 6, 'a figure space parts a word'],
  ['a b\n', 2, 1, 6, 'a narrow no-break space parts a word'],
  ['a⁠b\n', 2, 1, 6, 'a word joiner parts a word'],
  ['a b\n', 1, 1, 6, 'a line separator joins, being a space glibc does not call printable'],
  ['a b\n', 1, 1, 6, 'a paragraph separator joins for the same reason'],
  ['a﻿b\n', 1, 1, 6, 'a byte-order mark is a printable character of the word'],
  ['a​b\n', 1, 1, 6, 'a zero-width space is one too'],
  ['a᠎b\n', 1, 1, 6, 'and so is a Mongolian vowel separator'],
  ['a b\n', 2, 1, 6, 'an ogham space mark parts a word'],
  ['a b a b\n', 4, 1, 12, 'every space from the en quad to the hair space parts one'],
  ['a b\n', 2, 1, 6, 'a medium mathematical space parts a word'],
  ['a　b\n', 2, 1, 6, 'an ideographic space parts a word'],
  ['a⻿ b\n', 2, 1, 7, 'an unassigned code point joins what is beside it'],
  ['⻿\n', 0, 1, 4, 'an unassigned code point alone is no word'],
  [' ⁠\n', 0, 1, 6, 'a line of nothing but separators holds no word'],
  ['café ☃ \u{1F600}\n', 3, 1, 15, 'accents, symbols and astral characters are words'],
  ['  \n\n  \n', 0, 3, 7, 'blank lines hold no words'],
  ['', 0, 0, 0, 'an empty file holds nothing'],
  ['no trailing newline', 3, 0, 19, 'a last line without a terminator is still words'],
  ['\uD800', 1, 0, 3, 'a lone surrogate is the replacement character its bytes are'],
  ['�\n', 1, 1, 4, 'and a replacement character of its own is a word'],
  [bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0xfe, 0x0a), 2, 3, 19, 'a PNG header holds two words'],
  [bytes(0x63, 0x61, 0x66, 0xe9, 0x20, 0x6c, 0x61, 0x74, 0x74, 0x65, 0x0a, 0x6d, 0x6f, 0x72, 0x65, 0x0a), 3, 2, 16, 'latin-1 text holds three'],
  [bytes(0xff, 0x0a), 0, 1, 2, 'a byte that spells no character is no word'],
  [bytes(0x61, 0xff, 0x62, 0x0a), 1, 1, 4, 'one inside a word neither ends it nor begins one'],
  [bytes(0x61, 0x20, 0xff, 0x20, 0x62, 0x0a), 2, 1, 6, 'one between blanks is no word of its own'],
  [bytes(0x61, 0x62, 0xe2, 0x81), 1, 0, 4, 'a sequence cut short at the end spells no character either'],
  [bytes(0xc0, 0x80, 0x0a), 0, 1, 3, 'nor does an overlong form'],
  [bytes(0xed, 0xa0, 0x80, 0x0a), 0, 1, 4, 'nor a surrogate half spelled in bytes'],
  [bytes(0x61, 0x00, 0x62, 0x0a), 1, 1, 4, 'a NUL is a character no word is made of'],
  [bytes(0x61, 0x20, 0x00, 0x20, 0x62, 0x0a), 2, 1, 6, 'and one between blanks is no word'],
]

describe('wc counts words as coreutils counts them', () => {
  for (const [content, words, lines, size, what] of CASES) {
    it(what, () => {
      const terminal = createTerminal({ f: content })
      assert.equal(terminal.run('wc -w f').stdout, `${words} f\n`)
      assert.equal(terminal.run('wc -l f').stdout, `${lines} f\n`)
      assert.equal(terminal.run('wc -c f').stdout, `${size} f\n`)
    })
  }

  it('reads a pipe and a redirection by the same rule', () => {
    const terminal = createTerminal({ blanks: 'a b c⁠d\n' })
    // One line holding all three rules: the no-break space and the word
    // joiner part, and the line separator joins.
    assert.equal(terminal.run('wc -w blanks').stdout, '3 blanks\n')
    assert.equal(terminal.run('wc -w < blanks').stdout, '3\n')
    assert.equal(terminal.run('cat blanks | wc -w').stdout, '3\n')
    assert.equal(terminal.run('printf "a\\u00A0b" | wc -w').stdout, '2\n')
  })

  it('totals and aligns several operands', () => {
    const terminal = createTerminal({ blanks: 'a b c⁠d\n', astral: 'café ☃ \u{1F600}\n', short: 'x\n' })
    assert.equal(terminal.run('wc -w blanks astral short').stdout, ' 3 blanks\n 3 astral\n 1 short\n 7 total\n')
    assert.equal(terminal.run('wc blanks astral').stdout, ' 1  3 13 blanks\n 1  3 15 astral\n 2  6 28 total\n')
    assert.equal(terminal.run('wc -lw blanks astral').stdout, ' 1  3 blanks\n 1  3 astral\n 2  6 total\n')
  })

  it('counts characters where the bytes spell them', () => {
    const terminal = createTerminal({ astral: 'café ☃ \u{1F600}\n', blanks: 'a b c⁠d\n' })
    // An astral character is one character and four bytes, which is where
    // `-m` and `-c` part company.
    assert.equal(terminal.run('wc -m astral').stdout, '9 astral\n')
    assert.equal(terminal.run('wc -mc astral').stdout, ' 9 15 astral\n')
    assert.equal(terminal.run('wc -m blanks').stdout, '8 blanks\n')
  })
})
