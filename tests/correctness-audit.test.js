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

function check(command, expected, exitCode = 0) {
  const r = createTerminal(FILES).run(command)
  assert.deepEqual([r.stdout, r.exitCode, r.unsupported], [expected, exitCode, []], command)
  assert.equal(r.stderr, '', command)
}

function gap(command, detail) {
  const r = createTerminal(FILES).run(command)
  assert.notEqual(r.exitCode, 0, command)
  assert.match(r.stderr, /not supported|cannot|read-only|require|too|limit|nesting|unknown option/u, command)
  assert.ok(r.unsupported.some((note) => note.detail === detail), JSON.stringify(r))
  // A downstream success must not hide the diagnostic from the caller.
  const hidden = createTerminal(FILES).run(`${command} 2>/dev/null | cat`)
  assert.ok(hidden.unsupported.some((note) => note.detail === detail), JSON.stringify(hidden))
}

describe('correctness audit — shell expansion and diagnostics', () => {
  it('preserves quote boundaries and literal dollars', () => {
    for (const word of ['$x""y', '"$x""y"', '"$x"y', '$x\'\'y']) check(`x=one; xy=two; echo ${word}`, 'oney\n')
    check('x=one; echo "$""x"', '$x\n')
    check('x=one; xa=A; xb=B; echo $x{a,b}', 'A B\n')
    check('x=one; echo $x""{a,b}', 'onea oneb\n')
    check('x=one; y="$x""y"; echo "$y"', 'oney\n')
  })
  it('preserves empty quoted fields through splitting and braces', () => {
    check('x=; for v in $x""; do echo "[$v]"; done', '[]\n')
    check('x="a "; for v in $x""; do echo "[$v]"; done', '[a]\n[]\n')
    check('for v in {a,""}; do echo "[$v]"; done', '[a]\n[]\n')
    check('for v in "$@"; do echo bad; done', '')
    check('for v in "$@"""; do echo "[$v]"; done', '[]\n')
  })
  it('preserves whitespace and expands command words', () => {
    check('echo \\ ', ' \n')
    check('echo a\rY', 'a\rY\n')
    check('echo a\u00A0', 'a\u00A0\n')
    check('{echo,hi}', 'hi\n')
    check('ech? hello', 'hello\n')
    check('echo new?line', 'new\nline\n')
    check('IFS=; x="a b"; for v in $x; do echo "[$v]"; done', '[a b]\n')
  })
  it('ANSI-C and echo escapes decode bytes, preserving valid UTF-8', () => {
    check("echo $'\\xc3\\xa9'", 'é\n')
    check("echo $'\\303\\251'", 'é\n')
    check("echo -e '\\xc3\\xa9'", 'é\n')
    gap("echo $'\\xff'", 'partial UTF-8 byte sequence')
    gap("echo -e '\\xff'", 'partial UTF-8 byte sequence')
  })
  it('nested command dispatch does not change the enclosing shell', () => {
    const find = createTerminal(FILES).run("find src -maxdepth 0 -exec cd src ';'; pwd")
    assert.equal(find.stdout, '/\n')
    assert.equal(find.unsupported[0].command, 'cd')
    const external = createTerminal(FILES).run('echo src | xargs cd; pwd')
    assert.equal(external.stdout, '/\n')
    assert.equal(external.unsupported[0].command, 'cd')
  })
  it('reports unsupported shell state and expansion constructs', () => {
    gap('IFS=:; x=a:b; echo $x', 'IFS')
    gap('echo ~root', 'tilde prefix')
    gap('GLOBIGNORE=a echo hi', 'GLOBIGNORE')
    gap('LC_ALL=en_US.UTF-8 echo hi', 'LC_ALL')
    gap('cat <&-', '0<&-')
    gap('echo {1..100001}', 'brace expansion limit')
  })
  it('an expansion failure preserves previous output and later stages', () => {
    const r = createTerminal(FILES).run('echo before; IFS=:; x=a:b; { echo $x; } 2>/dev/null | cat; echo after')
    assert.deepEqual([r.stdout, r.stderr, r.exitCode], ['before\nafter\n', '', 0])
    assert.equal(r.unsupported[0].detail, 'IFS')
  })
})

