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
    // A character beyond the BMP is two UTF-16 units, one mask unit each.
    assert.equal(out("echo $'\\U0001F600'x"), '\u{1F600}x\n')
    assert.equal(out("echo $'\\U0001F600' | wc -c"), '5\n')
    assert.equal(out('echo "$\'\\U0001F600\'"'), "$'\\U0001F600'\n")
    assert.equal(out("echo $'\\x41\\u00E9\\n' | wc -l"), '2\n')
    assert.equal(out('echo $"hi there"'), 'hi there\n')
    // An escape that decodes to NUL ends the value: bash builds it as a
    // C string, so the rest of the quotes contributes nothing while the
    // word around them is untouched. `\c@` is the same NUL.
    assert.equal(out("echo -n X$'\\0'Y | wc -c"), '2\n')
    assert.equal(out("echo [$'a\\0b\\0c']"), '[a]\n')
    assert.equal(out("echo [$'a\\c@b']"), '[a]\n')
    assert.equal(out("echo [$'\\x00abc'z]"), '[z]\n')
    assert.equal(out("echo [$'a\\u0000b'][$'a\\U00000000b']"), '[a][a]\n')
    // The closing quote is still the last one, not the first after the
    // NUL: the `\'` here is an escaped quote inside the string.
    assert.equal(out("echo [$'a\\0\\'b']"), '[a]\n')
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

  it('assignments in front of a command hold for that command alone, as in bash', () => {
    const t = term()
    assert.equal(out('HOME=/src cd; pwd; echo [$HOME]', t), '/src\n[/]\n')
    assert.equal(out('cd /; OLDPWD=/src cd -; pwd; echo [$OLDPWD]', t), '/src\n/src\n[/]\n')
    assert.equal(out('cd /src; HOME=/ cd; cd -; pwd', t), '/src\n/src\n')
    // The words expand before the assignments do, and each assignment
    // sees the ones before it.
    assert.equal(out('x=1; x=2 echo $x; echo $x', t), '1\n1\n')
    assert.equal(out('cd /; x=1; x=$x$x pwd; echo $x', t), '/\n1\n')
    assert.equal(out('a=/src HOME=$a cd; pwd; cd /', t), '/src\n')
    assert.equal(out('x=1; x=2 export y=$x; echo [$x][$y]', t), '[1][1]\n')
    // A temporary the command itself rebinds stays, as bash keeps it.
    assert.equal(out('x=1; x=2 unset x; echo [$x]', t), '[1]\n')
    assert.equal(out('x=2 export x; echo [$x]', t), '[2]\n')
    assert.equal(out('HOME=/nope cd || echo failed', t), 'failed\n')
    assert.equal(term().run('x=2 exit 4').exitCode, 4)
    assert.deepEqual(gaps('x=$NOPE echo hi'), ['feature:$NOPE'])
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
    assert.equal(out('echo ~ ~/src "~" x~ ~"/src"'), '/ /src ~ x~ ~/src\n')
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

  it('sequences count in exact 64-bit integers, as bash does; outside that range the word is literal', () => {
    assert.equal(out('echo {9007199254740992..9007199254740994}'), '9007199254740992 9007199254740993 9007199254740994\n')
    assert.equal(out('echo {9223372036854775806..9223372036854775807}'), '9223372036854775806 9223372036854775807\n')
    assert.equal(out('echo {-9223372036854775808..-9223372036854775807}'), '-9223372036854775808 -9223372036854775807\n')
    assert.equal(out('echo {1..9223372036854775807..9223372036854775806}'), '1 9223372036854775807\n')
    assert.equal(out('echo {0..9223372036854775807..4611686018427387904}'), '0 4611686018427387904\n')
    assert.equal(out('echo {1..3..9223372036854775807} {a..c..9223372036854775807}'), '1 a\n')
    for (const word of ['{9223372036854775807..9223372036854775808}', '{99999999999999999999..1}', '{-9223372036854775808..9223372036854775807..9223372036854775807}', '{1..2..-9223372036854775808}', '{a..c..9223372036854775808}']) {
      assert.equal(out(`echo ${word}`), `${word}\n`)
    }
    // A `+` sign is accepted; a `+`-signed endpoint never asks for zero padding.
    assert.equal(out('echo {+1..3} {01..+3} {+01..3} {-01..+3} {1..3..+0}'), '1 2 3 01 02 03 1 2 3 -01 000 001 002 003 1 2 3\n')
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

  it('a POSIX class name that is not one contributes no member, as fnmatch reads it', () => {
    // grep rejects `[[:bogus:]]`; a shell glob must not — bash reads the
    // class, finds nothing under that name and matches nothing for it,
    // so the pattern stands for its own text rather than failing the
    // line. The rest of the bracket keeps working, and negating the
    // empty set matches any single character.
    const t = createTerminal({ b: '', x: '', 'sub/y': '' })
    assert.equal(out('echo [[:bogus:]]', t), '[[:bogus:]]\n')
    assert.equal(out('echo [[:bogus:]x]', t), 'x\n')
    assert.equal(out('echo [x[:bogus:]]', t), 'x\n')
    assert.equal(out('echo [[:bogus:][:digit:]x]', t), 'x\n')
    assert.equal(out('echo [![:bogus:]]', t), 'b x\n')
    assert.equal(out('echo [^[:bogus:]]', t), 'b x\n')
    assert.equal(out('echo x[[:bogus:]]y sub/[[:bogus:]]', t), 'x[[:bogus:]]y sub/[[:bogus:]]\n')
    // A name is a class only in the `[:name:]` shape and in lower case.
    assert.equal(out('echo [[:BOGUS:]]', t), '[[:BOGUS:]]\n')
    // An empty class must not let its neighbours fuse into a range.
    assert.equal(out('echo [a-[:bogus:]x]', t), '[a-[:bogus:]x]\n')
    const r = t.run('echo [[:bogus:]]')
    assert.deepEqual([r.stderr, r.exitCode], ['', 0])
    // grep keeps rejecting it — that is a POSIX pattern, not a glob.
    assert.notEqual(t.run('echo b | grep "[[:bogus:]]"').exitCode, 0)
  })

  it('no POSIX class may end a range, and a `-` after one is a member', () => {
    // fnmatch rejects a range whose end is a class, and a pattern it
    // rejects matches nothing — even negated. Unknown and known names
    // alike, so an empty class body can never fuse `a-` and `x` into a
    // live `[a-x]`.
    const t = createTerminal({ a: '', b: '', c: '', x: '', A: '', '-': '' })
    for (const line of ['[a-[:bogus:]x]', '[a-[:alpha:]x]', '[A-[:lower:]]', '[a-[:bogus:]]', '[^a-[:bogus:]x]', '[!a-[:alpha:]x]']) {
      assert.equal(out(`echo ${line}`, t), `${line}\n`, line)
    }
    // A class may sit on either side of a `-` that is a MEMBER: after
    // one, `-` cannot open a range, so these are sets plus a hyphen.
    assert.equal(out('echo [[:bogus:]-x]', t), '- x\n')
    assert.equal(out('echo [[:digit:]-b]', t), '- b\n')
    assert.equal(out('echo [[:alpha:]-[:digit:]]', t), '- A a b c x\n')
    // An escaped `-` is a member too, so the class after it still ends
    // no range; and the `-` closing a range cannot open the next.
    assert.equal(out('echo [a\\-[:bogus:]x]', t), '- a x\n')
    assert.equal(out('echo [-[:bogus:]x]', t), '- x\n')
    assert.equal(out('echo [a-c-[:bogus:]]', t), '- a b c\n')
    // Ordinary ranges are untouched.
    assert.equal(out('echo [a-c]', t), 'a b c\n')
    assert.equal(out('echo []-x]', t), 'a b c x\n')
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
  it('a stage of nothing but redirects is the null command: it performs them, and nothing else', () => {
    const t = term()
    // Status 0 on its own, and the `!` in front of one negates that to
    // 1 — bash's redirected empty pipeline, not a syntax error.
    assert.equal(out('>/dev/null; echo rc=$?', t), 'rc=0\n')
    assert.equal(out('! >/dev/null; echo rc=$?', t), 'rc=1\n')
    assert.equal(out('! >/dev/null || echo fallback', t), 'fallback\n')
    assert.equal(out('! 2>&1; echo rc=$?', t), 'rc=1\n')
    assert.equal(out('{ >/dev/null; }; echo rc=$?', t), 'rc=0\n')
    assert.equal(out('(>/dev/null); echo rc=$?', t), 'rc=0\n')
    assert.equal(out('for i in 1 2; do >/dev/null; done; echo rc=$?', t), 'rc=0\n')
    assert.equal(out('echo a | >/dev/null; echo rc=$?', t), 'rc=0\n')
    // The redirect is really performed: one that fails reports and
    // takes status 1, which `!` in turn negates to 0.
    const missing = t.run('< nope; echo rc=$?')
    assert.equal(missing.stdout, 'rc=1\n')
    assert.match(missing.stderr, /nope: No such file or directory/u)
    assert.equal(out('! < nope 2>/dev/null; echo rc=$?', t), 'rc=0\n')
    // A stage with nothing at all in it is still the empty one — and
    // `|&` must not disguise one, since its `2>&1` is the operator's
    // redirect rather than a null command the user wrote.
    for (const line of ['echo a | | wc -l', 'echo a &&', '()', '{ }', '|& echo hi', '{ |& echo hi; }', '! |& echo hi']) {
      assert.equal(t.run(line).exitCode, 2, line)
    }
    // `|&` after a real null command is still fine.
    assert.equal(out('>/dev/null |& cat; echo rc=$?', t), 'rc=0\n')
    assert.equal(out('cat nope |& wc -l', t), '1\n')
  })

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

  it('a backslash-newline in an unquoted here-document joins physical lines, the delimiter line too', () => {
    assert.equal(out('cat <<EOF\nhi\nEO\\\nF\necho after'), 'hi\nafter\n')
    assert.equal(out('cat <<EOF\n\\\nEOF\necho after'), 'after\n')
    assert.equal(out('cat <<EOF\na\\\\\nb\nEOF'), 'a\\\nb\n')
    assert.equal(out('cat <<EOF\na\\\\\\\nb\nEOF'), 'a\\b\n')
    assert.equal(out('cat <<-EOF\n\ta\\\n\tb\n\tEOF'), 'a\tb\n')
    assert.equal(out("cat <<'EOF'\nhi\nEO\\\nF\nEOF\necho after"), 'hi\nEO\\\nF\nafter\n')
  })

  it('`/dev/stdin` is the input as redirected so far, left to right', () => {
    assert.equal(out('echo -n pipe | cat <b.txt </dev/stdin'), 'B\n')
    assert.equal(out('echo -n pipe | cat </dev/stdin <b.txt'), 'B\n')
    assert.equal(out('echo -n pipe | cat </dev/stdin'), 'pipe')
  })

  it('a write into a closed stdout fails as each real command fails; a closed stderr is silent', () => {
    assert.equal(out('echo hi >&- || echo fallback'), 'fallback\n')
    const e = term().run('echo hi >&-')
    assert.deepEqual([e.stdout, e.stderr, e.exitCode], ['', 'echo: write error: Bad file descriptor\n', 1])
    assert.equal(term().run('cat a.txt >&-').exitCode, 1)
    assert.equal(term().run('ls >&-').exitCode, 2)
    assert.equal(term().run('grep x a.txt >&-').exitCode, 2)
    assert.equal(term().run('echo hi | cat >&-').exitCode, 1)
    assert.equal(term().run('for i in 1 2; do echo $i; done >&-').exitCode, 1)
    const group = term().run('{ echo a; echo b; } >&-')
    assert.deepEqual([group.stderr, group.exitCode], ['echo: write error: Bad file descriptor\n'.repeat(2), 1])
    assert.equal(term().run('{ echo a >&2; } 2>&-').exitCode, 1)
    // Nothing written, or written elsewhere: no error.
    for (const line of ['true >&-', 'echo -n "" >&-', 'echo hi >&- >/dev/null', 'cd src >&-', 'cat a.txt 2>&-']) {
      assert.equal(term().run(line).exitCode, 0, line)
    }
    assert.equal(out('cat nope 2>&-; echo $?'), '1\n')
    // Duplicating a closed descriptor is bash's own error.
    const dup = term().run('echo hi >&- 2>&1')
    assert.deepEqual([dup.stderr, dup.exitCode], ['error: 1: Bad file descriptor\n', 1])
  })

  it('an assignment-only command still binds when its redirect fails, as bash binds it', () => {
    const t = term()
    assert.equal(out('x=old; x=new <missing; echo "$x [$?]"', t), 'new [1]\n')
    assert.equal(out('x=old; e=; x=new $e <missing; echo $x', t), 'new\n')
    assert.equal(out('x=old; x=new y=$x <<< hi <missing; echo $x $y', t), 'new new\n')
    assert.match(term().run('x=new <missing').stderr, /^error: missing: No such file or directory/u)
    // Not through a subshell or a group, and not a command's own prefix.
    assert.equal(out('x=old; x=new <missing | cat; echo $x', t), 'old\n')
    assert.equal(out('x=old; { x=new; } <missing; echo $x', t), 'old\n')
    assert.equal(out('x=old; x=new cat <missing; echo $x', t), 'old\n')
  })

  it('the substitutions this shell lacks are refused inside an unquoted here-document too', () => {
    assert.deepEqual(gaps('cat <<EOF\n$(echo owned)\nEOF'), ['feature:$('])
    assert.deepEqual(gaps('cat <<EOF\n`echo owned`\nEOF'), ['feature:`'])
    assert.deepEqual(gaps('cat <<EOF\n$((1+2))\nEOF'), ['feature:$(('])
    assert.deepEqual(gaps('x=5; cat <<EOF\n${x:-y}\nEOF'), ['feature:${'])
    const r = term().run('cat <<EOF\n$(echo owned)\nEOF')
    assert.deepEqual([r.stdout, r.exitCode], ['', 1])
    // Escaped, under a quoted delimiter, or a plain dollar: text.
    assert.equal(out('cat <<EOF\n\\$(echo kept) \\`x\\` \\${x:-y}\nEOF'), '$(echo kept) `x` ${x:-y}\n')
    assert.equal(out("cat <<'EOF'\n$(echo owned) `x` $((1)) ${x:-y}\nEOF"), '$(echo owned) `x` $((1)) ${x:-y}\n')
    assert.equal(out('x=5; cat <<EOF\n$x ${x}z $ (x) price $5 and $\nEOF'), '5 5z $ (x) price  and $\n')
  })

  it('an output target with a glob or a brace is expanded before it is checked', () => {
    const t = createTerminal({ 'dev/stdout': '', 'dev/null': '' })
    assert.equal(out('echo hi >/dev/std*', t), 'hi\n')
    assert.equal(out('echo hi >/dev/nu*; echo $?', t), '0\n')
    assert.equal(out('echo hi >/dev/nul?', t), '')
    assert.equal(out('echo hi >/dev/[n]ull', t), '')
    assert.match(t.run('echo hi >/dev/{null,zero}').stderr, /ambiguous redirect/u)
    // No match, or quoted: the literal name, a real file, and so a gap.
    assert.deepEqual(gaps('echo hi >/dev/nope*', t), ['feature:>'])
    assert.deepEqual(gaps('echo hi >"/dev/nu*"', t), ['feature:>'])
  })

  it('a real file target is refused with a gap; unusual descriptors are gaps or errors as in bash', () => {
    assert.deepEqual(gaps('echo hi > out.txt'), ['feature:>'])
    assert.deepEqual(gaps('echo hi 3>/dev/null'), ['feature:3>'])
    // Bash opens these for reading on that descriptor; only fd 0 is modeled.
    assert.deepEqual(gaps('cat 2<<< x'), ['feature:2<<<'])
    assert.deepEqual(gaps('cat 2<<END\nbody\nEND'), ['feature:2<<'])
    assert.deepEqual(gaps('cat 2<a.txt'), ['feature:2<'])
    assert.equal(out('cat 0<<< x'), 'x\n')
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
    // The first argument is checked before the count of them, as bash checks; `--` is skipped.
    const first = term().run('exit nope 1')
    assert.deepEqual([first.stderr, first.exitCode], ['exit: nope: numeric argument required\n', 2])
    const many = term().run('exit 1 nope')
    assert.deepEqual([many.stderr, many.exitCode], ['exit: too many arguments\n', 1])
    for (const [line, code] of [['exit -- 3', 3], ['exit --', 0], ['exit -x', 2], ['exit -- -1 2', 1]]) {
      assert.equal(term().run(line).exitCode, code, line)
    }
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
    // A `!` on its own is bash's empty negated pipeline: status 1, a
    // complete command, so the next line is not the thing negated.
    assert.equal(out('!\necho $?'), '1\n')
    assert.equal(out('!\ntrue; echo $?'), '0\n')
    assert.equal(out('! !\necho $?'), '0\n')
    assert.equal(out('!; echo $?'), '1\n')
    assert.equal(out('{ !\n}; echo $?'), '1\n')
    assert.equal(out('for i in 1; do !; done; echo $?'), '1\n')
    assert.equal(term().run('!').exitCode, 1)
    for (const line of ['! | cat', '! && echo yes', '( ! )', '{ echo a; ! }']) assert.equal(term().run(line).exitCode, 2, line)
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
  it('commands in a group share its standard input; a reader takes what it reads', () => {
    assert.equal(out('echo hi | { echo x; cat; }'), 'x\nhi\n')
    assert.equal(out('echo hi | { cat; cat; }'), 'hi\n')
    assert.equal(out('echo -n abc | { head -c 1; cat; }'), 'abc')
    assert.equal(out('echo hi | { cat b.txt; cat; }'), 'B\nhi\n')
    assert.equal(out('echo hi | { cat <b.txt; cat; }'), 'B\nhi\n')
    assert.equal(out('echo hi | { cat <<< x; cat; }'), 'x\nhi\n')
    assert.equal(out('echo hi | { echo x | cat; cat; }'), 'x\nhi\n')
    assert.equal(out('echo hi | { cat | cat; cat; }'), 'hi\n')
    assert.equal(out('echo hi | { (cat); cat; }'), 'hi\n')
    assert.equal(out('echo hi | { { cat; }; cat; }'), 'hi\n')
    assert.equal(out('echo hi | for i in 1 2; do echo $i; cat; done'), '1\nhi\n2\n')
    assert.equal(out('echo hi | { seq 1; cat; }'), '1\nhi\n')
    assert.equal(out('echo hi | { head -n1 b.txt; cat; }'), 'B\nhi\n')
    // Every reader consumes what it reads from the shared input…
    for (const line of ['grep h', 'wc -l', 'tr a b', 'xargs echo', 'awk 1', 'sort', 'tail -n1', 'hexdump -C', 'nl']) {
      assert.equal(out(`echo hi | { ${line} >/dev/null; cat; }`), '', line)
    }
    assert.equal(out('echo hi | { grep h b.txt; cat; }'), 'hi\n')
    // …and a command that never reads it leaves it be.
    for (const line of ['ls >/dev/null', 'true', 'x=1', 'cd .', 'find . -name nope', 'hexdump -C b.txt >/dev/null', 'echo -n']) {
      assert.equal(out(`echo hi | { ${line}; cat; }`), 'hi\n', line)
    }
    // A regular file seeks back to where head stopped; a pipe does not.
    assert.equal(out('{ head -n1; cat; } < a.txt'), 'x y z\nhello world\n')
    assert.equal(out('{ head -c 1; cat; } < a.txt'), 'x y z\nhello world\n')
    assert.equal(out('cat a.txt | { head -n1; cat; }'), 'x y z\n')
  })

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

  it('`export --` ends option processing, as `help export` specifies', () => {
    const t = term()
    assert.equal(out('export -- x=1; echo $x', t), '1\n')
    assert.equal(out('export -- a=1 b=2; echo $a$b', t), '12\n')
    assert.equal(out('x=5; export -- x; echo $x', t), '5\n')
    assert.equal(out('export -- x=--; echo [$x]', t), '[--]\n')
    assert.deepEqual(gaps('export -- x=1', t), [])
    // After it, a word that looks like an option is a name — and a bad
    // one. `--` on its own still asks for the listing there is not.
    assert.match(t.run('export -- -p').stderr, /`-p': not a valid identifier/u)
    assert.match(t.run('export -- --').stderr, /`--': not a valid identifier/u)
    assert.deepEqual(gaps('export --', t), ['option:-p'])
    assert.deepEqual(gaps('export -p', t), ['option:-p'])
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

  it('repeated `-` operands share one standard input: the second finds it at end of file', () => {
    assert.equal(out('echo -n x | cat - -'), 'x')
    assert.equal(out('echo a | cat - b.txt -'), 'a\nB\n')
    assert.equal(out('echo a | cat - - < b.txt'), 'B\n')
    assert.equal(out('echo a | grep a - -'), '(standard input):a\n')
    assert.equal(out('echo a | grep -c a - -'), '(standard input):1\n(standard input):0\n')
    assert.equal(out('echo a | head -n1 - -'), '==> standard input <==\na\n\n==> standard input <==\n')
    assert.equal(out("echo a | awk '{ print FILENAME, $0 }' - -"), '- a\n')
  })

  it('`/dev/stdin` names the standard input too; on a regular file it reopens from the start', () => {
    assert.equal(out('echo hi | cat /dev/stdin'), 'hi\n')
    assert.equal(out('echo hi | cat - /dev/stdin'), 'hi\n')
    assert.equal(out('echo hi | cat /dev/stdin /dev/stdin'), 'hi\n')
    assert.equal(out('echo a | grep -H a /dev/stdin'), '/dev/stdin:a\n')
    assert.equal(out('echo a | grep -c a /dev/stdin /dev/stdin'), '/dev/stdin:1\n/dev/stdin:0\n')
    assert.equal(out('echo a | wc -l /dev/stdin'), '1 /dev/stdin\n')
    assert.equal(out('cat /dev/stdin /dev/stdin < b.txt'), 'B\nB\n')
    assert.equal(out('cat - /dev/stdin < b.txt'), 'B\nB\n')
  })

  it('head leaves the standard input where GNU head leaves it for the next `-`', () => {
    const banners = (a, b) => `==> standard input <==\n${a}\n==> standard input <==\n${b}`
    // `-c N` on a pipe reads exactly N bytes.
    assert.equal(out('echo -n abc | head -c 1 - -'), banners('a', 'b'))
    assert.equal(out('echo -n abc | head -c 1 - - -'), `${banners('a', 'b')}\n==> standard input <==\nc`)
    assert.equal(out('echo -n abc | head -qc 1 - -'), 'ab')
    assert.equal(out('echo -n abc | head -c 5 - -'), banners('abc', ''))
    assert.equal(out('echo -n abc | head -c 1 /dev/stdin -'), '==> /dev/stdin <==\na\n==> standard input <==\nb')
    // `-n N` on a regular file seeks back to the end of line N; a pipe,
    // a here-string or a here-document is read in whole buffers.
    assert.equal(out('head -n1 - - < a.txt'), banners('x y z\n', 'hello world\n'))
    assert.equal(out('cat a.txt | head -n1 - -'), banners('x y z\n', ''))
    assert.equal(out('head -n1 - - <<< "x y z"'), banners('x y z\n', ''))
    assert.equal(out('head -c 1 - - < a.txt'), banners('x', ' '))
    assert.equal(out('head -n -1 - - < a.txt'), banners('x y z\n', ''))
    assert.equal(out('head -n1 /dev/stdin - < a.txt'), '==> /dev/stdin <==\nx y z\n\n==> standard input <==\nx y z\n')
    // A group, a subshell and a loop hand their own input on.
    assert.equal(out('{ head -n1 - -; } < a.txt'), banners('x y z\n', 'hello world\n'))
    assert.equal(out('(head -n1 - -) < a.txt'), banners('x y z\n', 'hello world\n'))
    assert.equal(out('for i in 1; do head -n1 - -; done < a.txt'), banners('x y z\n', 'hello world\n'))
    assert.equal(out('cat a.txt | { head -n1 - -; }'), banners('x y z\n', ''))
    // tail reads to the end.
    assert.equal(out('echo -n abc | tail -c 1 - -'), banners('c', ''))
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
