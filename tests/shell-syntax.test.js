// The shell's lexical and expansion semantics, checked against what bash
// 5.2 does with the same lines (every expectation here was run through
// `bash -c` over the same file tree). This is the layer every command
// sits behind: a quoting or expansion mistake reaches every command at
// once, and silently.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createTerminal } from '@preventive/terminal'

const SOURCES = {
  'a.txt': 'x y z\nhello world\n',
  'b.txt': 'B\n',
  'src/foo.js': 'console.log(1)\n',
  'src/bar.ts': '2\n',
  'hello world.txt': 'hw\n',
  'package.json': '{\n  "name": "demo"\n}\n',
  '[': 'bracket\n',
}

const term = () => createTerminal(SOURCES)
const out = (line, t = term()) => t.run(line).stdout
const gaps = (line, t = term()) => t.run(line).unsupported.map((u) => `${u.kind}:${u.detail}`)

describe('shell syntax — comments and backslashes', () => {
  it('`#` at the start of a word begins a comment; inside a word it is text', () => {
    assert.equal(out('echo a # comment'), 'a\n')
    assert.equal(out('echo a#b'), 'a#b\n')
    assert.equal(out('echo "a # b"'), 'a # b\n')
    assert.equal(out("echo 'a' # don't"), 'a\n')
    // A comment-only line, and a comment after a separator, run nothing.
    const only = term().run('# just a comment')
    assert.deepEqual([only.stdout, only.stderr, only.exitCode], ['', '', 0])
    assert.equal(out('echo a; # c\necho b'), 'a\nb\n')
  })

  it('a backslash outside quotes takes the next character literally', () => {
    assert.equal(out('echo hello\\ world'), 'hello world\n')
    assert.equal(out('cat hello\\ world.txt'), 'hw\n')
    assert.equal(out('echo \\$x \\\\ \\a \\*'), '$x \\ a *\n')
    assert.equal(out("echo 'it'\\''s'"), "it's\n")
    assert.equal(out('echo a\\;b'), 'a;b\n')
    // `\<newline>` joins lines; a trailing `\` stays.
    assert.equal(out('echo a\\\nb'), 'ab\n')
    assert.equal(out('echo a\\'), 'a\\\n')
    // An escaped glob character never globs.
    assert.equal(out('echo src/\\*.js'), 'src/*.js\n')
  })

  it('inside double quotes only `\\$`, `\\\\`, `` \\` `` and `\\"` are escapes', () => {
    assert.equal(out('grep -n "\\"name\\"" package.json'), '2:  "name": "demo"\n')
    assert.equal(out('grep -rn "console\\\\.log" src'), 'src/foo.js:1:console.log(1)\n')
    assert.equal(out('echo "\\$x \\\\ \\a \\""'), '$x \\ \\a "\n')
    assert.equal(out('echo "a\\\nb"'), 'ab\n')
  })

  it("$'…' decodes ANSI-C escapes and $\"…\" is a plain double-quoted string", () => {
    assert.equal(out("echo $'a\\tb' | cat -A"), 'a^Ib$\n')
    assert.equal(out("echo $'\\x41\\u00E9\\n' | wc -l"), '2\n')
    assert.equal(out('echo $"hi there"'), 'hi there\n')
  })

  it('only blanks separate words — a no-break space is part of the word', () => {
    assert.equal(out('echo a\u00A0b'), 'a\u00A0b\n')
    assert.equal(out('for x in a\u00A0b; do echo [$x]; done'), '[a\u00A0b]\n')
  })
})

