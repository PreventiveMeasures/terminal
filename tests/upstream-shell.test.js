import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Independently expressed examples informed by the pinned upstream specifications:
// Oils (Apache-2.0), spec/{command-sub,if_,quote,word-split,here-doc,exit-status,redirect,assign}.test.sh
// https://github.com/oils-for-unix/oils/tree/f5bd5d9c8dfe625e73aa47f5ce7993060e70a2c1/spec
// GNU Bash (GPL-3.0-or-later), tests/comsub.tests; no Bash fixture text is vendored.
// https://git.savannah.gnu.org/cgit/bash.git/tree/tests/comsub.tests?id=b460816602167718f78a6233164e8875f49b75b2
// The custom `args` command observes argument boundaries without a reference shell.

const FILES = { input: 'amber\nblue\n', 'dir/a.txt': 'a\n', 'dir/b.txt': 'b\n' }
const terminal = () => createTerminal(FILES, { commands: { args: ({ args }) => JSON.stringify(args) + '\n' } })

// Bash read_a_line() appends a newline to a nonempty final line; immediate
// EOF supplies no record. make_here_document() warns about a missing delimiter.
// https://git.savannah.gnu.org/cgit/bash.git/tree/make_cmd.c?h=bash-5.2
describe('Bash here-document EOF handling', () => {
  for (const [suffix, stdout] of [['', ''], ['\n', ''], ['\ntext', 'text\n'], ['\ntext\n', 'text\n'], ['\n\n', '\n'], ['\n\\\n', ''], ['\ntext\\\n', 'text\n']]) {
    it(`does not invent a record at EOF: ${JSON.stringify(suffix)}`, () => {
      assert.deepEqual(terminal().run('cat <<END' + suffix), {
        stdout, stderr: "warning: here-document delimited by end-of-file (wanted `END')\n",
        exitCode: 0, cwd: '/', notes: [], unsupported: [],
      })
    })
  }
  it('warns before applying command redirects', () => {
    const result = terminal().run('cat <<END 2>/dev/null | head -1\ntext\n')
    assert.equal(result.stdout, 'text\n')
    assert.match(result.stderr, /here-document.*end-of-file/u)
    assert.deepEqual(result.unsupported, [])
  })
  it('accepts a delimiter without a final newline', () => {
    assert.deepEqual(terminal().run('cat <<END\ntext\nEND'), {
      stdout: 'text\n', stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [],
    })
  })
  for (const separator of ['\n', ';\n', '; # comment\n']) {
    it(`keeps earlier commands before a later heredoc warning: ${JSON.stringify(separator)}`, () => {
      const result = terminal().run('echo before >&2' + separator + 'cat <<END\ntext\n')
      assert.equal(result.stdout, 'text\n')
      assert.equal(result.stderr, "before\nwarning: here-document delimited by end-of-file (wanted `END')\n")
      assert.deepEqual(result.unsupported, [])
    })
  }
  it('warns before commands on the same input line', () => {
    const result = terminal().run('echo before >&2; cat <<END\ntext\n')
    assert.equal(result.stdout, 'text\n')
    assert.equal(result.stderr, "warning: here-document delimited by end-of-file (wanted `END')\nbefore\n")
  })
  it('warns about skipped commands without changing their gate status', () => {
    const result = terminal().run('false && cat <<END\ntext\n')
    assert.equal(result.exitCode, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /here-document.*end-of-file/u)
  })
  it('does not warn about input after exit on an earlier line', () => {
    assert.deepEqual(terminal().run('exit 7\ncat <<END\ntext\n'), {
      stdout: '', stderr: '', exitCode: 7, cwd: '/', notes: [], unsupported: [],
    })
  })
})

function cases(rows) {
  for (const [name, command, stdout, exitCode = 0, stderr = ''] of rows) {
    it(name, () => {
      assert.deepEqual(terminal().run(command), { stdout, stderr, exitCode, cwd: '/', notes: [], unsupported: [] }, command)
    })
  }
}

function words(rows) {
  cases(rows.map(([name, command, args]) => [name, command, JSON.stringify(args) + '\n']))
}

