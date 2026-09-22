import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = {
  a: 'alpha\nbeta\nalpha\n', b: 'x\ny', empty: '',
  numbers: '9007199254740993\n9007199254740992\n-9007199254740993\n-9007199254740992\n',
  decimal: '1.00000000000000000002\n1.00000000000000000001\n01.000000000000000000010\n',
  raw: 'a\0b\t\r\n\nend', unicode: 'héllo\n',
  words: '"a b" c\\ d\n', zero: 'a\0\0b\0',
  'src/f': 'x\n', 'src/g': 'y\n', 'src/sub/h': 'z\n',
  echo: '', '.hidden': '', 'new\nline': '',
}

async function check(command, expected, exitCode = 0) {
  const r = await createTerminal(FILES).run(command)
  assert.deepEqual([r.stdout, r.exitCode, r.unsupported], [expected, exitCode, []], command)
  assert.equal(r.stderr, '', command)
}

async function gap(command, detail) {
  const r = await createTerminal(FILES).run(command)
  assert.notEqual(r.exitCode, 0, command)
  assert.match(r.stderr, /not supported|cannot|read-only|require|too|limit|nesting|unknown option|only the C\.UTF-8/u, command)
  assert.ok(r.unsupported.some((note) => note.detail === detail), JSON.stringify(r))
  // A downstream success must not hide the diagnostic from the caller.
  const hidden = await createTerminal(FILES).run(`${command} 2>/dev/null | cat`)
  assert.ok(hidden.unsupported.some((note) => note.detail === detail), JSON.stringify(hidden))
}

describe('correctness audit — shell expansion and diagnostics', () => {
  it('preserves quote boundaries and literal dollars', async () => {
    for (const word of ['$x""y', '"$x""y"', '"$x"y', '$x\'\'y']) await check(`x=one; xy=two; echo ${word}`, 'oney\n')
    await check('x=one; echo "$""x"', '$x\n')
    await check('x=one; xa=A; xb=B; echo $x{a,b}', 'A B\n')
    await check('x=one; echo $x""{a,b}', 'onea oneb\n')
    await check('x=one; y="$x""y"; echo "$y"', 'oney\n')
  })
  it('preserves empty quoted fields through splitting and braces', async () => {
    await check('x=; for v in $x""; do echo "[$v]"; done', '[]\n')
    await check('x="a "; for v in $x""; do echo "[$v]"; done', '[a]\n[]\n')
    await check('for v in {a,""}; do echo "[$v]"; done', '[a]\n[]\n')
    await check('for v in "$@"; do echo bad; done', '')
    await check('for v in "$@"""; do echo "[$v]"; done', '[]\n')
  })
  it('preserves whitespace and expands command words', async () => {
    await check('echo \\ ', ' \n')
    await check('echo a\rY', 'a\rY\n')
    await check('echo a\u00A0', 'a\u00A0\n')
    await check('{echo,hi}', 'hi\n')
    await check('ech? hello', 'hello\n')
    await check('echo new?line', 'new\nline\n')
    await check('IFS=; x="a b"; for v in $x; do echo "[$v]"; done', '[a b]\n')
  })
  it('ANSI-C and echo escapes decode bytes, preserving valid UTF-8', async () => {
    await check("echo $'\\xc3\\xa9'", 'é\n')
    await check("echo $'\\303\\251'", 'é\n')
    await check("echo -e '\\xc3\\xa9'", 'é\n')
    await gap("echo $'\\xff'", 'partial UTF-8 byte sequence')
    await gap("echo -e '\\xff'", 'partial UTF-8 byte sequence')
  })
  it('nested command dispatch does not change the enclosing shell', async () => {
    const find = await createTerminal(FILES).run("find src -maxdepth 0 -exec cd src ';'; pwd")
    assert.equal(find.stdout, '/\n')
    assert.equal(find.unsupported[0].command, 'cd')
    const external = await createTerminal(FILES).run('echo src | xargs cd; pwd')
    assert.equal(external.stdout, '/\n')
    assert.equal(external.unsupported[0].command, 'cd')
  })
  it('reports unsupported shell state and expansion constructs', async () => {
    await gap('IFS=:; x=a:b; echo $x', 'IFS')
    await gap('echo ~root', 'tilde prefix')
    await gap('GLOBIGNORE=a echo hi', 'GLOBIGNORE')
    await gap('LC_ALL=en_US.UTF-8 echo hi', 'LC_ALL')
    await gap('cat <&-', '0<&-')
    await gap('echo {1..100001}', 'brace expansion limit')
  })
  it('an expansion failure preserves previous output and later stages', async () => {
    const r = await createTerminal(FILES).run('echo before; IFS=:; x=a:b; { echo $x; } 2>/dev/null | cat; echo after')
    assert.deepEqual([r.stdout, r.stderr, r.exitCode], ['before\nafter\n', '', 0])
    assert.equal(r.unsupported[0].detail, 'IFS')
  })
})

