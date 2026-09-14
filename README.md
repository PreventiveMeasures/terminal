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
terminal.parse('wc -l src/app.js')       // { ok: true, units: [ [ … ] ], … }, running nothing
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
working directory, the variables, or the overlay — and you get back what the
parser made of the input.

```js
terminal.parse('sort input | uniq -c')
// { ok: true, incomplete: false, error: null, unsupported: [], units: [ [ {
//   gate: 'first', negate: false, bang: false, stages: [
//     { words: [{ value: 'sort', mask: null }, { value: 'input', mask: null }], assigns: [], redirs: [] },
//     { words: [{ value: 'uniq', mask: null }, { value: '-c', mask: null }], assigns: [], redirs: [] },
//   ] } ] ] }

terminal.parse('for f in src/*.js; do').incomplete   // true — ask for another line
terminal.parse('echo )').error                       // 'unexpected `)`'
terminal.parse('while :; do echo x; done').unsupported[0].detail  // 'while'
```

`units` is the tree this terminal's own engine runs: gated steps, pipeline
stages, words with the quoting of each character, assignments, redirects, and
the groups, loops and conditionals nested in them — enough to render the line,
walk it, or execute it elsewhere. Bash parses one input unit and runs it before
reading the next, which is why a line that fails partway still carries the
units ahead of the error.

## The parser on its own

The parser is published separately, for a caller with no source tree to mount:

```js
import { parse } from '@preventive/terminal/parse.js'

parse('rg foo | wc -l').units[0][0].stages.map((stage) => stage.words[0].value)  // ['rg', 'wc']
```

That entry point loads the parser and its lexers and nothing else — no
commands, no filesystem, no expansion — and answers as `terminal.parse()` does
but for one thing: it never refuses a redirect. Where a line may write is a
property of a terminal, so `echo a > out` parses here and is refused by a
terminal whose filesystem is read-only.

Either way, only parsing happens, so only parsing's answers come back. Whether
a command exists, what an option means, and what an expansion produces are
`run()`'s to find.

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