// Bash ansicstr() consumes a doubled backslash after \c, after the parser
// has already located the quote's end independently of escape decoding.
// https://git.savannah.gnu.org/cgit/bash.git/tree/lib/sh/strtrans.c?h=bash-5.2
describe('ANSI-C source boundaries and control escapes', () => {
  words([
    ['control backslash consumes a doubled source backslash', String.raw`args $'\c\\'`, ['\u001C']],
    ['control backslash retains its suffix', String.raw`args $'\c\\x'`, ['\u001Cx']],
    ['escaped quote after a control backslash is data', String.raw`args $'\c\''`, ["\u001C'"]],
    ['escaped quote does not end a control string', String.raw`args $'\c\' rest'`, ["\u001C' rest"]],
    ['a terminal control introducer stays literal', String.raw`args $'\c'`, ['\\c']],
    ['control quoting inside command substitution', String.raw`args "$(printf '%s' $'\c\\')"`, ['\u001C']],
  ])
  cases([
    ['ANSI-C control backslash forms a heredoc delimiter', String.raw`cat <<$'\c\\'` + '\ntext\n\u001C\n', 'text\n'],
  ])
  it('does not let control decoding close an unterminated source quote', () => {
    const result = terminal().run(String.raw`args $'\c\'`)
    assert.equal(result.exitCode, 2)
    assert.match(result.stderr, /unterminated single quote/u)
    assert.deepEqual(result.unsupported, [])
  })
})

describe('upstream shell audit — quoting and word splitting', () => {
  words([
    ['adjacent quoting fragments form one argument', `args pre' two'" three "post`, ['pre two three post']],
    ['single quotes retain embedded line breaks', "args 'first\nsecond'", ['first\nsecond']],
    ['unquoted escapes do not become operators', String.raw`args \$ \| \; \( \) \\`, ['$', '|', ';', '(', ')', '\\']],
    ['double quotes retain ordinary backslashes', String.raw`args "\q\n\t"`, ['\\q\\n\\t']],
    ['literal dollars next to quotes stay literal', `args $ "$" '$'`, ['$', '$', '$']],
    ['backslash values are not parsed again', String.raw`a='\'; b='\\'; args $a "$a" $b "$b"`, ['\\', '\\', '\\\\', '\\\\']],
    ['unquoted expansion joins a quoted suffix to the last field', `a='red blue'; b=' green white'; args $a"$b"`, ['red', 'blue green white']],
    ['alternating quoted and unquoted expansions preserve field boundaries', `a='1 2'; b='3 4'; c='5 6'; d='7 8'; args $a"$b"$c"$d"`, ['1', '23 45', '67 8']],
    ['a quoted empty suffix keeps a whitespace-only expansion', `a=' '; args before $a"" after`, ['before', '', 'after']],
    ['unquoted whitespace-only words disappear', `a=' '; args before $a after`, ['before', 'after']],
    ['a quoted empty prefix stays before a leading separator', `a=' blue'; args ""$a`, ['', 'blue']],
    ['empty positional parameter forms differ', `args a "$@" b $@ c "$*" d $* e`, ['a', 'b', 'c', '', 'd', 'e']],
    ['empty IFS disables expansion splitting', `IFS=''; a=' red blue '; args $a`, [' red blue ']],
    ['unsetting IFS restores whitespace splitting', `IFS=''; unset IFS; a=' red blue '; args $a`, ['red', 'blue']],
    ['tilde output is quoted before field splitting', `HOME='space home'; args ~ $HOME`, ['space home', 'space', 'home']],
    ['assignment values do not split or expand wildcards', `a='dir/*.txt two'; b=$a; args "$b"`, ['dir/*.txt two']],
    ['quoted assignment fragments join without expansion', `a='red '"blue"; args "$a"`, ['red blue']],
    ['expansion output does not become quote syntax', String.raw`a="'red blue'"; args $a`, ["'red", "blue'"]],
  ])

  cases([
    ['a continued special parameter follows Bash semantics', 'false; echo $\\\n?', '1\n'],
    ['a continued parameter inside quotes stays active', 'false; echo "$\\\n?"', '1\n'],
    ['a literal prefix survives a continued dollar', 'echo word\\\n$', 'word$\n'],
    ['ANSI-C octal escapes consume at most three digits', String.raw`printf '%s' $'\1012\7x'`, 'A2\u0007x'],
    ['ANSI-C short hexadecimal escapes keep the suffix', String.raw`printf '%s' $'\x4z\x41Q'`, '\u0004zAQ'],
    ['ANSI-C control escapes mask digits and punctuation', String.raw`printf '%s' $'\c2\c8\c+\c-\c"'`, '\u0012\u0018\u000B\u000D\u0002'],
    ['ANSI-C control letters are case insensitive', String.raw`printf '%s' $'\cb\cB\cy\cY'`, '\u0002\u0002\u0019\u0019'],
    ['ANSI-C question mark denotes DEL', String.raw`printf '%s' $'\c?'`, '\u007F'],
    ['ANSI-C control NUL ends the quoted value', String.raw`printf '%s' pre$'x\c@y'post`, 'prexpost'],
    ['locale-style quotes still allow substitutions', 'x=seen; echo $"[$x]"', '[seen]\n'],
  ])
})

