# The parser

Every line a terminal runs it reads first, and the reading is available on its
own: `parse(line)` hands back the commands a line holds and runs none of them,
`summarize(line)` is the short answer for a line that stays simple, and
`@preventive/terminal/parse.js` publishes both for a caller with no terminal at
all.

## Reading a line before running it

`parse(line)` reads and no more: nothing runs, nothing changes — not the
working directory, the variables, or the overlay — and you get back the
commands the line holds.

```js
terminal.parse('sort input | uniq -c')
// { ok: true, incomplete: false, error: null, unsupported: [], list: [
//   { type: 'pipeline', stages: [
//     { type: 'command', argv: ['sort', 'input'] },
//     { type: 'command', argv: ['uniq', '-c'] },
//   ] } ] }

terminal.parse('for f in src/*.js; do').incomplete   // true — ask for another line
terminal.parse('echo )').error                       // 'unexpected `)`'
terminal.parse('while :; do echo x; done').unsupported[0].detail  // 'while'
```

`list` is the whole line: each command carries the `op` that joins it to the
one before (`;`, `&&`, `||`, and a newline reads as `;`), its `argv`, and
whatever else it has — `assignments`, `redirects`, a `negate` for `!`, a
`background` for the `&` that ends it.
Pipelines, subshells, `{ …; }` groups, `for` loops, `if` branches and
`[[ … ]]` tests are nodes of their own, each named by `type`. A field that
would only say "nothing here" is left out, and a line that fails partway still
carries the commands ahead of the error.

Values are plain text wherever the text is final, and a word in pieces only
where expansion still decides it — so reading arguments takes no knowledge of
quoting:

```js
terminal.parse('grep -rn "$pattern" src/*.js').list[0].argv
// [ 'grep', '-rn',
//   { type: 'variable', name: 'pattern', quoted: true },
//   { type: 'pattern', pattern: 'src/*.js' } ]
```

`'*'` is the string `*`, because quoting settled it; `*.js` is a pattern,
because the filesystem has yet to. A piece is a plain string once nothing can
change it; otherwise it names what it waits for — `pattern`, `variable`,
`substitution`, `arithmetic`. A word of several pieces is a `parts` node
holding them in order, and a word of one piece is that piece.

A `~` is the home directory under another spelling, so it reads as the one it
shares: `~/bin` is `"$HOME/bin"`, quoted because tilde expansion is no more
split into fields or matched as a pattern than a quoted reference is.

```js
terminal.parse('ls ~/bin').list[0].argv
// [ 'ls', { type: 'parts', parts: [
//   { type: 'variable', name: 'HOME', quoted: true }, '/bin' ] } ]
```

A prefix stands where bash finds one — opening a word, or an assignment
component after `=` or a bare `:` — and a quote anywhere in it leaves the text
alone, so `a~b`, `~"/bin"` and `~''/bin` are the paths they spell. `~alice`
names someone else's home, and this shell has no users to look one up in, so a
word holding one is refused rather than read as the text bash would have
expanded:

```js
terminal.parse('ls ~alice/bin').error
// 'named-user and directory-stack tilde prefixes are not supported'
```

Braces need nothing but the text, so they are already expanded: `ls a{b,c}`
reads as `['ls', 'ab', 'ac']`, exactly as bash reads it before anything else
happens. A substitution holds the commands it runs, parsed the same way:

```js
terminal.parse('foo `bar a b c`').list[0].argv[1]
// { type: 'substitution', list: [ { type: 'command', argv: ['bar', 'a', 'b', 'c'] } ] }
```

## Without a terminal

The parser is published separately, for a caller with no source tree to mount:

```js
import { parse } from '@preventive/terminal/parse.js'

parse('rg foo | wc -l').list[0].stages.map((stage) => stage.argv[0])  // ['rg', 'wc']
```

That entry point loads the parser and its lexers and nothing else — no
commands, no filesystem, no expansion — and answers as `terminal.parse()` does
but for one thing: it never refuses a redirect. Where a line may write is a
property of a terminal, so `echo a > out` parses here and is refused by a
terminal whose filesystem is read-only.

Either way, only parsing happens, so only parsing's answers come back. Whether
a command exists, what an option means, and what an expansion produces are
`run()`'s to find.

## The short answer

`summarize(line)` is for a caller that only wants to know what a line runs:
every command in plain text, with `&&` and `||` between the chains they gate
and `&` after the one it hands to the background.

```js
import { summarize } from '@preventive/terminal/parse.js'

summarize('foo -bar | head -10; ls > file.txt')
// [ [['foo', '-bar'], ['head', '-10']], [['ls'], ['>', 'file.txt']] ]

summarize('foo -bar | head -10 && ls > file.txt')
// [ [['foo', '-bar'], ['head', '-10']], '&&', [['ls'], ['>', 'file.txt']] ]

summarize('wc < 1.txt || ls')
// [ [['cat', '1.txt'], ['wc']], '||', [['ls']] ]

summarize("cat > notes.md <<EOF\nhello\nEOF\n")
// [ [['echo', 'hello'], ['>', 'notes.md']] ]

summarize('ls & ls &')
// [ [['ls']], '&', [['ls']], '&' ]
```

`&` ends a command rather than joining the next one, so it comes after the
chain it backgrounds and may be the last thing the summary says. Nothing runs
in the background here — `run()` reports the gap — but a line still says so,
and a reader still gets to see it.

It reports what a line does rather than how it was written, so whatever feeds a
command is the command that feeds it: a file is the `cat` that reads it, text
is the `echo` that writes it, and a `cat` left with nothing to read but its own
input is left out. A quoted `$(cat <<'EOF' … EOF)` comes back as the text that
here-document holds.

A token is text, or the pattern or variable an argument is written as, or the
`parts` those join into — one piece of a word says what it reaches for as
plainly as the whole of one does:

```js
summarize('ls *.js ~/bin $home a{b,c}')
// [ [ ['ls', { type: 'pattern', pattern: '*.js' },
//      { type: 'parts', parts: [{ type: 'variable', name: 'HOME', quoted: true }, '/bin'] },
//      { type: 'variable', name: 'home', quoted: false }, 'ab', 'ac'] ] ]
```

Anything else throws rather than be summarized into a lie: a line that does not
parse, `while`, `case` and the other constructs this terminal refuses, a
subshell, group, `for`, `if` or `[[ … ]]`, a `!`, an assignment, a
here-document whose delimiter leaves its body to expand, and any word a command
has to run before its text is known — `` `date` `` or `$(( … ))`, whether it is
the whole argument or one piece of it. `parse()` reads those.

A terminal has the same method, under its own write policy: `summarize('ls >
out')` throws there when nothing may be written.