describe('correctness audit — text, filenames and traversal', () => {
  for (const command of ['head -n 10 b', 'tail -n 10 b', "sed -n '1,2p' b"]) {
    it(`${command} preserves the unterminated final line`, () => check(command, 'x\ny'))
  }
  it('handles partial and repeated input reads', () => {
    check('echo hi | { head -n 0; cat; }', 'hi\n')
    check('{ head -n 1; cat; } < a', FILES.a)
    check('cat /dev/null', '')
    gap('grep -m1 alpha < a', 'partial stdin reads')
  })
  it('retains record boundaries in tac, sed and sort', () => {
    check('tac b', 'yx\n')
    check("sed -n '2,1p' a", 'beta\n')
    check("sed -n '2,3p' b a", 'y\nalpha\n')
    check('sort b a', 'alpha\nalpha\nbeta\nx\ny\n')
  })
  it('cat renders control bytes and numbers only originally nonempty lines', () => {
    check('cat -A raw', 'a^@b^I^M$\n$\nend')
    check('cat -bE raw', '     1\ta\0b\t^M$\n$\n     2\tend')
    check('cat -E b', 'x$\ny')
    check('cat -v unicode', 'hM-CM-)llo\n')
  })
  it('keeps exact decimal numeric keys and sequence values', () => {
    check('sort -nu numbers', '-9007199254740993\n-9007199254740992\n9007199254740992\n9007199254740993\n')
    check('sort -nu decimal', '1.00000000000000000001\n1.00000000000000000002\n')
    check('seq 9007199254740992 9007199254740994', '9007199254740992\n9007199254740993\n9007199254740994\n')
    check('seq -w 01 03', '01\n02\n03\n')
    check('seq +1 3', '1\n2\n3\n')
  })
  it('does not treat output files as additional input', () => {
    gap('uniq a b', 'output file')
    gap('xxd a b', 'output file')
    check('uniq a -', FILES.a)
  })
  it('basename and dirname process lexical path text and all operands', () => {
    check('basename a/..', '..\n')
    check('basename ""', '\n')
    check('dirname a/b c/d a/../c', 'a\nc\na/..\n')
    assert.notEqual(createTerminal(FILES).run('basename a b c').exitCode, 0)
  })
  it('ls uses lexical order and only -F classifies directories', () => {
    check('ls src', 'f\ng\nsub\n')
    check('ls -F src', 'f\ng\nsub/\n')
    check('ls -d src a', 'a\nsrc\n')
    check('ls -r src', 'sub\ng\nf\n')
    gap('ls -l src', '-l metadata')
  })
  it('find walks each subtree before moving to a sibling', () => {
    const r = createTerminal({'a/b/c': '', 'a/d': ''}).run('find a')
    assert.equal(r.stdout, 'a\na/b\na/b/c\na/d\n')
    check("find src -path 'src/sub' -prune -o -type f -print", 'src/f\nsrc/g\n')
    gap("find . -name '[[.a.]]'", 'glob collating or equivalence class')
    gap("find . -name '[[=a=]]'", 'glob collating or equivalence class')
  })
  it('valid but unmodeled formats and byte transformations reach the feed', () => {
    gap('date -u +%j', 'format')
    gap('seq 0 .5 1', 'non-integer operands')
    gap('cut -c2 unicode', 'partial UTF-8 byte sequence')
    gap('head -c2 unicode', 'partial UTF-8 byte sequence')
    gap("tr '[:upper:]' '[:lower:]' < a", 'set expressions')
    gap('tr a b < unicode', 'non-ASCII bytes')
  })
})

describe('correctness audit — grep and xargs', () => {
  it('grep handles POSIX classes, longest matches and newline-separated patterns', () => {
    check("echo a | grep -E '[[:alpha:]]'", 'a\n')
    check("echo ab | grep -Eo 'a|ab'", 'ab\n')
    check("echo 'a\nb' | grep -F 'a\nb'", 'a\nb\n')
    check("echo '@' | grep -Fw '@'", '@\n')
    check("echo 'Function(x)' | grep -Fw 'Function('", '', 1)
    check("echo ababa | grep -Fo -e ab -e ba", 'ab\nab\n')
  })
  it('explicit grep . roots keep their prefix', () => {
    const r = createTerminal(FILES).run('grep -r beta .')
    assert.equal(r.stdout, './a:beta\n')
    check('grep -r beta', 'a:beta\n')
  })
  it('quoted option-looking arguments still require --', () => {
    gap('grep "-- foo" a', '-- foo')
    check("echo 'a:b' | cut -d':' -f2", 'b\n')
  })
  it('xargs parses quotes, backslashes, empty arguments and NUL records', () => {
    check('cat words | xargs -n1 echo', 'a b\nc d\n')
    check('cat zero | xargs -0 -n1 echo', 'a\n\nb\n')
    check('echo \'"" a\' | xargs -n1 echo', '\na\n')
    check('echo x | xargs false', '', 123)
    assert.notEqual(createTerminal(FILES).run('echo | xargs -n0').exitCode, 0)
    assert.notEqual(createTerminal(FILES).run('echo \'"x\' | xargs').exitCode, 0)
  })
})

describe('correctness audit — AWK', () => {
  it('counts Unicode characters consistently across string operations', () => {
    check(`awk 'BEGIN { s="😀ab"; print length(s), substr(s,2,1), index(s,"b"); print match(s,/a/), RSTART, RLENGTH }'`, '3 a 3\n2 2 1\n')
  })
  it('runtime representation and recursion limits are diagnosed', () => {
    gap(`awk 'BEGIN { print -log(-1) }'`, 'signed NaN')
    gap(`awk 'function f(n) { return f(n+1) } BEGIN { print f(0) }'`, 'call depth limit')
  })
})