describe('shell syntax — parameters', () => {
  it('`$?` is the status of the last command, updated step by step and across runs', () => {
    const t = term()
    assert.equal(out('false; echo $?; true; echo $?', t), '1\n0\n')
    t.run('cat nope')
    assert.equal(out('echo $?', t), '1\n')
    assert.equal(out('echo $?', t), '0\n')
  })

  it('`$#`, `$@`, `$*` and `$1`…`$9` are the empty positional parameters', () => {
    assert.equal(out('echo [$#] [$@] [$*] [$1]'), '[0] [] [] []\n')
  })

  it('PWD, OLDPWD, HOME, USER and LOGNAME are answered; nothing else is', () => {
    const t = createTerminal(SOURCES, { user: 'ann' })
    assert.equal(out('echo $HOME $USER $LOGNAME $PWD', t), '/ ann ann /\n')
    assert.equal(out('cd src; echo $PWD $OLDPWD', t), '/src /\n')
    const unset = t.run('echo [$PATH]')
    assert.equal(unset.stdout, '[]\n')
    assert.match(unset.stderr, /^warning: \$PATH is unset/u)
    assert.deepEqual(unset.unsupported, [{ kind: 'feature', command: null, detail: '$PATH', message: unset.stderr.trimEnd() }])
  })

  it('`$$`, `$!`, `$0`, `$-` and `$_` stay as typed, with a warning', () => {
    const r = term().run('echo $$ $0')
    assert.equal(r.stdout, '$$ $0\n')
    assert.deepEqual(r.unsupported.map((u) => u.detail), ['$$', '$0'])
  })

  it('assignments set variables that persist; a subshell gets a copy', () => {
    const t = term()
    assert.equal(out('x=1; echo $x', t), '1\n')
    assert.equal(out('echo $x', t), '1\n')
    assert.equal(out('x="a  b" y=~; echo "$x" $y', t), 'a  b /\n')
    assert.equal(out('(x=inner; echo $x); echo "$x"', t), 'inner\na  b\n')
    assert.equal(out('{ x=group; }; echo $x', t), 'group\n')
    // In front of a command an assignment is scoped to that command,
    // which cannot see it: `$x` expands before `x` changes, as in bash.
    assert.equal(out('x=1; x=2 echo $x; echo $x', t), '1\n1\n')
    assert.equal(out('export z=3; echo $z; unset z; echo [$z]', t), '3\n[]\n')
  })

  it('a bare expansion is split on blanks; a quoted one is one word', () => {
    const t = term()
    t.run('f="a.txt b.txt"')
    assert.equal(out('cat $f', t), 'x y z\nhello world\nB\n')
    assert.match(t.run('cat "$f"').stderr, /^cat: a.txt b.txt: no such file/u)
    assert.equal(out('f=" a  b "; echo [$f] ["$f"]', t), '[ a b ] [ a  b ]\n')
    assert.equal(out('f=""; echo [$f] ["$f"] $f | wc -w', t), '2\n')
  })

  it('an expanded value globs when bare and stays literal when quoted', () => {
    const t = term()
    t.run('p="src/*.js"')
    assert.equal(out('echo $p', t), 'src/foo.js\n')
    assert.equal(out('echo "$p"', t), 'src/*.js\n')
  })

  it('`~` is the home directory (the tree root) at the start of a bare word', () => {
    assert.equal(out('echo ~ ~/src "~" x~ ~"/src" ~user'), '/ /src ~ x~ ~/src ~user\n')
    assert.equal(out('cd src; cd ~; pwd'), '/\n')
    assert.equal(out('ls ~/src'), 'bar.ts\nfoo.js\n')
  })

  it('`~` also expands after `=` and `:` in assignment-like words, as bash does', () => {
    const t = term()
    assert.equal(out('echo root=~ a:~ x=a:~ x=~"/y"', t), 'root=/ a:~ x=a:/ x=~/y\n')
    assert.equal(out('p=foo:~/src:~; echo $p', t), 'foo:/src:/\n')
    assert.equal(out('export q=y:~; echo $q', t), 'y:/\n')
  })

  it('an assigned HOME drives `~`, `$HOME` and a bare `cd`', () => {
    const t = term()
    assert.equal(out('HOME=/src; echo ~ ~/foo.js $HOME; cd; pwd', t), '/src /src/foo.js /src\n/src\n')
    assert.equal(out('unset HOME; echo ~', t), '/\n')
  })

  it('the substitutions this shell lacks are refused, not passed through', () => {
    for (const [line, detail] of [
      ['echo $(pwd)', '$('],
      ['echo `pwd`', '`'],
      ['echo "$(pwd)"', '$('],
      ['echo $((1+2))', '$(('],
      ['echo ${x%.js}', '${'],
      ['echo ${#x}', '${'],
      ['echo ${x:-d}', '${'],
      ['cat <(ls)', '<('],
    ]) {
      const r = term().run(line)
      assert.equal(r.exitCode, 1, line)
      assert.equal(r.stdout, '', line)
      assert.match(r.stderr, /not supported/u, line)
      assert.deepEqual(r.unsupported.map((u) => `${u.kind}:${u.detail}`), [`feature:${detail}`], line)
    }
  })
})

