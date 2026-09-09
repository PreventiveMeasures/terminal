import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Independent regression cases informed by BusyBox 1.37.0's testsuite/*.tests:
// https://github.com/vda-linux/busybox_mirror/tree/be7d1b7b1701d225379bc1665487ed0871b592a5/testsuite
// Reviewed head, tail, cut, sort, uniq, printf, test, find and xargs tests.
// Upstream is GPLv2 (head: GPLv2-or-later); no upstream test text is vendored.
// Expectations follow GNU/Bash where BusyBox differs, notably printf's \c
// in the format and partially converted numeric operands.

const FILES = {
  'project/main.js': 'export const main = 1\n',
  'project/lib/util.js': 'export const util = 2\n',
  'project/empty.txt': '',
  'field-file': 'maple:birch\n',
}

function check(command, input, stdout, exitCode = 0) {
  const files = input === null ? FILES : { ...FILES, input }
  const line = input === null ? command : `${command} < input`
  assert.deepEqual(createTerminal(files).run(line), { stdout, stderr: '', exitCode, cwd: '/', unsupported: [] })
}

function cases(rows) {
  for (const [name, command, input, stdout, status] of rows) {
    it(name, () => check(command, input, stdout, status))
  }
}

describe('upstream BusyBox audit — head and tail', () => {
  const rows = Array.from({ length: 13 }, (_, i) => `entry-${i + 1}\n`)
  cases([
    ['head default record count', 'head', rows.join(''), rows.slice(0, 10).join('')],
    ['head positive record count', 'head -n 3', rows.join(''), rows.slice(0, 3).join('')],
    ['head negative record count', 'head -n -4', rows.join(''), rows.slice(0, -4).join('')],
    ['head drops all records', 'head -n -20', rows.join(''), ''],
    ['head preserves unterminated last record', 'head -n 3', 'red\nblue', 'red\nblue'],
    ['head removes unterminated last record', 'head -n -1', 'red\nblue', 'red\n'],
    ['head byte count', 'head -c 4', 'planet\norbit', 'plan'],
    ['head negative byte count', 'head -c -4', 'planet\norbit', 'planet\no'],
    ['tail positive offset beyond end', 'tail -c +80', 'orbit', ''],
    ['tail offset starts at byte one', 'tail -c +1', 'orbit', 'orbit'],
    ['tail zero start offset', 'tail -c +0', 'orbit', 'orbit'],
    ['tail positive byte offset', 'tail -c +4', 'planet', 'net'],
    ['tail large positive byte offset', 'tail -c +12290', 'x'.repeat(20000), 'x'.repeat(7711)],
    ['tail last bytes', 'tail -c 4', 'planet\norbit', 'rbit'],
    ['tail from a record number', 'tail -n +3', 'one\ntwo\nthree\nfour', 'three\nfour'],
    ['tail ignores absent record', 'tail -n +9', 'one\ntwo', ''],
    ['tail last unterminated record', 'tail -n 1', 'one\ntwo', 'two'],
    ['tail empty input', 'tail -n 3', '', ''],
  ])
})

describe('upstream BusyBox audit — cut', () => {
  cases([
    ['character selection deduplicates repeated positions', 'cut -c 4,4,4', 'abcdefghij\nqrstuvwxyz', 'd\nt\n'],
    ['character selection merges intersecting ranges', 'cut -c 2-5,4-7,9-10', 'abcdefghij', 'bcdefgij\n'],
    ['character selection merges contained ranges', 'cut -c 2-8,4-6', 'abcdefghij', 'bcdefgh\n'],
    ['open character range beyond short input', 'cut -c 5-', 'abc\nabcdefgh', '\nefgh\n'],
    ['character selection starting at the beginning', 'cut -c -4', 'abcdefgh\nxy', 'abcd\nxy\n'],
    ['character selection adds missing newline', 'cut -c 2,5,8', 'abcdefghij', 'beh\n'],
    ['field selection preserves absent delimiter', 'cut -d: -f2', 'oak:elm\nplain\nfir:pine', 'elm\nplain\npine\n'],
    ['field selection suppresses absent delimiter', 'cut -d: -f2 -s', 'oak:elm\nplain\nfir:pine', 'elm\npine\n'],
    ['field selection preserves an empty middle field', 'cut -d: -f1-3', 'oak::elm:fir', 'oak::elm\n'],
    ['field selection preserves adjacent empty fields', 'cut -d: -f2-4', 'oak:::elm:fir', '::elm\n'],
    ['field selection preserves empty leading and final fields', 'cut -d: -f1,4', ':oak:elm:', ':\n'],
    ['open field range', 'cut -d: -f3-', 'oak:elm:fir:pine\nplain', 'fir:pine\nplain\n'],
    ['field selection orders positions by input', 'cut -d: -f4,1,2', 'oak:elm:fir:pine', 'oak:elm:pine\n'],
    ['field selection reads stdin and a file', 'cut -d: -f2 - field-file', 'oak:elm\n', 'elm\nbirch\n'],
  ])
})

