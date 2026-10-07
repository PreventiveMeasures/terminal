// The text commands read their command lines and say what went wrong as
// GNU's do. Every expectation here is what bash 5.2, coreutils 9.4,
// findutils 4.9, Debian's which, util-linux's hexdump and xxd printed in
// C.UTF-8.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = { a: '1\n2\n3\n4\n5\n', b: 'x\n', d: { type: 'directory' }, t: 'a:b:c\n', z: 'b\n2\0a\n1\0\n c 3\0', f1: 'x\n' }
const run = (command) => createTerminal(FILES).run(command)
const said = async (command) => { const r = await run(command); return [r.stdout, r.stderr, r.exitCode] }
const tryHelp = (name, line) => `${name}: ${line}\nTry '${name} --help' for more information.\n`

describe('head and tail', () => {
  it("read tail's obsolete +N and -N where at most one operand follows", async () => {
    assert.deepEqual(await said('tail +2 a'), ['2\n3\n4\n5\n', '', 0])
    assert.deepEqual(await said('tail +3c a'), ['2\n3\n4\n5\n', '', 0])
    assert.deepEqual(await said('tail -5 -- a'), ['1\n2\n3\n4\n5\n', '', 0])
    assert.deepEqual(await said('tail -l a'), ['1\n2\n3\n4\n5\n', '', 0])
    assert.deepEqual(await said('tail + a'), ['', '', 0])
    assert.deepEqual(await said('tail +2 a b'), ['==> a <==\n1\n2\n3\n4\n5\n\n==> b <==\nx\n', "tail: cannot open '+2' for reading: No such file or directory\n", 1])
    assert.deepEqual(await said('tail +99999999999999999999 a'), ['', 'tail: invalid number: ‘+99999999999999999999’: Numerical result out of range\n', 1])
    assert.equal((await run('tail +2f a')).unsupported[0].detail, '-f')
  })

  it('call a digit option elsewhere what each calls it', async () => {
    assert.deepEqual(await said('tail -5 a b'), ['', 'tail: option used in invalid context -- 5\n', 1])
    assert.deepEqual(await said('tail -n 2 -5 a'), ['', 'tail: option used in invalid context -- 5\n', 1])
    assert.deepEqual(await said('head a -5'), ['', tryHelp('head', 'invalid trailing option -- 5'), 1])
    assert.deepEqual(await said('head -5x a'), ['', tryHelp('head', 'invalid trailing option -- x'), 1])
    assert.deepEqual(await said('head -5c a'), ['1\n2\n3', '', 0])
  })

  it('name a count they cannot read by what it counts', async () => {
    assert.deepEqual(await said('head -n 1x a'), ['', 'head: invalid number of lines: ‘1x’\n', 1])
    assert.deepEqual(await said('tail -c -x a'), ['', 'tail: invalid number of bytes: ‘x’\n', 1])
    assert.deepEqual(await said('head -n 99999999999999999999 a'), ['', 'head: invalid number of lines: ‘99999999999999999999’: Value too large for defined data type\n', 1])
    assert.deepEqual(await said('head -c 1m a'), ['1\n2\n3\n4\n5\n', '', 0])
  })

  it('tail stops at a directory where it counts bytes or copies a whole input', async () => {
    assert.deepEqual(await said('tail -c2 a d b'), ['==> a <==\n5\n\n==> d <==\n', "tail: error reading 'd': Is a directory\n", 1])
    assert.deepEqual(await said('tail -n +1 a d b'), ['==> a <==\n1\n2\n3\n4\n5\n\n==> d <==\n', "tail: error reading 'd': Is a directory\n", 1])
    assert.deepEqual(await said('tail -n +2 a d b'), ['==> a <==\n2\n3\n4\n5\n\n==> d <==\n\n==> b <==\n', "tail: error reading 'd': Is a directory\n", 1])
  })
})