describe('shell syntax — brace and pathname expansion', () => {
  it('sequence braces: numbers, zero padding, letters, steps, descending', () => {
    assert.equal(out('echo {1..5} {01..3} {a..e..2} {3..1}'), '1 2 3 4 5 01 02 03 a c e 3 2 1\n')
    assert.equal(out('for i in {1..3}; do echo $i; done'), '1\n2\n3\n')
    // Quoting elsewhere in the word does not freeze a bare sequence.
    assert.equal(out('echo "x"{1..3} "{1..3}"'), 'x1 x2 x3 {1..3}\n')
  })

  it('a quoted fragment protects only its own characters', () => {
    assert.equal(out('for d in src; do echo "$d"/*.js; done'), 'src/foo.js\n')
    assert.equal(out('echo "src/"*.ts'), 'src/bar.ts\n')
    assert.equal(out('echo "{a,b}" {a,b}"{c,d}"'), '{a,b} a{c,d} b{c,d}\n')
    assert.equal(out('echo "*" \'*\' \\*'), '* * *\n')
    // A quoted `$` in front of braces is text, not a reference to `$a`.
    assert.equal(out('echo "$"{a,b}'), '$a $b\n')
  })

  it('bracket expressions match, negate, take ranges and POSIX classes; an unmatched `[` is literal', () => {
    const t = createTerminal({ 'a1.txt': 'a\n', 'b1.txt': 'b\n', 'c2.txt': 'c\n', '[': 'bracket\n', 'src/foo.js': '', 'src/boo.js': '', 'src/bar.js': '' })
    assert.equal(out('cat [ab]1.txt', t), 'a\nb\n')
    assert.equal(out('cat [a-c][!1].txt', t), 'c\n')
    assert.equal(out('cat [[:alpha:]][[:digit:]].txt', t), 'a\nb\nc\n')
    assert.equal(out('cat [', t), 'bracket\n')
    assert.equal(out('cat [x]1.txt 2>&1', t), 'cat: [x]1.txt: no such file or directory\n')
    // find's -name uses the same glob language.
    assert.equal(out("find src -name '[fb]oo.js' | sort", t), 'src/boo.js\nsrc/foo.js\n')
    assert.equal(out("find src -name '[!f]oo.js'", t), 'src/boo.js\n')
  })

  it('quoted characters inside a bracket expression are members, and a bad range is literal', () => {
    const t = createTerminal({ a: '', b: '', c: '' })
    assert.equal(out('echo [a"-"c]', t), 'a c\n')
    assert.equal(out('echo [a-c]', t), 'a b c\n')
    assert.equal(out('echo ["!"a] ["^"a] [a"]"]', t), 'a a a\n')
    assert.equal(out("echo [\\!a]", t), 'a\n')
    const bad = t.run('echo [z-a] [b-a]x; echo rc=$?')
    assert.equal(bad.stdout, '[z-a] [b-a]x\nrc=0\n')
    assert.equal(bad.stderr, '')
  })
})