describe('upstream BusyBox audit — sort', () => {
  const rows = 'm 8\nz 3\na 8\nb -2\n'
  cases([
    ['lexical sort is not numeric', 'sort', '9\n2\n011\n', '011\n2\n9\n'],
    ['numeric sort accepts octal-looking decimal text', 'sort -n', '9\n2\n011\n', '2\n9\n011\n'],
    ['reverse lexical order', 'sort -r', 'elm\noak\nash\n', 'oak\nelm\nash\n'],
    ['numeric field with lexical fallback', 'sort -k2,2n', rows, 'b -2\nz 3\na 8\nm 8\n'],
    ['per-key numeric order and global reverse fallback', 'sort -r -k2,2n', rows, 'b -2\nz 3\nm 8\na 8\n'],
    ['per-key reverse numeric order', 'sort -k2,2nr', rows, 'a 8\nm 8\nz 3\nb -2\n'],
    ['second key reverses equal numeric values', 'sort -k2,2n -k1,1r', rows, 'b -2\nz 3\nm 8\na 8\n'],
    ['numeric keys preserve empty first delimited field', 'sort -n -t/ -k3', '/oak/9\n/elm/2\n', '/elm/2\n/oak/9\n'],
    ['empty numeric keys fall back to whole lines', 'sort -n -t/ -k3', '//oak/9\n//elm/2\n', '//elm/2\n//oak/9\n'],
    ['delimited first field excludes separator', 'sort -t: -k1,1', 'oak/oak:a\noak:z\n', 'oak:z\noak/oak:a\n'],
    ['unique keys retain the first matching line', 'sort -u -k2', 'z same\na same\n', 'z same\n'],
    ['unique numeric keys compare numerical value', 'sort -un', '02\n2\n1\n', '1\n02\n'],
    ['NUL records retain embedded newlines', 'sort -z', 'z\na\0b\0a\0', 'a\0b\0z\na\0'],
    ['numeric key ignores leading field blanks', "sort -n -t ' ' -k2", ' 7 \n 2 \n word \n', ' word \n 2 \n 7 \n'],
  ])
})

describe('upstream BusyBox audit — uniq', () => {
  const input = 'east\neast\nnorth\nwest\nwest\nwest\n'
  cases([
    ['default adjacent unique records', 'uniq', input, 'east\nnorth\nwest\n'],
    ['explicit stdin operand', 'uniq -', input, 'east\nnorth\nwest\n'],
    ['explicit stdout operand', 'uniq - -', input, 'east\nnorth\nwest\n'],
    ['duplicate records only', 'uniq -d', input, 'east\nwest\n'],
    ['unique records only', 'uniq -u', input, 'north\n'],
    ['duplicate and unique filters exclude every record', 'uniq -du', input, ''],
    ['duplicate counts preserve GNU padding', 'uniq -c', input, '      2 east\n      1 north\n      3 west\n'],
    ['field skipping precedes character skipping', 'uniq -f2 -s3', 'a\tb\txy7\nc\td\tzz7\ne\tf\tzz8\n', 'a\tb\txy7\ne\tf\tzz8\n'],
    ['comparison width excludes differing suffixes', 'uniq -w3', 'oak1\noak2\noak3', 'oak1\n'],
    ['character skipping precedes comparison width', 'uniq -s2 -w3', 'xxoak1\nyyoak2\nzzelm3', 'xxoak1\nzzelm3\n'],
    ['empty input emits no record', 'uniq', '', ''],
    ['only adjacent repeats are removed', 'uniq', 'east\nwest\neast\n', 'east\nwest\neast\n'],
  ])
})

