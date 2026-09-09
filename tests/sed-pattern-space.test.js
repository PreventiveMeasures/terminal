import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU sed execute.c n/N/P and read_pattern_space distinguish input records,
// embedded pattern-space delimiters, and the final record's terminator.
const FILES = {
  input: 'one\ntwo\nthree\nfour\nfive\n', even: 'one\ntwo\nthree\nfour\n',
  single: 'one\n', unterminated: 'tail', empty: '', left: 'a', right: 'c\nd\n',
  pair: 'a\nb\n', pairLast: 'a\nb', zero: 'a\0b\0c\0d', zeroLines: 'a\nx\0b\ny\0',
}
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'"
const sed = (script, input = 'input', flags = '') => `sed ${flags} ${quote(script)} ${input}`

function examples(rows) {
  for (const [name, command, stdout] of rows) {
    it(name, () => {
      assert.deepEqual(createTerminal(FILES).run(command), { stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [] }, command)
    })
  }
}

describe('sed n prints and replaces the current pattern space', () => {
  examples([
    ['n resumes after itself with the next record', sed('n;s/^/>/'), 'one\n>two\nthree\n>four\nfive\n'],
    ['quiet n suppresses automatic printing', sed('n;p', 'input', '-n'), 'two\nfour\n'],
    ['n at EOF ends execution after default printing', sed('n;s/.*/BAD/', 'unterminated'), 'tail'],
    ['quiet n at EOF prints nothing', sed('n;p', 'unterminated', '-n'), ''],
    ['n updates line numbers', sed('n;=', 'even', '-n'), '2\n4\n'],
    ['n updates last-line selection', sed('n;$p', 'even', '-n'), 'four\n'],
    ['n can cross input file boundaries', sed('n;p', 'left right', '-n'), 'c\n'],
    ['separate-file n does not consume the next file', sed('n;p', 'left right', '-sn'), 'd\n'],
    ['n prints a multi-record pattern space before replacement', sed('N;n;p', 'input', '-n'), 'three\n'],
    ['n uses NUL records under -z', sed('n;p', 'zero', '-zn'), 'b\0d'],
    ['n flushes queued append text before reading', "sed -e 'a tail' -e 'n;p' pair", 'a\ntail\nb\nb\n'],
    ['quiet n still flushes queued append text', "sed -n -e 'a tail' -e 'n;p' pair", 'tail\nb\n'],
    ['n at EOF still flushes queued append text', "sed -e 'a tail' -e n unterminated", 'tail\ntail\n'],
  ])
})

describe('sed N appends the next record and P prints only the first part', () => {
  examples([
    ['N joins pairs and default-prints the final odd record', sed(String.raw`N;s/\n/:/`), 'one:two\nthree:four\nfive\n'],
    ['quiet N at EOF skips subsequent commands', sed('N;p', 'input', '-n'), 'one\ntwo\nthree\nfour\n'],
    ['P prints the first record of each joined pair', sed('N;P', 'even', '-n'), 'one\nthree\n'],
    ['P without an embedded delimiter preserves an unterminated record', sed('P', 'unterminated', '-n'), 'tail'],
    ['P terminates the first part of an unterminated pair', sed('N;P', 'pairLast', '-n'), 'a\n'],
    ['N preserves the last appended record terminator', sed('N', 'pairLast'), 'a\nb'],
    ['N at EOF preserves the current unterminated pattern', sed('N', 'unterminated'), 'tail'],
    ['quiet N at EOF does not print the current pattern', sed('N', 'unterminated', '-n'), ''],
    ['N updates line numbers', sed('N;=', 'even', '-n'), '2\n4\n'],
    ['N updates last-line selection', sed('N;$p', 'even', '-n'), 'three\nfour\n'],
    ['a dollar guard can avoid the EOF branch', sed('$!N;p', 'input', '-n'), FILES.input],
    ['N supplies one delimiter across unterminated file boundaries', sed(String.raw`N;s/\n/:/`, 'left right'), 'a:c\nd\n'],
    ['separate-file N preserves the next file for a new cycle', sed(String.raw`N;s/\n/:/`, 'left right', '-s'), 'a\nc:d\n'],
    ['quiet N crosses files before P', sed('N;P', 'left right', '-n'), 'a\n'],
    ['quiet separate-file N starts again in the next file', sed('N;P', 'left right', '-sn'), 'c\n'],
    ['N and q print the joined pattern once', sed('N;q'), 'one\ntwo\n'],
    ['quiet N and q print nothing', sed('N;q', 'input', '-n'), ''],
    ['substitution-created delimiters are visible to P', sed(String.raw`s/one/A\nB/;P`, 'single', '-n'), 'A\n'],
    ['P uses NUL rather than LF under -z', sed('N;P', 'zero', '-zn'), 'a\0c\0'],
    ['P preserves embedded LF inside a NUL record', sed('N;P', 'zeroLines', '-zn'), 'a\nx\0'],
    ['N at EOF uses the final NUL-record terminator', sed('N', 'zero', '-z'), 'a\0b\0c\0d'],
    ['N flushes queued append text before extending pattern space', "sed -e 'a tail' -e N pair", 'tail\na\nb\n'],
    ['quiet N still flushes append text', "sed -n -e 'a tail' -e 'N;p' pair", 'tail\na\nb\n'],
    ['N at EOF flushes append after the default pattern output', "sed -e 'a extra' -e N unterminated", 'tail\nextra\n'],
    ['a backward N loop joins the entire input', sed(String.raw`:join;$!{N;b join;};s/\n/,/g`), 'one,two,three,four,five\n'],
    ['compact branch syntax supports the usual slurp script', sed(String.raw`:a;N;$!ba;s/\n/ /g`), 'one two three four five\n'],
  ])
})

describe('sed input commands preserve range and shared-input state', () => {
  examples([
    ['ranges use the line number after N', sed('N;2,4p', 'even', '-n'), FILES.even],
    ['N keeps shared stdin after an explicit quit', "{ sed -n 'N;q'; cat; } <input", 'three\nfour\nfive\n'],
    ['n keeps shared stdin after an explicit quit', "{ sed -n 'n;q'; cat; } <input", 'three\nfour\nfive\n'],
    ['N keeps pipe input after an explicit quit', "cat input | { sed -n 'N;q'; cat; }", 'three\nfour\nfive\n'],
    ['n keeps pipe input after an explicit quit', "cat input | { sed -n 'n;q'; cat; }", 'three\nfour\nfive\n'],
    ['N preserves empty input without executing P', sed('N;P', 'empty', '-n'), ''],
    ['n preserves empty input without executing p', sed('n;p', 'empty', '-n'), ''],
  ])

  for (const operation of ['n', 'N']) {
    it(`${operation} reports errors encountered while looking for the next record`, () => {
      const r = createTerminal(FILES).run(sed(operation, 'single missing'))
      assert.equal(r.stdout, 'one\n')
      assert.equal(r.exitCode, 2)
      assert.match(r.stderr, /missing/u)
      assert.deepEqual(r.unsupported, [])
    })
  }
})
