import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU sed read_text/normalize_text: controls and numeric escapes produce
// bytes; unknown escapes lose the slash. Expectations are source-derived.
// https://github.com/mirror/sed/blob/0c1fe22ccacf4887e0be6c11deb4e9c83acc287d/sed/compile.c
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'"
const expected = (stdout, exitCode = 0, stderr = '', unsupported = []) => ({ stdout, stderr, exitCode, cwd: '/', unsupported })

describe('sed text commands normalize escapes as GNU text buffers', () => {
  const cases = [
    [String.raw`\a\f\n\r\t\v`, '\u0007\f\n\r\t\v\n'],
    [String.raw`\b\e\E\u0041\U00000041\1\&\q`, 'beEu0041U000000411&q\n'],
    [String.raw`\\`, '\\\n'],
    [String.raw`\cA\ca\c@\c[\c\\\c]\c^\c_\c?`, '\u0001\u0001\0\u001B\u001C\u001D\u001E\u001F\u007F\n'],
    [String.raw`\d065\x42\o103`, 'ABC\n'],
    [String.raw`\d256\o400\x00`, '\0\0\0\n'],
    [String.raw`\d322|\o501|\x414|\d0667|\o1023`, 'B|A|A4|B7|B3\n'],
    [String.raw`\x|\o8|\d-1`, 'x|o8|d-1\n'],
    [String.raw`\xc3\xa9|\d195\o251|\xf0\x9f\x98\x80`, 'é|é|😀\n'],
    [String.raw`\é\😀`, 'é😀\n'],
    ['first\\\nsecond', 'first\nsecond\n'],
    ['text\0after', 'text\0after\n'],
  ]
  for (const [text, stdout] of cases) {
    for (const kind of ['a', 'i', 'c']) {
      it(`${kind} ${JSON.stringify(text)}`, () => {
        const command = `sed -n ${quote(kind + '\\\n' + text)} input`
        assert.deepEqual(createTerminal({ input: 'line\n' }).run(command), expected(stdout))
      })
    }
  }
  it('a leading short-form backslash introduces text instead of an escape', () => {
    assert.deepEqual(createTerminal({ input: 'line\n' }).run(`sed -n ${quote(String.raw`a \n\t`)} input`), expected('n\t\n'))
  })
})

describe('sed text controls at the final compiler newline', () => {
  for (const kind of ['a', 'i', 'c']) {
    for (const nul of [false, true]) {
      it(`${kind} consumes its final control operand under ${nul ? '-z' : 'line'} mode`, () => {
        const command = `sed -n ${nul ? '-z ' : ''}${quote(kind + String.raw` tail\c`)} input`
        const stdout = kind === 'a' ? 'tailJ' : 'tail' + (nul ? '\0' : '\n')
        assert.deepEqual(createTerminal({ input: 'line\n' }).run(command), expected(stdout))
      })
    }
  }
  it('raw append output without LF does not separate the next input record', () => {
    assert.deepEqual(createTerminal({ input: 'first\nsecond\n' }).run(`sed ${quote(String.raw`1a tail\c`)} input`), expected('first\ntailJsecond\n'))
  })
})

describe('sed text errors and unsupported byte output preserve diagnostics', () => {
  for (const text of [String.raw`\x80`, String.raw`\xff`, String.raw`\d999`, String.raw`\cé`, String.raw`\xc3x`]) {
    it(`refuses text that cannot be represented losslessly: ${text}`, () => {
      const command = `sed ${quote('a\\\n' + text)} input`
      const message = 'sed: byte output that is not valid UTF-8 cannot be represented by this string-based terminal'
      const unsupported = [{ kind: 'feature', command: 'sed', detail: 'partial UTF-8 byte sequence', message }]
      const terminal = createTerminal({ input: 'line\n' })
      assert.deepEqual(terminal.run(command), expected('', 1, message + '\n', unsupported))
      assert.deepEqual(terminal.run(command + ' 2>/dev/null | cat'), expected('', 0, '', unsupported))
    })
  }
  for (const text of [String.raw`\c\x`, String.raw`\c\n`, '\\c\\']) {
    it(`invalid recursive control escaping is an ordinary syntax error: ${text}`, () => {
      // A physical LF follows the last case so the command text is complete.
      const command = `sed ${quote('a\\\n' + text + '\n')} input`
      assert.deepEqual(createTerminal({ input: 'line\n' }).run(command), expected('', 1, 'sed: recursive escaping after \\c not allowed\n'))
    })
  }
  for (const script of ['a\\', 'i text\\', 'c text\\']) {
    it(`reports a text continuation across expressions: ${script}`, () => {
      const command = `sed -e ${quote(script)} -e 'next line' input`
      const message = 'sed: text continued across script expressions is not supported'
      const unsupported = [{ kind: 'feature', command: 'sed', detail: 'continued text between expressions', message }]
      const terminal = createTerminal({ input: 'line\n' })
      assert.deepEqual(terminal.run(command), expected('', 1, message + '\n', unsupported))
      assert.deepEqual(terminal.run(command + ' 2>/dev/null | cat'), expected('', 0, '', unsupported))
    })
  }
})
