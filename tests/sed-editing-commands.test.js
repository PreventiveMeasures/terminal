import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Independently expressed regressions from GNU sed's command and cycle rules:
// https://github.com/mirror/sed/blob/0c1fe22ccacf4887e0be6c11deb4e9c83acc287d/sed/execute.c
// https://github.com/mirror/sed/blob/0c1fe22ccacf4887e0be6c11deb4e9c83acc287d/sed/compile.c
// No native sed process supplies expected results.
const FILES = {
  input: 'one\ntwo\nthree\nfour\n',
  single: 'item\n', unterminated: 'item', empty: '',
  ranges: 'start\nmiddle\nend\noutside\nstart\nend\n',
  open: 'outside\nstart\nmiddle\n',
  left: 'before\nstart\nmiddle\n', right: 'tail\nend\nafter\n',
  restart: 'start\nend\nafter\n',
  sameEnd: 'start end\nlater\n',
  zero: 'first\0second\0', zeroEmpty: '\0x\0', zeroLast: 'item',
  'scripts/append': '1a from-file\n',
  'scripts/insert': 'i\\\nfrom-file\n',
  'scripts/change': '2,3c\\\nfrom-file\n',
  'scripts/mixed': 'i before\ns/item/changed/\na after\n',
}

const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'"
const sed = (script, input = 'input', flags = '') => `sed ${flags} ${quote(script)} ${input}`

function examples(rows) {
  for (const [name, command, stdout] of rows) {
    it(name, () => {
      assert.deepEqual(createTerminal(FILES).run(command), {
        stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [],
      }, command)
    })
  }
}

describe('sed delete ends the current cycle', () => {
  examples([
    ['delete every line', sed('d'), ''],
    ['delete a numeric range', sed('2,3d'), 'one\nfour\n'],
    ['delete a regex range', sed('/start/,/end/d', 'ranges'), 'outside\n'],
    ['delete the last line', sed('$d'), 'one\ntwo\nthree\n'],
    ['delete stops later print commands', sed('2d;p', 'input', '-n'), 'one\nthree\nfour\n'],
    ['delete stops later substitutions', sed('2d;s/^/kept:/'), 'kept:one\nkept:three\nkept:four\n'],
    ['delete preserves earlier explicit print output', sed('p;d', 'input', '-n'), FILES.input],
    ['delete does not stop subsequent input records', sed('1d'), 'two\nthree\nfour\n'],
    ['delete accepts empty input', sed('d', 'empty'), ''],
    ['delete an unterminated line', sed('d', 'unterminated'), ''],
  ])
})

describe('sed append is deferred and insert is immediate', () => {
  examples([
    ['append follows automatic output', sed('2a appended'), 'one\ntwo\nappended\nthree\nfour\n'],
    ['append still emits with automatic printing disabled', sed('2a appended', 'input', '-n'), 'appended\n'],
    ['append runs for each line in an addressed range', sed('2,3a appended'), 'one\ntwo\nappended\nthree\nappended\nfour\n'],
    ['queued append survives a later delete', "sed -e 'a tail' -e d single", 'tail\n'],
    ['delete prevents a later append from being queued', "sed -e d -e 'a tail' single", ''],
    ['multiple append commands keep FIFO order', "sed -e 'a first' -e 'a second' single", 'item\nfirst\nsecond\n'],
    ['append follows explicit print and automatic print', "sed -e 'a tail' -e p single", 'item\nitem\ntail\n'],
    ['append follows earlier print even when delete suppresses auto-print', "sed -e p -e 'a tail' -e d single", 'item\ntail\n'],
    ['append text is separate from subsequent pattern-space substitutions', "sed -e 'a item' -e 's/item/changed/' single", 'changed\nitem\n'],
    ['insert precedes automatic output', sed('2i inserted'), 'one\ninserted\ntwo\nthree\nfour\n'],
    ['insert still emits with automatic printing disabled', sed('2i inserted', 'input', '-n'), 'inserted\n'],
    ['insert runs for each selected line', sed('2,3i inserted'), 'one\ninserted\ntwo\ninserted\nthree\nfour\n'],
    ['insert remains visible before delete', "sed -e 'i head' -e d single", 'head\n'],
    ['insert prints before previously queued append', "sed -e 'a tail' -e 'i head' single", 'head\nitem\ntail\n'],
    ['insert preserves its position after an explicit print', "sed -n -e p -e 'i middle' -e p single", 'item\nmiddle\nitem\n'],
    ['queued append flushes once after the final input line', sed('$a final', 'input'), FILES.input + 'final\n'],
    ['append does not run without an input cycle', sed('a absent', 'empty'), ''],
    ['insert does not run without an input cycle', sed('i absent', 'empty'), ''],
  ])
})