describe('operands named in diagnostics', () => {
  it('are quoted as each tool quotes them', async () => {
    assert.equal((await run("cat '*.log' d a:b é")).stderr, "cat: '*.log': No such file or directory\ncat: d: Is a directory\ncat: 'a:b': No such file or directory\ncat: é: No such file or directory\n")
    assert.equal((await run('head "it\'s"')).stderr, 'head: cannot open "it\'s" for reading: No such file or directory\n')
    assert.equal((await run("wc '' a")).stderr, 'wc: invalid zero-length file name\n')
    assert.equal((await run("sort 'a b'")).stderr, "sort: cannot read: 'a b': No such file or directory\n")
    assert.equal((await run("grep x 'a b'")).stderr, 'grep: a b: No such file or directory\n')
    assert.equal((await run('xxd d')).stderr, 'xxd: Is a directory\n')
  })

  it('a GNU tool run by its path names itself by the path', async () => {
    assert.equal((await run('/usr/bin/head nofile')).stderr, "/usr/bin/head: cannot open 'nofile' for reading: No such file or directory\n")
    assert.equal((await run('/usr/bin/xargs -n x')).stderr, tryHelp('/usr/bin/xargs', 'invalid number "x" for -n option'))
    assert.equal((await run('/usr/bin/grep -e')).stderr, "/usr/bin/grep: option requires an argument -- 'e'\nUsage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n")
    assert.equal((await run('/bin/gzip nofile')).stderr, 'gzip: nofile: No such file or directory\n')
  })
})

describe('cut, tr, seq, nl, uniq, sort', () => {
  it('cut reads a list as set_fields does', async () => {
    assert.deepEqual(await said('cut -f- t'), ['', tryHelp('cut', 'invalid range with no endpoint: -'), 1])
    assert.deepEqual(await said('cut -c 18446744073709551615 t'), ['', tryHelp('cut', 'byte/character offset ‘18446744073709551615’ is too large'), 1])
    assert.deepEqual(await said('cut -f 1x,2 t'), ['', tryHelp('cut', 'invalid field value ‘x,2’'), 1])
    assert.deepEqual(await said('cut -f1 -f2 t'), ['', tryHelp('cut', 'only one list may be specified'), 1])
  })

  it('seq and tr take options only before their operands', async () => {
    assert.deepEqual(await said('seq 3 -w'), ['', tryHelp('seq', 'invalid floating point argument: ‘-w’'), 1])
    assert.deepEqual(await said('seq 1 2 -w 10'), ['', tryHelp('seq', 'extra operand ‘10’'), 1])
    assert.deepEqual(await said('seq -5 -s : -3'), ['', tryHelp('seq', 'extra operand ‘-3’'), 1])
    assert.deepEqual(await said('echo abc | tr a -d'), ['-bc\n', '', 0])
    assert.deepEqual(await said('tr -d a b < a'), ['', tryHelp('tr', 'extra operand ‘b’\nOnly one string may be given when deleting without squeezing repeats.'), 1])
  })

  it('seq keeps the sign of a first operand of minus zero, and refuses what a long double would round', async () => {
    assert.deepEqual(await said('seq -0 2'), ['-0\n1\n2\n', '', 0])
    assert.deepEqual(await said('seq -w -0 2'), ['-0\n01\n02\n', '', 0])
    assert.deepEqual(await said('seq nan'), ['', tryHelp('seq', 'invalid ‘not-a-number’ argument: ‘nan’'), 1])
    assert.deepEqual(await said('seq 18446744073709551616 18446744073709551617'), ['18446744073709551616\n18446744073709551617\n', '', 0])
    assert.equal((await run('seq -w 18446744073709551616 18446744073709551617')).unsupported.length, 1)
  })

  it('nl and uniq word their options as GNU does', async () => {
    assert.deepEqual(await said('nl -bx a'), ['', tryHelp('nl', 'invalid body numbering style: ‘x’'), 1])
    assert.deepEqual(await said('nl -v 9223372036854775808 a'), ['', 'nl: invalid starting line number: ‘9223372036854775808’: Value too large for defined data type\n', 1])
    assert.deepEqual(await said('uniq -f -0 a'), ['', 'uniq: -0: invalid number of fields to skip\n', 1])
    assert.deepEqual(await said('uniq a a a'), ['', tryHelp('uniq', 'extra operand ‘a’'), 1])
  })

  it('sort takes `\\0` as a NUL tab and counts a newline a blank', async () => {
    assert.deepEqual(await said("sort -z -b -k1 z | tr '\\0' '|'"), ['a\n1|b\n2|\n c 3|', '', 0])
    assert.deepEqual(await said("sort -t '\\0' -k2 z | tr '\\0' '|'"), [' c 3|\n1|\nb\n2|a\n', '', 0])
    assert.deepEqual(await said("sort -t '' a"), ['', 'sort: empty tab\n', 2])
    assert.deepEqual(await said('sort -t: -t, a'), ['', 'sort: incompatible tabs\n', 2])
  })
})

