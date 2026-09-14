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

## Documentation

- [The parser](docs/parser.md) — reading a line rather than running it.

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

Pipelines, `&&`/`||`/`;`/`!`, subshells and groups, `if`, `for … in`,
`while` / `until`, `[[ … ]]` and `test`, redirects and heredocs, brace
expansion, globs with bracket expressions, `$(…)` and backticks, `$(( … ))`,
and the `${…}` family. A loop that never ends is stopped and reported, since
nothing here runs beside the line.

`name() { … }` runs wherever the name is called, while its body reads and
writes no variable — then a call cannot tell itself from the line it stands
in, and `$1`, a `local` and the rest are nothing the body could have read. A
body that needs any of them is refused rather than run as something it is
not.

`ls` `cd` `cat` `grep` `rg` `egrep` `fgrep` `sed` `awk` `find` `head` `tail` `wc`
`tree` `sort` `uniq` `cut` `tr` `nl` `tac` `hexdump` `base64` `xargs` `echo`
`printf` `test` `cp` `rm` `du` `stat` `realpath` `pwd` `seq` `which` `basename`
`dirname` — plus your own, via `opts.commands`.

`du -b` measures UTF-8 content bytes recursively, including hidden files;
`du -bs src` reports a directory total. `--apparent-size` (also accepted as the
BSD `-A`) supports block and human-readable units, and `--inodes` counts
entries. Allocated disk sizes are unavailable, so plain `du` and `du -sh`
report an unsupported diagnostic.

`rg` covers the search itself: recursion, `-n -N -i -s -w -v -F -a -l -c -e -q
-H -I -A -B -C -u`, and skipping hidden entries unless `--hidden`. Options are
last-one-wins and `-u` escalates, as in ripgrep. Its regex is checked against
ripgrep's own engine, so backreferences and look-around are refused rather than
answered. `.gitignore` in a repository, `.ignore` and `.rgignore` change which
files are searched, so a tree carrying one is refused unless `--no-ignore`;
binary files are left out of a walk but a named one is refused, and `-t`, `-g`,
`--files` and the other output modes report an unsupported diagnostic. A
pattern spelling out a newline, and a file starting with a byte-order mark, are
refused rather than answered differently from ripgrep.

`stat -c '%s %n' file` reports byte size and name; `%F` reports file type.
`--printf` adds escape processing and controls line endings. Default `stat`
output, directory byte sizes, and fields requiring ownership, permissions,
timestamps or other absent metadata report an unsupported diagnostic.

`realpath` supports GNU canonicalization modes (`-e`, `-m`, and the default),
relative output (`--relative-to`, `--relative-base`), quiet errors (`-q`) and
NUL terminators (`-z`). It resolves paths within the virtual filesystem.

Behaviour is checked against the real tools: bash 5.2, GNU grep 3.11, GNU sed
4.9, gawk 5.2 and ripgrep 14.1 in the C locale, alongside the BusyBox, GNU/Spencer regex and
Oils spec corpora.

MIT