describe('sed change replaces completed ranges once', () => {
  examples([
    ['change every selected individual line', sed('c changed'), 'changed\nchanged\nchanged\nchanged\n'],
    ['change a single numbered line', sed('2c changed'), 'one\nchanged\nthree\nfour\n'],
    ['change a numeric range once', sed('2,3c changed'), 'one\nchanged\nfour\n'],
    ['change still emits when automatic printing is disabled', sed('2,3c changed', 'input', '-n'), 'changed\n'],
    ['change a relative range once', sed('2,+1c changed'), 'one\nchanged\nfour\n'],
    ['zero relative offset changes one line', sed('2,+0c changed'), 'one\nchanged\nthree\nfour\n'],
    ['descending numeric endpoints still change the start line', sed('3,1c changed'), 'one\ntwo\nchanged\nfour\n'],
    ['change a range through the last input line', sed('2,$c changed'), 'one\nchanged\n'],
    ['change each completed regex range once', sed('/start/,/end/c changed', 'ranges'), 'changed\noutside\nchanged\n'],
    ['a missing numeric endpoint produces no replacement at EOF', sed('2,20c absent'), 'one\n'],
    ['a missing regex endpoint produces no replacement at EOF', sed('/start/,/end/c absent', 'open'), 'outside\n'],
    ['regex range end is not checked on its starting line', sed('/start/,/end/c absent', 'sameEnd'), ''],
    ['zero-address ranges check their regex endpoint on the first line', sed('0,/one/c changed'), 'changed\ntwo\nthree\nfour\n'],
    ['change skips later commands for every range line', "sed -e '2,3c changed' -e 's/^/kept:/' input", 'kept:one\nchanged\nkept:four\n'],
    ['earlier append survives change and flushes after replacement', "sed -e 'a tail' -e 'i head' -e 'c changed' -e 'i absent' single", 'head\nchanged\ntail\n'],
    ['append queued on each change-range line is not discarded', "sed -e 'a tail' -e '1,2c changed' input", 'tail\nchanged\ntail\nthree\ntail\nfour\ntail\n'],
    ['append from an unfinished change range still flushes at EOF', "sed -e 'a tail' -e '1,20c absent' single", 'tail\n'],
    ['change does not run on empty input', sed('c absent', 'empty'), ''],
  ])
})

describe('sed address state survives skipped commands and resets per file', () => {
  examples([
    ['numeric range begins after its start line was deleted earlier', sed('1d;1,3p', 'input', '-n'), 'two\nthree\n'],
    ['numeric range closes if its end line was deleted earlier', sed('3d;1,3p', 'input', '-n'), 'one\ntwo\n'],
    ['skipping a whole numeric range does not activate it afterward', sed('1,3d;1,2p', 'input', '-n'), ''],
    ['change starts after its numeric start line was skipped', "sed -e 1d -e '1,2c changed' input", 'changed\nthree\nfour\n'],
    ['change does not emit late after its numeric end was skipped', "sed -e 2d -e '1,2c absent' input", 'three\nfour\n'],
    ['a skipped regex endpoint leaves the range active until another match', sed('3d;/start/,/end/p', 'ranges', '-n'), 'start\nmiddle\noutside\nstart\nend\n'],
    ['change follows a regex range across input files', sed('/start/,/end/c changed', 'left right'), 'before\nchanged\nafter\n'],
    ['separate files discard an unfinished change range before the next file', sed('/start/,/end/c absent', 'left right', '-s'), 'before\ntail\nend\nafter\n'],
    ['separate files allow a new completed change range', sed('/start/,/end/c changed', 'left restart', '-s'), 'before\nchanged\nafter\n'],
    ['numeric change ranges reset for each file', sed('1,2c changed', 'input input', '-s'), 'changed\nthree\nfour\nchanged\nthree\nfour\n'],
    ['append addresses use per-file last records with separate inputs', sed('$a last', 'single unterminated', '-s'), 'item\nlast\nitem\nlast\n'],
  ])
})