describe('which, xargs, tac, tee, date', () => {
  it('which says nothing of what it does not find', async () => {
    assert.deepEqual(await said('which ls nope'), ['/usr/bin/ls\n', '', 1])
    assert.deepEqual(await said('which /bin/ls'), ['/bin/ls\n', '', 0])
    assert.deepEqual(await said('which cd'), ['', '', 1])
    assert.deepEqual(await said('which'), ['', '', 1])
  })

  it('xargs builds command lines of at most 128 KiB', async () => {
    assert.deepEqual(await said("seq 100000 | sed 's/.*/x/' | xargs | awk '{print NF}'"), ['65533\n34467\n', '', 0])
    assert.deepEqual(await said("{ seq 65532 | sed 's/.*/x/'; echo xx; echo y; } | xargs | awk '{print NF}'"), ['65533\n1\n', '', 0])
    assert.deepEqual(await said("printf '%131066s' '' | tr ' ' a | xargs | wc -c"), ['131067\n', '', 0])
    assert.deepEqual(await said("{ echo a; printf '%131067s' '' | tr ' ' b; echo; echo c; } | xargs"), ['a\n', 'xargs: argument line too long\n', 1])
  })

  it('xargs words -n as findutils does', async () => {
    assert.deepEqual(await said('echo a | xargs -n x echo'), ['', tryHelp('xargs', 'invalid number "x" for -n option'), 1])
    assert.deepEqual(await said('echo a | xargs -n -1 echo'), ['', tryHelp('xargs', 'value -1 for -n option should be >= 1'), 1])
    assert.deepEqual(await said('echo a | xargs -n 99999999999999999999 echo'), ['a\n', '', 0])
  })

  it('tac reads a regular file on stdin from its start for every `-`', async () => {
    assert.deepEqual(await said('tac - - < b'), ['x\nx\n', '', 0])
    assert.deepEqual(await said('{ head -n2 >/dev/null; tac; } < a'), ['5\n4\n3\n2\n1\n', '', 0])
    assert.deepEqual(await said('cat b | tac - -'), ['x\n', '', 0])
  })

  it('tee refuses to write the file its stdout goes to', async () => {
    const r = await createTerminal(FILES, { mount: '/w', writable: '/tmp/' }).run('echo hi | tee /tmp/a >> /tmp/a')
    assert.equal(r.unsupported[0].detail, 'file also stdout')
  })

  it('date calls an operand that is no format an invalid date', async () => {
    assert.deepEqual(await said('date x'), ['', 'date: invalid date ‘x’\n', 1])
    assert.deepEqual(await said('date +%Y x'), ['', tryHelp('date', 'extra operand ‘x’'), 1])
  })

  it('od, hexdump and xxd say what they could open nothing of', async () => {
    assert.deepEqual(await said('od nofile'), ['', 'od: nofile: No such file or directory\n', 1])
    assert.deepEqual(await said('hexdump nofile'), ['', 'hexdump: nofile: No such file or directory\nhexdump: all input file arguments failed\n', 1])
    assert.deepEqual(await said('xxd nofile'), ['', 'xxd: nofile: No such file or directory\n', 2])
  })
})