describe('shell syntax — redirects', () => {
  it('redirects apply left to right, so `2>&1 >/dev/null` keeps stderr and drops stdout', () => {
    assert.equal(out('cat nope 2>&1 >/dev/null | wc -l'), '1\n')
    const r = term().run('cat nope a.txt 1>&2 2>/dev/null')
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, 'x y z\nhello world\n')
    assert.equal(r.exitCode, 1)
  })

  it('`&>`, `|&`, `2>&-`, `>>/dev/null` and the two stream devices', () => {
    const both = term().run('cat nope a.txt &>/dev/null')
    assert.deepEqual([both.stdout, both.stderr, both.exitCode], ['', '', 1])
    assert.equal(out('cat nope |& wc -l'), '1\n')
    assert.equal(out('cat nope a.txt 2>&- | wc -l'), '2\n')
    assert.equal(term().run('echo a >>/dev/null').exitCode, 0)
    assert.equal(term().run('echo a >/dev/stderr').stderr, 'a\n')
    assert.equal(out('cat nope 2>/dev/stdout | wc -l'), '1\n')
  })

  it('`<` feeds a file as stdin; a missing or directory operand fails before the command runs', () => {
    assert.equal(out('wc -l < a.txt'), '2\n')
    assert.equal(out('echo piped | cat < b.txt'), 'B\n')
    const missing = term().run('cat < nope; echo rc=$?')
    assert.equal(missing.stderr, 'error: nope: No such file or directory\n')
    assert.equal(missing.stdout, 'rc=1\n')
    assert.match(term().run('cat < src').stderr, /Is a directory/u)
    assert.equal(out('cat < /dev/null | wc -c'), '0\n')
  })

  it('here-strings and here-documents, quoted and unquoted', () => {
    assert.equal(out('cat <<< hi'), 'hi\n')
    assert.equal(out('x=5; cat <<< "v=$x"'), 'v=5\n')
    assert.equal(out('cat <<EOF\nhello $HOME \\$x\nEOF\necho after'), 'hello / $x\nafter\n')
    assert.equal(out("cat <<'EOF'\nhello $HOME\nEOF"), 'hello $HOME\n')
    assert.equal(out('cat <<-EOF\n\tindented\n\tEOF'), 'indented\n')
    assert.equal(out('cat <<EOF | wc -l\na\nb\nEOF'), '2\n')
  })

  it('a real file target is refused with a gap; unusual descriptors are gaps or errors as in bash', () => {
    assert.deepEqual(gaps('echo hi > out.txt'), ['feature:>'])
    assert.deepEqual(gaps('echo hi 3>/dev/null'), ['feature:3>'])
    assert.deepEqual(gaps('x=out.txt; echo hi > $x'), ['feature:>'])
    // `>&3` is bash's own error: nothing opened fd 3.
    const bad = term().run('echo hi >&3')
    assert.deepEqual(bad.unsupported, [])
    assert.match(bad.stderr, /Bad file descriptor/u)
  })
})