describe('upstream shell audit — command substitution', () => {
  words([
    ['substitution fragments can build the command name', `$(printf ar)$(printf gs) red blue`, ['red', 'blue']],
    ['quoted substitutions retain interior but strip trailing newlines', String.raw`args "$(printf 'red\nblue\n\n')"`, ['red\nblue']],
    ['trailing spaces stop newline stripping', String.raw`args "$(printf 'red\nblue\n ')"`, ['red\nblue\n ']],
    ['unquoted substitution words join literal edges', `args left$(printf 'red blue')right`, ['leftred', 'blueright']],
    ['multiple substitutions retain separate split boundaries', `args $(printf 'red blue')$(printf 'green white')`, ['red', 'bluegreen', 'white']],
    ['nested double quotes have independent scope', `args "left $(printf '%s' "red blue") right"`, ['left red blue right']],
    ['inner escaped quotes become output characters', String.raw`args "$(printf '%s' \"blue\")"`, ['"blue"']],
    ['comment parentheses do not terminate substitutions', 'args "$(printf red # ) ignored\nprintf blue)"', ['redblue']],
    ['captured glob characters expand only outside quotes', `args $(printf 'dir/*.txt') "$(printf 'dir/*.txt')"`, ['dir/a.txt', 'dir/b.txt', 'dir/*.txt']],
    ['empty command substitutions can occupy word fragments', `args before$()after "$()" $()`, ['beforeafter', '']],
    ['nested empty substitutions do not add words', `args "$(printf '%s' "$(printf '%s' "")")"`, ['']],
    ['a substitution preserves a single-quoted backslash-newline', "args \"$(printf '%s' 'red\\\nblue')\"", ['red\\\nblue']],
  ])
  cases([
    ['assignment and ordinary command statuses differ', 'echo "$(printf piece; exit 17)"; echo $?; x=$(printf piece; exit 17); echo "$? $x"', 'piece\n0\n17 piece\n'],
    ['an empty command uses substitution status', '$(false); echo $?; $(true); echo $?', '1\n0\n'],
    ['the last empty substitution determines nameless status', '$(exit 19) $(exit 23); echo $?', '23\n'],
    ['an ordinary command overrides failed expansion status', 'true $(false); echo $?', '0\n'],
    ['assignment substitutions isolate variables and working directory', 'x=outer; y=$(x=inner; cd dir; echo "$x:$PWD"); echo "$x:$y:$PWD"', 'outer:inner:/dir:/\n'],
    ['a heredoc inside substitution is captured and split', 'echo $(<<HERE tac\nred\nblue\nHERE\n)', 'blue red\n'],
    ['GNU Bash multiline nesting retains only command output', 'echo "$(\nprintf left\necho "$(\nprintf middle\n)"\nprintf right\n)"', 'leftmiddle\nright\n'],
    ['GNU Bash multiline empty substitution is empty', 'echo "before$(\n)after"', 'beforeafter\n'],
  ])
})

describe('upstream shell audit — conditionals and assignments', () => {
  cases([
    ['an empty successful substitution selects then', 'if $(true); then echo chosen; else echo lost; fi', 'chosen\n'],
    ['an empty failed substitution selects else', 'if $(false); then echo lost; else echo chosen; fi', 'chosen\n'],
    ['substitution output is a command in the condition', 'if $(printf false); then echo lost; else echo chosen; fi', 'chosen\n'],
    ['elif evaluates its command list through its final status', 'if false; then echo lost; elif echo checked; true; then echo chosen; fi', 'checked\nchosen\n'],
    ['an unselected branch does not expand unsupported commands', 'if true; then echo chosen; else echo "$(read missing)"; fi', 'chosen\n'],
    ['condition assignments persist after the branch', 'if x=first; false; then echo lost; else x=second; fi; echo "$x"', 'second\n'],
    ['a false conditional with no branch succeeds', 'if false; then echo lost; fi; echo $?', '0\n'],
    ['condition substitution failure retains assignment output', 'if x=$(printf found; false); then echo lost; else echo "$x"; fi', 'found\n'],
    ['later prefix assignments can read earlier ones', 'a=old; a=red b="$a blue"; echo "$a:$b"', 'red:red blue\n'],
    ['command words expand before temporary prefix assignments', 'x=old; x=new echo "$x"; echo "$x"', 'old\nold\n'],
    ['export preserves assignment whitespace', 'x="red blue"; export y=$x; echo "$y"', 'red blue\n'],
    ['conditional negation does not lose assignment state', 'if ! x=retained; then echo lost; fi; echo "$x"', 'retained\n'],
  ])
})