describe('correctness audit — text, filenames and traversal', () => {
  for (const command of ['head -n 10 b', 'tail -n 10 b', "sed -n '1,2p' b"]) {
    it(`${command} preserves the unterminated final line`, () => check(command, 'x\ny'))
  }
  it('handles partial and repeated input reads', async () => {
    await check('echo hi | { head -n 0; cat; }', 'hi\n')
    await check('{ head -n 1; cat; } < a', FILES.a)
    await check('cat /dev/null', '')
    await gap('grep -m1 alpha < a', 'partial stdin reads')
  })
  it('retains record boundaries in tac, sed and sort', async () => {
    await check('tac b', 'yx\n')
    await check("sed -n '2,1p' a", 'beta\n')
    await check("sed -n '2,3p' b a", 'y\nalpha\n')
    await check('sort b a', 'alpha\nalpha\nbeta\nx\ny\n')
  })
  it('cat renders control bytes and numbers only originally nonempty lines', async () => {
    await check('cat -A raw', 'a^@b^I^M$\n$\nend')
    await check('cat -bE raw', '     1\ta\0b\t^M$\n$\n     2\tend')
    await check('cat -E b', 'x$\ny')
    await check('cat -v unicode', 'hM-CM-)llo\n')
  })
  it('keeps exact decimal numeric keys and sequence values', async () => {
    await check('sort -nu numbers', '-9007199254740993\n-9007199254740992\n9007199254740992\n9007199254740993\n')
    await check('sort -nu decimal', '1.00000000000000000001\n1.00000000000000000002\n')
    await check('seq 9007199254740992 9007199254740994', '9007199254740992\n9007199254740993\n9007199254740994\n')
    await check('seq -w 01 03', '01\n02\n03\n')
    await check('seq +1 3', '1\n2\n3\n')
  })
  it('does not treat output files as additional input', async () => {
    await gap('uniq a b', 'output file')
    await gap('xxd a b', 'output file')
    await check('uniq a -', FILES.a)
  })
  it('basename and dirname process lexical path text and all operands', async () => {
    await check('basename a/..', '..\n')
    await check('basename ""', '\n')
    await check('dirname a/b c/d a/../c', 'a\nc\na/..\n')
    assert.notEqual((await createTerminal(FILES).run('basename a b c')).exitCode, 0)
  })
  it('ls uses lexical order and only -F classifies directories', async () => {
    await check('ls src', 'f\ng\nsub\n')
    await check('ls -F src', 'f\ng\nsub/\n')
    await check('ls -d src a', 'a\nsrc\n')
    await check('ls -r src', 'sub\ng\nf\n')
    // -l is a model of what the filesystem does not keep; ls-long.test.js pins it.
    const stamp = String.raw`[A-Z][a-z]{2} [ \d]\d \d\d:\d\d`
    assert.match((await createTerminal(FILES).run('ls -l src')).stdout, new RegExp(String.raw`^total 12\n-rw------- 1 user user    2 ${stamp} f\n-rw------- 1 user user    2 ${stamp} g\ndrwx------ 2 user user 4096 ${stamp} sub\n$`, 'u'))
  })
  it('find walks each subtree before moving to a sibling', async () => {
    const r = await createTerminal({'a/b/c': '', 'a/d': ''}).run('find a')
    assert.equal(r.stdout, 'a\na/b\na/b/c\na/d\n')
    await check("find src -path 'src/sub' -prune -o -type f -print", 'src/f\nsrc/g\n')
    await gap("find . -name '[[.a.]]'", 'glob collating or equivalence class')
    await gap("find . -name '[[=a=]]'", 'glob collating or equivalence class')
  })
  it('valid but unmodeled formats and byte transformations reach the feed', async () => {
    await gap('date -u +%j', 'format')
    await gap('seq 0 .5 1', 'non-integer operands')
    await gap('cut -c2 unicode', 'partial UTF-8 byte sequence')
    await gap('head -c2 unicode', 'partial UTF-8 byte sequence')
    await gap("tr '[=a=]' x < a", 'set expressions')
    await gap('tr a b < unicode', 'non-ASCII bytes')
  })
})

describe('correctness audit — grep and xargs', () => {
  it('grep handles POSIX classes, longest matches and newline-separated patterns', async () => {
    await check("echo a | grep -E '[[:alpha:]]'", 'a\n')
    await check("echo ab | grep -Eo 'a|ab'", 'ab\n')
    await check("echo 'a\nb' | grep -F 'a\nb'", 'a\nb\n')
    await check("echo '@' | grep -Fw '@'", '@\n')
    await check("echo 'Function(x)' | grep -Fw 'Function('", '', 1)
    await check("echo ababa | grep -Fo -e ab -e ba", 'ab\nab\n')
  })
  it('explicit grep . roots keep their prefix', async () => {
    const r = await createTerminal(FILES).run('grep -r beta .')
    assert.equal(r.stdout, './a:beta\n')
    await check('grep -r beta', 'a:beta\n')
  })
  it('quoted option-looking arguments still require --', async () => {
    await gap('grep "-- foo" a', '-- foo')
    await check("echo 'a:b' | cut -d':' -f2", 'b\n')
  })
  it('xargs parses quotes, backslashes, empty arguments and NUL records', async () => {
    await check('cat words | xargs -n1 echo', 'a b\nc d\n')
    await check('cat zero | xargs -0 -n1 echo', 'a\n\nb\n')
    await check('echo \'"" a\' | xargs -n1 echo', '\na\n')
    await check('echo x | xargs false', '', 123)
    assert.notEqual((await createTerminal(FILES).run('echo | xargs -n0')).exitCode, 0)
    assert.notEqual((await createTerminal(FILES).run('echo \'"x\' | xargs')).exitCode, 0)
  })
})

describe('correctness audit — AWK', () => {
  it('counts Unicode characters consistently across string operations', async () => {
    await check(`awk 'BEGIN { s="😀ab"; print length(s), substr(s,2,1), index(s,"b"); print match(s,/a/), RSTART, RLENGTH }'`, '3 a 3\n2 2 1\n')
  })
  it('runtime representation and recursion limits are diagnosed', async () => {
    await gap(`awk 'BEGIN { print -log(-1) }'`, 'signed NaN')
    await gap(`awk 'function f(n) { return f(n+1) } BEGIN { print f(0) }'`, 'call depth limit')
  })
})
