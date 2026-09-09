import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU sed's cycle, address and transliteration rules:
// https://www.gnu.org/software/sed/manual/html_node/Common-Commands.html
// https://www.gnu.org/software/sed/manual/html_node/Execution-Cycle.html
const FILES = {
  input: 'one\ntwo\nthree\nfour\n', single: 'item\n', unterminated: 'item', empty: '',
  left: 'a\nb', right: 'c\nd\n', later: 'later\n',
  ranges: 'before\nstart\nmiddle\nend\nafter\nstart\nend\nlast\n',
  letters: 'abba\nabc-xyz\n', unicode: 'é😀é\n', pipe: 'a|b\n', backslash: 'a\\b\n',
  zero: 'a\0b\0', zeroLast: 'a\0b', multiline: 'a\nb\0c\0', binary: 'a\0b\n',
  'scripts/open': '1{\n', 'scripts/close': '}\n', 'scripts/number': '=\n',
  'scripts/nested': '2{\ns/two/TWO/\np\n}\n',
}

const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'"
const sed = (script, input = 'input', flags = '') => `sed ${flags} ${quote(script)} ${input}`

function examples(rows) {
  for (const [name, command, stdout, exitCode = 0] of rows) {
    it(name, () => {
      assert.deepEqual(createTerminal(FILES).run(command), {
        stdout, stderr: '', exitCode, cwd: '/', unsupported: [],
      }, command)
    })
  }
}

describe('sed q stops the program after finishing the current cycle output', () => {
  examples([
    ['quit prints the first input record', sed('q'), 'one\n'],
    ['quiet quit suppresses automatic printing', sed('q', 'input', '-n'), ''],
    ['numeric quit keeps earlier cycles', sed('2q'), 'one\ntwo\n'],
    ['regex quit stops on its selected line', sed('/three/q'), 'one\ntwo\nthree\n'],
    ['quit accepts an explicit exit status', sed('2q 7'), 'one\ntwo\n', 7],
    ['exit status can touch the command', sed('q7'), 'one\n', 7],
    ['exit status is truncated to its low byte', sed('q256'), 'one\n'],
    ['large exit status preserves its low byte after GNU integer conversion', sed('q2147483648'), 'one\n'],
    ['quit flushes an unterminated record delimiter', sed('q', 'unterminated'), 'item\n'],
    ['quit has no effect without an input cycle', sed('q7', 'empty'), ''],
    ['substitution changes the line printed by quit', sed('s/one/ONE/;q'), 'ONE\n'],
    ['explicit print before quit stays visible with quiet output', sed('p;q', 'input', '-n'), 'one\n'],
    ['explicit print and quit automatic print both happen', sed('p;q'), 'one\none\n'],
    ['quit skips later commands', sed('q;s/one/absent/;p'), 'one\n'],
    ['append flushes after quit automatic output', "sed -e 'a tail' -e q input", 'one\ntail\n'],
    ['append flushes under quiet quit', "sed -n -e 'a tail' -e q input", 'tail\n'],
    ['quit flushes several appends in their queued order', "sed -e 'a first' -e 'a second' -e q input", 'one\nfirst\nsecond\n'],
    ['quit prevents later append from being queued', "sed -e q -e 'a absent' input", 'one\n'],
    ['queued append supplies a missing input terminator', "sed -e 'a tail' -e q unterminated", 'item\ntail\n'],
    ['insert prints immediately before quit', "sed -e 'i head' -e q input", 'head\none\n'],
    ['NUL mode quit preserves its record terminator', sed('q', 'zero', '-z'), 'a\0'],
    ['NUL mode quit flushes append text with its LF', "sed -z -e 'a tail' -e q zero", 'a\0tail\n'],
    ['NUL mode quit flushes an unterminated final record delimiter', sed('2q', 'zeroLast', '-z'), 'a\0b\0'],
    ['separate-file mode still quits the entire program', sed('q', 'single input', '-s'), 'item\n'],
  ])
})