describe('sed editing preserves record and text terminators', () => {
  examples([
    ['append supplies an absent input terminator before its text', sed('a tail', 'unterminated'), 'item\ntail\n'],
    ['insert does not add a terminator to the following input record', sed('i head', 'unterminated'), 'head\nitem'],
    ['change supplies its own text terminator', sed('c changed', 'unterminated'), 'changed\n'],
    ['insert follows an unterminated explicit print as a separate record', "sed -n -e p -e 'i next' unterminated", 'item\nnext\n'],
    ['delete processes NUL records', sed('1d', 'zero', '-z'), 'second\0'],
    ['append text keeps its source LF under NUL record mode', sed('1a tail', 'zero', '-z'), 'first\0tail\nsecond\0'],
    ['insert text ends with NUL under NUL record mode', sed('1i head', 'zero', '-z'), 'head\0first\0second\0'],
    ['change text ends with NUL under NUL record mode', sed('1c changed', 'zero', '-z'), 'changed\0second\0'],
    ['append supplies a missing NUL before its LF-terminated text', sed('a tail', 'zeroLast', '-z'), 'item\0tail\n'],
    ['queued append survives deletion in NUL mode', "sed -z -e 'a tail' -e d zero", 'tail\ntail\n'],
    ['insert leaves embedded text newlines intact in NUL mode', sed('i first\\nsecond', 'single', '-z'), 'first\nsecond\0item\n'],
    ['change leaves embedded text newlines intact in NUL mode', sed('c first\\nsecond', 'single', '-z'), 'first\nsecond\0'],
    ['empty NUL records still execute editing commands', sed('i head', 'zeroEmpty', '-z'), 'head\0\0head\0x\0'],
  ])
})

describe('sed editing text comes from expressions and script files', () => {
  examples([
    ['short text consumes semicolons as literal data', sed('a literal; d', 'single'), 'item\nliteral; d\n'],
    ['short text consumes hash characters as literal data', sed('i literal # text', 'single'), 'literal # text\nitem\n'],
    ['short-form leading blanks are skipped', sed('a   text', 'single'), 'item\ntext\n'],
    ['backslash-newline text retains leading blanks', sed('a\\\n  text', 'single'), 'item\n  text\n'],
    ['continued text can contain several lines', sed('i\\\nfirst\\\nsecond', 'single'), 'first\nsecond\nitem\n'],
    ['newlines after text separate later sed commands', sed('i head\na tail', 'single'), 'head\nitem\ntail\n'],
    ['text preserves literal Unicode characters', sed('a é😀', 'single'), 'item\né😀\n'],
    ['an explicit empty append text emits an empty line', sed('a\\\n', 'single'), 'item\n\n'],
    ['an explicit empty change text emits an empty line', sed('c\\\n', 'single'), '\n'],
    ['script-file append runs before later expression append', "sed -f scripts/append -e 'a from-expression' single", 'item\nfrom-file\nfrom-expression\n'],
    ['expression insert and script-file insert preserve order', "sed -e 'i from-expression' -f scripts/insert single", 'from-expression\nfrom-file\nitem\n'],
    ['script-file change replaces a range', 'sed -f scripts/change input', 'one\nfrom-file\nfour\n'],
    ['script-file text commands surround substitutions', 'sed -f scripts/mixed single', 'before\nchanged\nafter\n'],
    ['script stdin is consumed before processing the data operand', "printf 'a tail\\n' | sed -f - single", 'item\ntail\n'],
  ])

  for (const script of ['a', 'i', 'c', '2a', '2i', '2c']) {
    it(`missing text is an ordinary syntax error: ${script}`, () => {
      const result = createTerminal(FILES).run(sed(script, 'single'))
      assert.equal(result.stdout, '')
      assert.equal(result.exitCode, 1)
      assert.notEqual(result.stderr, '')
      assert.deepEqual(result.unsupported, [])
    })
  }
})