describe('shell syntax — compound commands', () => {
  it('`exit` ends the line with its status; in a subshell or pipeline it ends only that part', () => {
    const r = term().run('echo x; exit 4; echo y')
    assert.deepEqual([r.stdout, r.exitCode], ['x\n', 4])
    assert.equal(term().run('for i in 1 2; do echo $i; exit 7; done; echo z').stdout, '1\n')
    assert.equal(out('(exit 3); echo $?'), '3\n')
    assert.equal(out('exit 3 | cat; echo $?'), '0\n')
    assert.equal(out('{ exit 5; }; echo never'), '')
    assert.equal(term().run('false; exit').exitCode, 1)
    assert.equal(term().run('exit 256').exitCode, 0)
    assert.equal(term().run('exit -1').exitCode, 255)
    assert.equal(term().run('exit +7').exitCode, 7)
    // Exact for any digit string bash accepts (a 64-bit integer)…
    assert.equal(term().run('exit 9007199254740993').exitCode, 1)
    assert.equal(term().run('exit 9223372036854775807').exitCode, 255)
    assert.equal(term().run('exit -9223372036854775808').exitCode, 0)
    // …and past that, bash's numeric-argument error.
    const huge = term().run('exit 9223372036854775808; echo never')
    assert.deepEqual([huge.stdout, huge.exitCode], ['', 2])
    assert.match(huge.stderr, /numeric argument required/u)
    const bad = term().run('exit abc; echo never')
    assert.deepEqual([bad.stdout, bad.exitCode], ['', 2])
    assert.match(bad.stderr, /numeric argument required/u)
    assert.deepEqual(gaps('exit 1'), [])
  })

  it('`break` and `continue` control the enclosing loop', () => {
    assert.equal(out('for f in a b c; do echo $f; break; done; echo end'), 'a\nend\n')
    assert.equal(out('for f in a b c; do continue; echo $f; done; echo end'), 'end\n')
    assert.equal(out('for f in a b; do for g in x y; do echo $f$g; break; done; done'), 'ax\nbx\n')
    assert.equal(out('for f in a b; do (break); echo $f; done'), 'a\nb\n')
    const outside = term().run('break; echo next')
    assert.equal(outside.stdout, 'next\n')
    assert.match(outside.stderr, /only meaningful in a `for` loop/u)
    assert.deepEqual(gaps('for f in a; do break 2; done'), ['feature:break N'])
  })

  it('`!` negates a pipeline; `{ …; }` groups without isolating', () => {
    assert.equal(out('! false; echo $?'), '0\n')
    assert.equal(out('! true; echo $?'), '1\n')
    assert.equal(out('! ! true; echo $?'), '0\n')
    // An `exit` keeps its status under `!`; a subshell's status is negated.
    assert.equal(term().run('! exit 3').exitCode, 3)
    assert.equal(term().run('! exit 0').exitCode, 0)
    assert.equal(term().run('! { exit 3; }').exitCode, 3)
    assert.equal(term().run('! (exit 3)').exitCode, 0)
    assert.equal(term().run('! exit 3 | cat').exitCode, 1)
    assert.equal(out('for i in 1 2; do ! break; echo $i; done; echo $?'), '1\n')
    assert.equal(out('! cat nope 2>/dev/null && echo negated'), 'negated\n')
    assert.equal(out('{ echo a; echo b; } | cat'), 'a\nb\n')
    assert.equal(out('{ cd src; }; pwd'), '/src\n')
    assert.equal(out('(cd src); pwd'), '/\n')
    assert.match(term().run('{ echo a }').stderr, /unmatched `\{`/u)
    assert.match(term().run('}').stderr, /syntax error near unexpected token `\}`/u)
  })

  it('a block may open on a line of its own: newlines after `{` and `do`, but no `;`', () => {
    assert.equal(out('{\necho hi\n}'), 'hi\n')
    assert.equal(out('{\n\necho hi\n\n}'), 'hi\n')
    assert.equal(out('{\necho hi; }'), 'hi\n')
    assert.equal(out('(\necho hi\n)'), 'hi\n')
    assert.equal(out('for i in 1 2\ndo\n\necho $i\ndone'), '1\n2\n')
    assert.equal(out('for i in 1 2; do\necho $i\ndone'), '1\n2\n')
    for (const line of ['{ ;echo hi; }', '( ; echo hi )', 'for i in 1; do ; echo $i; done']) {
      assert.equal(term().run(line).exitCode, 2, line)
    }
  })

  it('syntax errors exit 2, as bash exits', () => {
    for (const line of ['echo a ;;', 'echo a |', ')', 'fi', 'then', 'echo a; do']) {
      const r = term().run(line)
      assert.equal(r.exitCode, 2, line)
      assert.deepEqual(r.unsupported, [], line)
    }
  })

  it('bash constructs this shell lacks are named as such', () => {
    assert.deepEqual(gaps('f() { echo hi; }; f'), ['feature:function'])
    assert.deepEqual(gaps('((1+2))'), ['feature:(('])
    assert.deepEqual(gaps('for ((i=0;i<3;i++)); do echo $i; done'), ['feature:for (('])
    assert.deepEqual(gaps('for f; do echo $f; done'), ['feature:for NAME; do'])
    assert.deepEqual(gaps('[[ -f a.txt ]] && echo yes'), ['feature:[['])
    assert.deepEqual(gaps('time ls'), ['feature:time'])
    // Builtins are shell features, not missing commands: no "Available:" hint.
    for (const line of ['test -f a.txt', '[ -f a.txt ]', 'printf "%s\\n" hi', 'source x', 'type ls', 'set -e']) {
      const r = term().run(line)
      assert.equal(r.unsupported[0].kind, 'feature', line)
      assert.doesNotMatch(r.stderr, /Available:/u, line)
      assert.equal(r.exitCode, 127, line)
    }
  })
})