describe('the programs a path, xargs or find -exec runs', () => {
  it('echo reads escapes as coreutils does', async () => {
    assert.deepEqual(await said("/bin/echo -e 'x\\u263a'"), ['x\\u263a\n', '', 0])
    assert.deepEqual(await said("echo x | xargs echo -e '\\101\\0101\\E'"), ['AA\\E x\n', '', 0])
    assert.deepEqual(await said("echo -e 'x\\u263a'"), ['x☺\n', '', 0])
    assert.equal((await run('/bin/echo --version')).unsupported[0].detail, '--version')
  })

  it('printf stops at \\c and warns of arguments it never reached', async () => {
    assert.deepEqual(await said("/usr/bin/printf 'a\\cb'"), ['a', '', 0])
    assert.deepEqual(await said('/usr/bin/printf a b'), ['a', '/usr/bin/printf: warning: ignoring excess arguments, starting with ‘b’\n', 0])
    assert.deepEqual(await said('/usr/bin/printf'), ['', tryHelp('/usr/bin/printf', 'missing operand'), 1])
    assert.deepEqual(await said('/usr/bin/printf -x'), ['-x', '', 0])
  })

  it('test and [ word their errors as coreutils does', async () => {
    assert.deepEqual(await said('/usr/bin/test a b'), ['', '/usr/bin/test: missing argument after ‘b’\n', 2])
    assert.deepEqual(await said('/usr/bin/[ x'), ['', '/usr/bin/[: missing ‘]’\n', 2])
    assert.deepEqual(await said('echo x | xargs test 1 -eq'), ['', 'test: invalid integer ‘x’\n', 123])
    assert.deepEqual(await said('/usr/bin/test a b c d'), ['', '/usr/bin/test: extra argument ‘b’\n', 2])
    assert.deepEqual(await said('/usr/bin/test 99999999999999999999 -gt 1'), ['', '', 0])
    assert.deepEqual(await said('test a b c d'), ['', 'terminal: test: too many arguments\n', 2])
  })

  it('true, false and pwd take their arguments as coreutils does', async () => {
    assert.deepEqual(await said('/bin/false x'), ['', '', 1])
    assert.deepEqual(await said('echo x | xargs pwd'), ['/\n', 'pwd: ignoring non-option arguments\n', 0])
    assert.deepEqual(await said('pwd -P x'), ['/\n', '', 0])
    assert.equal((await run('/bin/true --help')).unsupported[0].detail, '--help')
  })
})

describe("bash's printf builtin", () => {
  it('names a number it cannot read as bash does', async () => {
    assert.deepEqual(await said("printf '%d\\n' 3x"), ['3\n', 'terminal: printf: 3x: invalid number\n', 1])
    assert.deepEqual(await said("printf '%d\\n' 08"), ['0\n', 'terminal: printf: 08: invalid octal number\n', 1])
    assert.deepEqual(await said("printf '%d\\n' 99999999999999999999"), ['9223372036854775807\n', 'terminal: printf: warning: 99999999999999999999: Numerical result out of range\n', 0])
    assert.deepEqual(await said("printf '%d\\n' \"'\""), ['0\n', '', 0])
  })

  it('warns of an escape short of digits and carries on', async () => {
    assert.deepEqual(await said("printf '\\x41\\x'"), ['A\\x', 'terminal: printf: missing hex digit for \\x\n', 0])
    assert.deepEqual(await said("printf '%b' 'a\\u'"), ['a\\u', 'terminal: printf: missing unicode digit for \\u\n', 0])
  })

  it('words a format and an option it cannot read as bash does', async () => {
    assert.deepEqual(await said("printf 'a%yb' 1"), ['a', "terminal: printf: `y': invalid format character\n", 1])
    assert.deepEqual(await said("printf '%5.'"), ['', "terminal: printf: `%5.': missing format character\n", 1])
    assert.deepEqual(await said('printf -x'), ['', 'terminal: printf: -x: invalid option\nprintf: usage: printf [-v var] format [arguments]\n', 2])
    assert.deepEqual(await said('printf'), ['', 'printf: usage: printf [-v var] format [arguments]\n', 2])
  })
})