describe('sed q reads files and shared stdin only when needed', () => {
  examples([
    ['quit does not open a later missing file', sed('q', 'single missing'), 'item\n'],
    ['empty files before the first record are skipped', sed('q', 'empty single missing'), 'item\n'],
    ['an unreached last-line address does not trigger lookahead', sed('q;$p', 'single missing'), 'item\n'],
    ['last-line lookahead stays in a nonexhausted file', sed('$p;q', 'input missing'), 'one\n'],
    ['separate-file last-line checks do not open later files', sed('$p;q', 'single missing', '-s'), 'item\nitem\n'],
    ['quiet quit leaves unread pipeline records', "cat input | { sed -n '2q'; cat; }", 'three\nfour\n'],
    ['quiet quit leaves unread redirected file records', "{ sed -n '2q'; cat; } <input", 'three\nfour\n'],
    ['quit does not consume a later stdin operand', "printf 'unread\\n' | { sed -n q single -; cat; }", 'unread\n'],
    ['last-line lookahead does not consume the next stdin operand', "printf 'unread\\n' | { sed -n '$p;q' single -; cat; }", 'unread\n'],
    ['quit leaves an unterminated remaining stdin record', "printf 'a\\nb' | { sed -n q; cat; }", 'b'],
    ['NUL mode quit leaves unread NUL-delimited stdin', "cat zero | { sed -zn q; cat; }", 'b\0'],
    ['NUL mode quit leaves an unterminated remaining stdin record', "cat zeroLast | { sed -zn q; cat; }", 'b'],
    ['an unselected quit consumes the complete input', "cat input | { sed -n '20q'; cat; }", ''],
  ])

  for (const [command, stdout] of [
    [sed('q7', 'missing single later'), 'item\n'],
    [sed('q7', 'empty missing single later'), 'item\n'],
    [sed('$p;q7', 'single missing'), 'item\nitem\n'],
    [sed('$!q7', 'single empty missing later'), 'item\n'],
  ]) {
    it(`encountered read errors override quit status: ${command}`, () => {
      const result = createTerminal(FILES).run(command)
      assert.equal(result.stdout, stdout)
      assert.equal(result.exitCode, 2)
      assert.match(result.stderr, /missing: no such file or directory/u)
      assert.deepEqual(result.unsupported, [])
    })
  }
})

describe('sed = prints record numbers with the active output delimiter', () => {
  examples([
    ['line numbers precede automatic pattern output', sed('='), '1\none\n2\ntwo\n3\nthree\n4\nfour\n'],
    ['quiet mode still prints line numbers', sed('=', 'input', '-n'), '1\n2\n3\n4\n'],
    ['line number accepts a range', sed('2,3=', 'input', '-n'), '2\n3\n'],
    ['regex addresses select line numbers', sed('/two/=', 'input', '-n'), '2\n'],
    ['last address selects final line number', sed('$=', 'input', '-n'), '4\n'],
    ['delete prevents a later number from printing', sed('2d;=', 'input', '-n'), '1\n3\n4\n'],
    ['number printed before delete remains visible', sed('=;d'), '1\n2\n3\n4\n'],
    ['line numbers continue across input files', sed('=', 'left right', '-n'), '1\n2\n3\n4\n'],
    ['separate mode resets the number per file', sed('=', 'left right', '-sn'), '1\n2\n1\n2\n'],
    ['line number after an unterminated print starts a new record', sed('p;=', 'unterminated', '-n'), 'item\n1\n'],
    ['line number does not terminate a later unterminated print', sed('=;p', 'unterminated', '-n'), '1\nitem'],
    ['NUL mode line numbers end in NUL', sed('=', 'zero', '-zn'), '1\u00002\u0000'],
    ['NUL mode numbers surround automatic output', sed('=', 'zero', '-z'), '1\u0000a\u00002\u0000b\u0000'],
    ['number command comes from a script file', 'sed -n -f scripts/number input', '1\n2\n3\n4\n'],
  ])
})

describe('sed ! inverts selection while range state still advances', () => {
  examples([
    ['invert a numeric address', sed('2!p', 'input', '-n'), 'one\nthree\nfour\n'],
    ['invert a regex address', sed('/two/!p', 'input', '-n'), 'one\nthree\nfour\n'],
    ['invert a numeric range', sed('2,3!p', 'input', '-n'), 'one\nfour\n'],
    ['inverted regex ranges close and restart', sed('/start/,/end/!p', 'ranges', '-n'), 'before\nafter\nlast\n'],
    ['invert a zero-address range', sed('0,/one/!p', 'input', '-n'), 'two\nthree\nfour\n'],
    ['invert a relative range', sed('2,+1!p', 'input', '-n'), 'one\nfour\n'],
    ['invert the last-line address', sed('$!p', 'input', '-n'), 'one\ntwo\nthree\n'],
    ['unaddressed inversion selects no records', sed('!p', 'input', '-n'), ''],
    ['inverted deletion keeps selected range', sed('2,3!d'), 'two\nthree\n'],
    ['inverted quit stops outside its numeric address', sed('1!q'), 'one\ntwo\n'],
    ['inverted substitution changes only outside the range', sed('2,3!s/^/X/'), 'Xone\ntwo\nthree\nXfour\n'],
    ['inverted change emits for each outside-range line', sed('2,3!c changed'), 'changed\ntwo\nthree\nchanged\n'],
    ['spaces can surround address inversion', sed('2,3 ! p', 'input', '-n'), 'one\nfour\n'],
  ])
})