describe('upstream BusyBox audit — printf', () => {
  cases([
    ['Bash preserves format backslash c', "printf 'before\\cafter' ignored", null, 'before\\cafter'],
    ['percent b stops reuse and the rest of the format', "printf '[%b]after' 'oak\\celm' pine", null, '[oak'],
    ['format repeats without shell expansion of values', "printf '%s\\n' oak '$PWD'", null, 'oak\n$PWD\n'],
    ['percent b expands every operand', "printf '%b' 'oak\\telm' 'fir\\\\pine\\n'", null, 'oak\telmfir\\pine\n'],
    ['quoted integer operands select their first character', `printf '%d\\n' '"Q' "'R" "'Stail"`, null, '81\n82\n83\n'],
    ['string operands preserve quote prefixes', `printf '%s\\n' '"Q' "'R" "'Stail"`, null, '"Q\n\'R\n\'Stail\n'],
    ['floating width and precision', "printf '|%15.8f|' 2.75", null, '|     2.75000000|'],
    ['floating star width and precision', "printf '|%*.*f|' 15 8 2.75", null, '|     2.75000000|'],
    ['negative floating star width', "printf '|%*f|' -15 2.75", null, '|2.750000       |'],
    ['negative floating star precision uses default', "printf '|%.*f|' -8 2.75", null, '|2.750000|'],
    ['negative floating width and precision', "printf '|%*.*f|' -15 -8 2.75", null, '|2.750000       |'],
    ['integer length modifiers retain shell precision', "printf '%zd %ld %Ld' -7 -7 -7", null, '-7 -7 -7'],
    ['literal percent consumes no argument', "printf '%%\\n' unused", null, '%\n'],
    ['integer conversion accepts leading signs and blanks', "printf '%d ' 6 +6 '   6' '   +6'", null, '6 6 6 6 '],
    ['hex conversion accepts leading signs and blanks', "printf '%x ' 47 +47 '   47' '   +47'", null, '2f 2f 2f 2f '],
    ['zero flag precedes star width', "printf '%0*d' 4 3", null, '0003'],
    ['multiple flags combine', "printf '%0 d' 7", null, ' 7'],
  ])

  it('Bash retains the converted numeric prefix on a malformed operand', () => {
    const r = createTerminal().run("printf '%d\\n' 4 57tail 8")
    assert.equal(r.stdout, '4\n57\n8\n')
    assert.equal(r.exitCode, 1)
    assert.match(r.stderr, /57tail.*not completely converted/u)
    assert.deepEqual(r.unsupported, [])
  })
})

describe('upstream BusyBox audit — test argument-count rules', () => {
  cases([
    ['no arguments is false', 'test', null, '', 1],
    ['one empty argument is false', "test ''", null, '', 1],
    ['one exclamation mark is a string', 'test !', null, ''],
    ['one help-looking argument is a string', 'test --help', null, ''],
    ['one file predicate is a string', 'test -f', null, ''],
    ['negated file-looking string is false', 'test ! -f', null, '', 1],
    ['binary equality precedes operator interpretation', 'test -lt = -gt', null, '', 1],
    ['matching exclamation strings compare equal', "test '!' = '!'", null, ''],
    ['matching parenthesis strings compare equal', "test '(' = '('", null, ''],
    ['four-argument negation of string equality', "test '!' '(' = '('", null, '', 1],
    ['bracket unary regular file test', '[ -f project/main.js ]', null, ''],
    ['bracket unary missing file test', '[ -f project/missing.js ]', null, '', 1],
  ])
})

describe('upstream BusyBox audit — find', () => {
  cases([
    ['implicit dot starting point', '(cd project; find -type f | sort)', null, './empty.txt\n./lib/util.js\n./main.js\n'],
    ['successful individual exec', 'find project/main.js -exec true {} \\;', null, ''],
    ['failed individual exec is a false predicate, not an error', 'find project/main.js -exec false {} \\;', null, ''],
    ['successful batched exec', 'find project/main.js -exec true {} +', null, ''],
    ['failed batched exec fails find', 'find project/main.js -exec false {} +', null, '', 1],
    ['root name ignores repeated slashes', 'find /// -maxdepth 0 -name /', null, '///\n'],
    ['root name is not its repeated slash spelling', 'find /// -maxdepth 0 -name ///', null, ''],
    ['dot root name ignores trailing slashes', 'find .//// -maxdepth 0 -name .', null, './///\n'],
    ['dot root name is not its path spelling', 'find .//// -maxdepth 0 -name .////', null, ''],
  ])
})