describe('upstream shell audit — heredocs and redirection', () => {
  cases([
    ['the final heredoc wins', 'cat <<FIRST <<SECOND\nignored\nFIRST\nchosen\nSECOND', 'chosen\n'],
    ['a file redirect after a heredoc wins', 'cat <<HERE <input\nignored\nHERE', 'amber\nblue\n'],
    ['a heredoc after a file redirect wins', 'cat <input <<HERE\nchosen\nHERE', 'chosen\n'],
    ['quoted delimiter fragments disable body expansion', 'x=expanded; cat <<\'HE\'"RE"\n$x\nHERE', '$x\n'],
    ['heredoc expansion does not remove double quotes or ordinary backslashes', 'cat <<HERE\n\\\\ \\" \\$ \\x\nHERE', '\\ \\" $ \\x\n'],
    ['tabs strip without stripping spaces', 'cat <<-HERE\n\tred\n\t\tblue\n  green\n\tHERE', 'red\nblue\n  green\n'],
    ['a pipeline can continue after the heredoc body', 'cat <<HERE |\nred\nblue\nHERE\ntac', 'blue\nred\n'],
    ['a heredoc can precede the command name', '<<HERE tac\nred\nblue\nHERE', 'blue\nred\n'],
    ['a multiline argument before the body is retained', 'cat <<HERE; echo "red\nblue"\nfirst\nHERE', 'first\nred\nblue\n'],
    ['condition heredocs do not swallow the then branch', 'if cat <<HERE; then\nchecked\nHERE\necho chosen\nfi', 'checked\nchosen\n'],
    ['nested heredocs in substitutions keep separate delimiters', 'cat <<-OUTER\n\toutside\n\t$(cat <<-INNER\n\t\tinside\nINNER\n)\nOUTER', 'outside\ninside\n'],
    ['heredoc redirection to stderr preserves exact output', 'cat <<HERE 1>&2\nredirected\nHERE', '', 0, 'redirected\n'],
    ['a redirection-only command resets status', 'false; 2>&1; echo $?', '0\n'],
    ['descriptor-like arguments separated by blanks stay arguments', 'echo red 1 >&2', '', 0, 'red 1\n'],
    ['input duplication syntax can duplicate output descriptors', 'echo red 1<&2', '', 0, 'red\n'],
    ['group redirection retains existing stderr routing', '{ echo red >&2; echo blue; } >/dev/null', '', 0, 'red\n'],
    ['redirection errors do not leak into the next command', 'echo lost <missing; echo kept', 'kept\n', 0, 'error: missing: No such file or directory\n'],
  ])
})

describe('upstream shell audit — arithmetic, parameter operators and conditionals', () => {
  cases([
    ['arithmetic substitution', 'echo "$((2 + 3))"', '5\n'],
    ['default parameter expansion', 'echo "${missing:-fallback}"', 'fallback\n'],
    ['parameter length', 'x=value; echo "${#x}"', '5\n'],
    ['extended conditional', 'if [[ x = x ]]; then echo chosen; fi', 'chosen\n'],
  ])
})

describe('upstream shell audit — explicit unsupported constructs', () => {
  const rows = [
    ['legacy substitution', 'echo `printf value`', '`'],
    ['case pattern syntax in substitution', 'echo "$(case word in word) echo yes;; esac)"', 'case'],
    ['custom IFS', 'IFS=:; x=red:blue; echo $x', 'IFS'],
    ['shell function declaration', 'show() { echo value; }; show', 'function'],
    ['arithmetic conditional', 'if (( 0 )); then echo lost; fi', '(('],
    ['while loop', 'while false; do echo lost; done', 'while'],
    ['heredoc on another descriptor', 'cat 3<<HERE\nvalue\nHERE', '3<<'],
    ['read-write redirection', 'cat <>input', '<>'],
    ['dynamic descriptor target', 'fd=2; echo value >&$fd', 'redirect target'],
    ['non-ASCII ANSI-C control escape', String.raw`echo $'\cé'`, 'ANSI-C control escape'],
    ['braced ANSI-C hexadecimal escape', String.raw`echo $'\x{41}'`, 'ANSI-C hexadecimal escape'],
  ]
  for (const [name, command, detail] of rows) {
    it(name, () => {
      const r = terminal().run(command)
      assert.equal(r.stdout, '', command)
      assert.notEqual(r.stderr, '', command)
      assert.notEqual(r.exitCode, 0, command)
      assert.ok(r.unsupported.some((note) => note.detail === detail), JSON.stringify(r))
    })
  }

  it('retains a builtin gap from a failed condition when stderr is discarded', () => {
    const r = terminal().run('if read value; then echo lost; else echo kept; fi 2>/dev/null')
    assert.equal(r.stdout, 'kept\n')
    assert.equal(r.stderr, '')
    assert.equal(r.exitCode, 0)
    assert.deepEqual(r.unsupported.map(({ kind, detail }) => [kind, detail]), [['feature', 'read']])
  })

  it('retains a gap from a captured command even when the result is discarded', () => {
    const r = terminal().run('{ echo "$(local x=one)" | true; } 2>/dev/null')
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '')
    assert.equal(r.exitCode, 0)
    assert.deepEqual(r.unsupported.map(({ kind, detail }) => [kind, detail]), [['feature', 'local']])
  })
})