describe('sed blocks group addressed commands and preserve control flow', () => {
  examples([
    ['a block applies its address to every inner command', sed('2,3{s/o/O/;p;}', 'input', '-n'), 'twO\nthree\n'],
    ['a compact block can omit the last semicolon', sed('1{p}', 'input', '-n'), 'one\n'],
    ['an empty block leaves automatic output unchanged', sed('{}'), FILES.input],
    ['an inverted block handles outside-range lines', sed('2,3!{s/^/X/;p;}', 'input', '-n'), 'Xone\nXfour\n'],
    ['nested delete escapes the entire current cycle', sed('1,3{2{d};s/^/X/};p', 'input', '-n'), 'Xone\nXthree\nfour\n'],
    ['nested quit escapes all blocks and stops the program', sed('1,3{2{s/two/TWO/;q7};p}', 'input', '-n'), 'one\n', 7],
    ['nested quit still performs automatic output', sed('1,3{2{s/two/TWO/;q7}}'), 'one\nTWO\n', 7],
    ['commands after a skipped block still run', sed('2{d};=', 'input', '-n'), '1\n3\n4\n'],
    ['numeric inner ranges begin when a skipped start becomes reachable', sed('1!{1,2p}', 'input', '-n'), 'two\n'],
    ['a skipped regex endpoint leaves the inner range active', sed('4!{/start/,/end/p}', 'ranges', '-n'), 'start\nmiddle\nafter\nstart\nend\n'],
    ['substitutions inside a block affect later addresses', sed('2{s/two/changed/};/changed/p', 'input', '-n'), 'changed\n'],
    ['inverted substitutions still execute within selected blocks', sed('2,3{2!s/^/X/;p}', 'input', '-n'), 'two\nXthree\n'],
    ['blocks can span expression options', "sed -n -e '1{' -e p -e '}' input", 'one\n'],
    ['blocks can span script files and expressions', "sed -n -f scripts/open -e p -f scripts/close input", 'one\n'],
    ['a script file can contain a nested block', "sed -n -e '1,3{' -f scripts/nested -e '}' input", 'TWO\n'],
    ['append queued inside a block flushes after quit', "sed -n -e '1{' -e 'a tail' -e q -e '}' input", 'tail\n'],
    ['append queued inside a block survives deletion', "sed -n -e '1{' -e 'a tail' -e d -e '}' input", 'tail\n'],
    ['last address within a skipped block does not open later input', sed('2{$p};q', 'single missing'), 'item\n'],
  ])
})

