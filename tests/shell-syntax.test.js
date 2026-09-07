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
    assert.equal(out('echo ~ ~/src "~" x~'), '/ /src ~ x~\n')
    assert.equal(out('cd src; cd ~; pwd'), '/\n')
    assert.equal(out('ls ~/src'), 'bar.ts\nfoo.js\n')
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
    assert.equal(out('! cat nope 2>/dev/null && echo negated'), 'negated\n')
    assert.equal(out('{ echo a; echo b; } | cat'), 'a\nb\n')
    assert.equal(out('{ cd src; }; pwd'), '/src\n')
    assert.equal(out('(cd src); pwd'), '/\n')
    assert.match(term().run('{ echo a }').stderr, /unmatched `\{`/u)
    assert.match(term().run('}').stderr, /syntax error near unexpected token `\}`/u)
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
})
