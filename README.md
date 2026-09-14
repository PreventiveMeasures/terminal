# @preventive/terminal

A virtual terminal over a virtual filesystem. Give it `{ path: content }` and it
gives you a shell: bash syntax, GNU-compatible tools, and no way out — no host
filesystem, no network, no `eval`, no `new Function`, no Node built-ins.

## Install

```sh
npm install @preventive/terminal
```

## Usage

```js
import { createTerminal } from '@preventive/terminal'

const terminal = createTerminal({
  'src/app.js': 'export const name = "oak"\n',
  'README.md': '# demo\n',
})

terminal.run('grep -rn oak src').stdout  // 'src/app.js:1:export const name = "oak"\n'
terminal.complete('cat src/a')           // ['cat src/app.js']
terminal.parse('wc -l src/app.js')       // { ok: true, list: [ { type: 'command', argv: [ … ] } ], … }
terminal.run('cd src; wc -l app.js')     // { stdout: '1 app.js\n', exitCode: 0, cwd: '/src', … }
```

`run(line)` is synchronous and returns `{ stdout, stderr, exitCode, cwd,
unsupported, notes }`. Variables and the working directory persist across calls.
`complete(line)` returns full-line replacements, ready to drop in. `parse(line)`
reads a line and runs none of it.

## Three channels, because a wrong answer is the one failure that matters

- **`stderr`** — what the real tool would have printed in the same situation: a
  missing file, a malformed pattern, a non-zero exit.
- **`unsupported`** — what this implementation cannot do. Anything it has not
  implemented refuses and says so here, rather than guessing. Redirects and
  pipelines cannot suppress it, so a caller always learns that no answer came
  back.
- **`notes`** — advisory, alongside a correct answer: hidden entries a glob or
  listing passed over, a depth-limited traversal, input shortened by `head`.

```js
terminal.run('shopt -s nullglob').unsupported
// [{ kind: 'feature', command: 'shopt', detail: 'shopt', message: 'shopt: `shopt` is not supported' }]
```

## Reading a line before running it

`parse(line)` is the parser on its own: nothing runs, nothing changes — not the
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
whatever else it has — `assignments`, `redirects`, a `negate` for `!`.
Pipelines, subshells, `{ …; }` groups, `for` loops, `if` branches and
`[[ … ]]` tests are nodes of their own, each named by `type`. A field that would only say "nothing
here" is left out, and a line that fails partway still carries the commands
ahead of the error.

Values are plain text wherever the text is final, and a word in pieces only
where expansion still decides it — so reading arguments takes no knowledge of
quoting:

```js
terminal.parse('grep -rn "$pattern" src/*.js').list[0].argv
// [ 'grep', '-rn',
//   { type: 'parameter', name: 'pattern', quoted: true },
//   { type: 'pattern', pattern: 'src/*.js' } ]
```

`'*'` is the string `*`, because quoting settled it; `*.js` is a pattern,
because the filesystem has yet to. A piece is a plain string once nothing can
change it; otherwise it names what it waits for — `pattern`, `brace`, `tilde`,
`parameter`, `substitution`, `arithmetic`. A word of several pieces is a
`parts` node holding them in order, and a word of one piece is that piece. A substitution holds the commands it runs, parsed the same way:

```js
terminal.parse('foo `bar a b c`').list[0].argv[1]
// { type: 'substitution', list: [ { type: 'command', argv: ['bar', 'a', 'b', 'c'] } ] }
```

## The parser on its own

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
every command in plain text, with `&&` and `||` between the chains they gate.

```js
import { summarize } from '@preventive/terminal/parse.js'

summarize('foo -bar | head -10; ls > file.txt')
// [ [['foo', '-bar'], ['head', '-10']], [['ls'], ['>', 'file.txt']] ]

summarize('foo -bar | head -10 && ls > file.txt')
// [ [['foo', '-bar'], ['head', '-10']], '&&', [['ls'], ['>', 'file.txt']] ]

summarize('wc < 1.txt || ls')
// [ [['cat', '1.txt'], ['wc']], '||', [['ls']] ]
```

It reports what a line does rather than how it was written, which is why a
command reading a file comes back as the `cat` that feeds it, and why a quoted
`$(cat <<'EOF' … EOF)` comes back as the text that here-document holds.

A token is text, or a pattern when one is the whole of its argument:

```js
summarize('ls *.js | head')
// [ [ ['ls', { type: 'pattern', pattern: '*.js' }], ['head'] ] ]
```

Anything else throws rather than be summarized into a lie: a line that does not
parse, `while`, `case` and the other constructs this terminal refuses, a
subshell, group, `for`, `if` or `[[ … ]]`, a `!`, an assignment, a
here-document or here-string, and any word whose text only expansion settles —
`$x`, `~/bin`, `{a,b}`, `` `date` ``, or a word joined from pieces like
`a*"b"`. `parse()` reads those.

A terminal has the same method, under its own write policy: `summarize('ls >
out')` throws there when nothing may be written.

## Writing

Sources are read-only. Pass `writable: '/tmp/'` for a scratch overlay; the mount
must live outside it. Sources mount at `/` unless `mount` says otherwise, and
`cwd` and `home` start there too unless set on their own.

```js
const terminal = createTerminal({ input: 'b\na\n' }, { mount: '/repo', writable: '/tmp/' })

terminal.run('sort input > /tmp/out; cat /tmp/out').stdout  // 'a\nb\n'
terminal.run('echo x > out').exitCode                       // 1, and `>` refuses on the feed
```

## What it runs

Pipelines, `&&`/`||`/`;`/`!`, subshells and groups, `if`, `for … in`, `[[ … ]]`
and `test`, redirects and heredocs, brace expansion, globs with bracket
expressions, `$(…)` and backticks, `$(( … ))`, and the `${…}` family.

`ls` `cd` `cat` `grep` `egrep` `fgrep` `sed` `awk` `find` `head` `tail` `wc`
`tree` `sort` `uniq` `cut` `tr` `nl` `tac` `hexdump` `base64` `xargs` `echo`
`printf` `test` `cp` `rm` `du` `stat` `realpath` `pwd` `seq` `which` `basename`
`dirname` — plus your own, via `opts.commands`.

`du -b` measures UTF-8 content bytes recursively, including hidden files;
`du -bs src` reports a directory total. `--apparent-size` (also accepted as the
BSD `-A`) supports block and human-readable units, and `--inodes` counts
entries. Allocated disk sizes are unavailable, so plain `du` and `du -sh`
report an unsupported diagnostic.

`stat -c '%s %n' file` reports byte size and name; `%F` reports file type.
`--printf` adds escape processing and controls line endings. Default `stat`
output, directory byte sizes, and fields requiring ownership, permissions,
timestamps or other absent metadata report an unsupported diagnostic.

`realpath` supports GNU canonicalization modes (`-e`, `-m`, and the default),
relative output (`--relative-to`, `--relative-base`), quiet errors (`-q`) and
NUL terminators (`-z`). It resolves paths within the virtual filesystem.

Behaviour is checked against the real tools: bash 5.2, GNU grep 3.11, GNU sed
4.9 and gawk 5.2 in the C locale, alongside the BusyBox, GNU/Spencer regex and
Oils spec corpora.

## Development

```sh
npm test
npm run lint
```

MIT