describe('sed y transliterates once per input character', () => {
  examples([
    ['transliteration swaps letters without cascading', sed('y/ab/ba/', 'letters'), 'baab\nbac-xyz\n'],
    ['empty transliteration leaves input unchanged', sed('y///', 'input'), FILES.input],
    ['ranges and hyphens are literal characters', sed('y/a-z/A-Z/', 'letters'), 'AbbA\nAbc-xyZ\n'],
    ['transliteration can have an address', sed('1y/ab/AB/', 'letters'), 'ABBA\nabc-xyz\n'],
    ['transliteration follows inverted addresses', sed('1!y/ab/AB/', 'letters'), 'abba\nABc-xyz\n'],
    ['transliteration composes with substitutions and print', sed('s/one/abba/;y/ab/AB/;p', 'input', '-n'), 'ABBA\ntwo\nthree\nfour\n'],
    ['Unicode characters can change UTF-8 width', sed('y/é😀/😀X/', 'unicode'), '😀X😀\n'],
    ['C locale transliteration can preserve valid UTF-8 byte sequences', 'LC_ALL=C ' + sed('y/é/ö/', 'unicode'), 'ö😀ö\n'],
    ['C locale translates both bytes of a Unicode character independently', 'LC_ALL=C ' + sed('y/é/xx/', 'unicode'), 'xx😀xx\n'],
    ['duplicate source characters use the first mapping in Unicode mode', sed('y/aa/XY/', 'letters'), 'XbbX\nXbc-xyz\n'],
    ['duplicate source characters use the last mapping in C locale', 'LC_ALL=C ' + sed('y/aa/XY/', 'letters'), 'YbbY\nYbc-xyz\n'],
    ['escaped delimiter denotes a literal character', sed(String.raw`y|a\||A!|`, 'pipe'), 'A!b\n'],
    ['an escaped letter delimiter is not decoded as a control escape', sed(String.raw`yn\nnxn`, 'input'), 'oxe\ntwo\nthree\nfour\n'],
    ['escaped backslash denotes a literal backslash', sed(String.raw`y/\\/X/`, 'backslash'), 'aXb\n'],
    ['hex escapes map characters', sed(String.raw`y/\x61\x62/AB/`, 'letters'), 'ABBA\nABc-xyz\n'],
    ['transliteration can insert a newline inside pattern space', sed(String.raw`y/a/\n/`, 'left'), '\n\nb'],
    ['NUL record mode preserves newlines for transliteration', sed(String.raw`y/\n/|/`, 'multiline', '-z'), 'a|b\0c\0'],
    ['transliteration can replace NUL inside a normal input line', sed(String.raw`y/\x00/X/`, 'binary'), 'aXb\n'],
    ['transliteration can emit NUL', sed(String.raw`y/a/\x00/`, 'left'), '\0\nb'],
    ['quiet transliteration does not implicitly print', sed('y/ab/AB/', 'letters', '-n'), ''],
    ['transliteration preserves unterminated final input', sed('y/it/IT/', 'unterminated'), 'ITem'],
  ])
})

describe('sed control command syntax errors are ordinary failures', () => {
  for (const script of ['1,2q', 'q-1', 'q+1', 'q junk', '=3', '!!p', '1!!d', '}', '{', '1}', '{2}p', 'y/a/AB/', 'y/ab/A/', 'y/a/b', 'y/a/b/g', String.raw`y/a/\c/`]) {
    it(script, () => {
      const result = createTerminal(FILES).run(sed(script))
      assert.equal(result.stdout, '')
      assert.notEqual(result.exitCode, 0)
      assert.notEqual(result.stderr, '')
      assert.deepEqual(result.unsupported, [])
    })
  }

  it('C locale rejects transliteration lists with different byte lengths', () => {
    const result = createTerminal(FILES).run('LC_ALL=C ' + sed('y/a/Φ/', 'left'))
    assert.equal(result.stdout, '')
    assert.notEqual(result.exitCode, 0)
    assert.notEqual(result.stderr, '')
    assert.deepEqual(result.unsupported, [])
  })
})

describe('sed control commands retain unsupported diagnostics', () => {
  for (const [command, detail] of [
    [sed('Q'), 'script'],
    [sed('1{h;}'), 'script'],
    [sed('1!{h;}'), 'script'],
    [sed('q;h'), 'script'],
    [sed(String.raw`y/\xFF/X/`, 'left'), 'partial UTF-8 byte sequence'],
    ['LC_ALL=C ' + sed(String.raw`y/a/\xFF/`, 'left'), 'partial UTF-8 byte sequence'],
    ['LC_ALL=C ' + sed(String.raw`y/\xC3/X/`, 'unicode'), 'partial UTF-8 byte sequence'],
  ]) {
    it(command, () => {
      const direct = createTerminal(FILES).run(command)
      assert.notEqual(direct.exitCode, 0)
      assert.notEqual(direct.stderr, '')
      assert.deepEqual(direct.unsupported.map((entry) => entry.detail), [detail])
      const hidden = createTerminal(FILES).run(`${command} 2>/dev/null | cat`)
      assert.equal(hidden.stderr, '')
      assert.equal(hidden.exitCode, 0)
      assert.deepEqual(hidden.unsupported, direct.unsupported)
    })
  }

  it('an unsupported compiled command does not consume shared stdin', () => {
    const result = createTerminal(FILES).run("cat input | { sed 'q;h' 2>/dev/null; cat; }")
    assert.equal(result.stdout, FILES.input)
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.unsupported.map((entry) => entry.detail), ['script'])
  })

  it('a runtime transliteration gap leaves unread records available', () => {
    const result = createTerminal(FILES).run(String.raw`printf 'a\nb\n' | { LC_ALL=C sed -n 'y/a/\xFF/' 2>/dev/null; cat; }`)
    assert.equal(result.stdout, 'b\n')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.unsupported.map((entry) => entry.detail), ['partial UTF-8 byte sequence'])
  })
})