describe('shell syntax — subshell boundaries and redirect operands', () => {
  it('every stage of a multi-stage pipeline runs in a subshell', () => {
    const t = term()
    assert.equal(out('x=before; export x=after | cat; echo $x', t), 'before\n')
    assert.equal(out('cd src | cat; pwd', t), '/\n')
    assert.equal(out('echo hi | cd src; pwd', t), '/\n')
    assert.equal(out('y=1 | cat; echo [$y]', t), '[]\n')
    assert.equal(out('for f in q; do z=1; done | cat; echo [$z]', t), '[]\n')
    // A lone stage is the shell itself.
    assert.equal(out('cd src; pwd', t), '/src\n')
  })

  it('a subshell restores OLDPWD along with the cwd', () => {
    assert.equal(out('cd src; (cd /); cd -; pwd'), '/\n/\n')
    assert.equal(out('cd src; (OLDPWD=/src); cd -; pwd'), '/\n/\n')
  })

  it('every pipeline stage sees the `$?` from before the pipeline', () => {
    assert.equal(out('false; { true; } | echo $?'), '1\n')
    assert.equal(out('false; (true) | echo $?'), '1\n')
    assert.equal(out('false; for i in 1; do true; done | echo $?'), '1\n')
    assert.equal(out('false; ( { true; } | echo $? )'), '1\n')
    assert.equal(out('false; { true; } | cat; echo $?'), '0\n')
    assert.equal(out('(false); echo $?'), '1\n')
  })

  it('warnings from expanding a redirect operand follow fd 2', () => {
    const silenced = term().run('cat <<< $NOPE 2>/dev/null')
    assert.equal(silenced.stderr, '')
    assert.equal(silenced.stdout, '\n')
    assert.deepEqual(silenced.unsupported.map((u) => u.detail), ['$NOPE'])
    const swapped = term().run('cat <<< $NOPE 2>&1 >/dev/null')
    assert.equal(swapped.stderr, '')
    assert.match(swapped.stdout, /^warning: \$NOPE is unset/u)
    assert.match(term().run('cat <<< $NOPE').stderr, /^warning: \$NOPE is unset/u)
  })

  it('a quoted `$@` is no argument at all; `$*` is one empty argument', () => {
    assert.equal(out('echo x "$@" y'), 'x y\n')
    assert.equal(out('echo x "$*" y'), 'x  y\n')
    assert.equal(out('echo "a$@b"'), 'ab\n')
  })

  it('a backslash-newline in an unquoted here-document joins the lines', () => {
    assert.equal(out('cat <<EOF\nfoo\\\nbar\nEOF'), 'foobar\n')
    assert.equal(out("cat <<'EOF'\nfoo\\\nbar\nEOF"), 'foo\\\nbar\n')
  })

  it('a redirect operand is expanded like an argument and must be exactly one word', () => {
    const t = term()
    assert.equal(out('cat < b.tx*', t), 'B\n')
    assert.equal(out('f=b.txt; cat < $f', t), 'B\n')
    const glob = t.run('cat < *.txt')
    assert.deepEqual([glob.stdout, glob.stderr, glob.exitCode], ['', 'error: *.txt: ambiguous redirect\n', 1])
    assert.equal(t.run('f="a.txt b.txt"; cat < $f').stderr, 'error: $f: ambiguous redirect\n')
    assert.equal(t.run('cat < {a,b}.txt').stderr, 'error: {a,b}.txt: ambiguous redirect\n')
    assert.match(t.run('cat < nomatch*.txt').stderr, /nomatch\*\.txt: No such file or directory/u)
    // A here-string is expanded but never split or globbed.
    assert.equal(out('f="a b"; cat <<< $f', t), 'a b\n')
  })

  it('`export` arguments that look like assignments expand as assignments', () => {
    const t = term()
    assert.equal(out('y="a b"; export x=$y; echo [$x]', t), '[a b]\n')
    assert.equal(out('export x=*.txt; echo [$x]', t), '[*.txt]\n')
    assert.equal(out('export x=~/src; echo [$x]', t), '[/src]\n')
  })
})