describe('upstream BusyBox audit — xargs', () => {
  cases([
    ['underscore has no implicit EOF meaning', 'xargs', 'oak\n_\nelm\n', 'oak _ elm\n'],
    ['one argument per command', 'xargs -n1 echo', 'oak elm fir pine', 'oak\nelm\nfir\npine\n'],
    ['partial final argument batch', 'xargs -n3 echo', 'oak elm fir pine', 'oak elm fir\npine\n'],
    ['replacement keeps inner and trailing blanks', "xargs -I{} printf '<%s>\\n' '{}'", ' \n oak\n\n \t elm fir \n', '<oak>\n<elm fir >\n'],
    ['replacement strips leading ASCII whitespace and ignores blank lines', "xargs -I% echo '[%]'", '\v\f\r\t \n \v\t oak\n\f elm fir \n', '[oak]\n[elm fir ]\n'],
    ['word mode strips ASCII whitespace before arguments', "xargs -n1 printf '<%s>\\n'", '\v\f\r oak \v\f\r elm\n', '<oak>\n<elm>\n'],
    ['word mode retains vertical whitespace inside arguments', "xargs -n1 printf '<%s>\\n'", 'oak\velm fir\fpine ash\rbeech', '<oak\velm>\n<fir\fpine>\n<ash\rbeech>\n'],
    ['quoted leading whitespace is preserved', "xargs -n1 printf '<%s>\\n'", "'\voak' \"\felm\"", '<\voak>\n<\felm>\n'],
    ['empty quoted argument is distinct from skipped whitespace', "xargs -n1 printf '<%s>\\n'", "''\v 'oak'", '<\v>\n<oak>\n'],
    ['NUL input bypasses whitespace stripping', "xargs -0 -I{} printf '<%s>\\n' '{}'", '\voak\0 \0\0', '<\voak>\n< >\n<>\n'],
    ['whitespace-only replacement runs no command', 'xargs -I{} echo missing', ' \t\r\v\f\n', ''],
    ['whitespace-only word mode runs once by default', 'xargs echo present', ' \t\r\v\f\n', 'present\n'],
    ['no-run flag prevents the default empty invocation', 'xargs -r echo missing', ' \t\r\v\f\n', ''],
  ])
})

describe('upstream BusyBox audit — unavailable features retain diagnostics', () => {
  const commands = [
    ['cut', 'cut -b 2-5'],
    ['cut', 'cut -n -d: -f2'],
    ['cut', 'cut -DF 2,3'],
    ['sort', 'sort -s -r -k2'],
    ['sort', 'sort -h'],
    ['sort', 'sort -k2,2M'],
    ['sort', 'sort -k1,1.2'],
    ['sort', 'sort -o output'],
    ['uniq', 'uniq - output'],
    ['test', 'test oak -a !'],
    ['test', 'test -f = elm -o fir'],
    ['test', 'test ! oak = elm -a ! fir = fir'],
    ['find', "find project/main.js -ok true {} ';'"],
    ['xargs', 'xargs -E END'],
    ['xargs', "xargs -E ''"],
    ['xargs', 'xargs -e'],
    ['xargs', 'xargs -s 25 echo'],
    ['xargs', 'xargs -t echo'],
  ]
  for (const [name, command] of commands) {
    it(command, () => {
      const r = createTerminal(FILES).run(command)
      assert.notEqual(r.exitCode, 0)
      assert.notEqual(r.stderr, '')
      assert.ok(r.unsupported.some((entry) => entry.command === name), JSON.stringify(r))
      const hidden = createTerminal(FILES).run(`{ ${command}; } 2>/dev/null | true`)
      assert.equal(hidden.stdout, '')
      assert.equal(hidden.stderr, '')
      assert.equal(hidden.exitCode, 0)
      assert.deepEqual(hidden.unsupported, r.unsupported)
    })
  }
})