describe('shell syntax — command conventions', () => {
  it('`-` names standard input for the file readers', () => {
    assert.equal(out('echo hi | cat - a.txt'), 'hi\nx y z\nhello world\n')
    assert.equal(out('echo hi | head -n 1 - b.txt'), '==> standard input <==\nhi\n\n==> b.txt <==\nB\n')
    assert.equal(out('echo hi | wc -l -'), '1 -\n')
    assert.equal(out('echo hi | grep -H hi -'), '(standard input):hi\n')
    assert.equal(out('echo b | sort - b.txt'), 'B\nb\n')
  })

  it('a value option with its argument glued on is an option, even quoted with a space', () => {
    assert.equal(out("cut -d' ' -f2 a.txt"), 'y\nworld\n')
    assert.equal(out("sort -t' ' -k2 a.txt"), 'hello world\nx y z\n')
    assert.equal(out('echo "-n x"'), '-n x\n')
  })

  it('echo parses options as bash does: leading `-[neE]` words only, everything else printed', () => {
    assert.equal(out('echo -- a'), '-- a\n')
    assert.equal(out('echo -x'), '-x\n')
    assert.equal(out('echo a -n b'), 'a -n b\n')
    assert.equal(out('echo -ne "a\\tb"'), 'a\tb')
    assert.equal(out("echo -e -E '\\t'"), '\\t\n')
    assert.equal(out("echo -e '\\u0041'"), 'A\n')
    assert.deepEqual(gaps('echo --bogus'), [])
  })

  it('cd: home, `-`, and bash\'s messages', () => {
    const t = term()
    assert.equal(out('cd src; cd; pwd', t), '/\n')
    assert.equal(out('cd src; cd -; pwd', t), '/\n/\n')
    assert.equal(out('cd src; cd ..; cd -; pwd', t), '/src\n/src\n')
    assert.match(term().run('cd a.txt').stderr, /^cd: a.txt: Not a directory/u)
    assert.match(term().run('cd nope').stderr, /^cd: nope: No such file or directory/u)
    assert.match(term().run('cd a b').stderr, /too many arguments/u)
    assert.match(term().run('cd -').stderr, /OLDPWD not set/u)
  })

  it('cd: `-` is `$OLDPWD`, the shell variable, which `cd` sets and an assignment steers', () => {
    const t = term()
    assert.equal(out('OLDPWD=/src; cd -; pwd', t), '/src\n/src\n')
    assert.equal(out('cd /; cd src; OLDPWD=/; cd -; pwd; cd -; pwd', t), '/\n/\n/src\n/src\n')
    assert.equal(out('cd /; cd src; cd ..; echo $OLDPWD; cd -; echo $OLDPWD', t), '/src\n/src\n/\n')
    assert.equal(out('cd /; OLDPWD=src; cd -; pwd', t), 'src\n/src\n')
    assert.equal(out('cd /; export OLDPWD=/src; cd -; pwd', t), '/src\n/src\n')
    assert.equal(out('cd /; OLDPWD=; cd -; pwd', t), '\n/\n')
    assert.equal(out('cd src; cd nope; echo $OLDPWD'), '/\n')
    const unsetVar = term().run('cd src; unset OLDPWD; cd -')
    assert.match(unsetVar.stderr, /^cd: OLDPWD not set/u)
    assert.equal(unsetVar.exitCode, 1)
    assert.match(term().run('OLDPWD=/nope; cd -').stderr, /^cd: \/nope: No such file or directory/u)
    // An assigned PWD is refreshed by the next change, as bash refreshes it.
    assert.equal(out('PWD=/zzz; pwd; echo $PWD; cd src; echo $PWD'), '/\n/zzz\n/src\n')
  })
})
