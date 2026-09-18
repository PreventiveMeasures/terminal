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
must live outside it. The overlay starts as one directory, and `mkdir` and
`cp -r` make any others in it. Sources mount at `/` unless `mount` says otherwise, and
`cwd` and `home` start there too unless set on their own.

```js
const terminal = createTerminal({ input: 'b\na\n' }, { mount: '/repo', writable: '/tmp/' })

terminal.run('sort input > /tmp/out; cat /tmp/out').stdout  // 'a\nb\n'
terminal.run('echo x > out').exitCode                       // 1, and `>` refuses on the feed
```

## Forking

`fork()` gives you a second terminal over the same filesystem, carrying a copy
of this one's session: its working directory, variables, functions and `$?` as
they are at the moment of the call. It is the process fork rather than a second
`createTerminal` — the sources, the mount, the `/tmp/` overlay and the wired
commands are the parent's own, not copies of them.

```js
const terminal = createTerminal({ 'src/app.js': 'x\n' }, { mount: '/repo', writable: '/tmp/' })
terminal.run('cd src; TAG=v2')

const worker = terminal.fork()           // starts in /repo/src, with TAG set
worker.run('cd /repo; TAG=v3; echo $TAG > /tmp/tag')

terminal.run('pwd; echo $TAG').stdout    // '/repo/src\nv2\n' — the parent did not move
terminal.run('cat /tmp/tag').stdout      // 'v3\n' — /tmp/ is the one thing they share
```

Afterwards the two run independently: neither one's `cd`, assignment, `unset`
or function definition is visible to the other, in either direction, and each
`run()` reports the `unsupported` and `notes` of its own line. What they write
in `/tmp/` is all that passes between them, as it does between two processes
sharing a disk — without a writable overlay they share nothing but the
read-only sources.

`fork({ cwd, home, user })` sets those session options anew, and a relative
`cwd` resolves from where the parent stands, as a `cd` would. Anything a fork
cannot honor — `writable` and `commands` among them — is refused rather than
quietly dropped.

`fork({ inherit: false })` withholds the copy: no variables, no functions, no
`$?`, leaving the filesystem, the `/tmp/` overlay and the wired commands as the
only things shared. It is what a new home or user asks for — a session under
another name carrying the last one's variables, and its `HOME` assignment in
front of the home you just set, is the odd shape, not the useful one.

```js
const other = terminal.fork({ inherit: false, home: '/home/ada', user: 'ada' })

other.run('echo ~; whoami').stdout  // '/home/ada\nada\n' — the home it was given
other.run('echo $TAG').unsupported  // [{ …, detail: '$TAG' }] — nothing of the parent's is set
other.cwd()                         // '/repo/src' — where it stands is `cwd`'s business, not `inherit`'s
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
`printf` `test` `cp` `rm` `mkdir` `touch` `diff` `patch` `du` `stat` `realpath`
`pwd` `seq` `which` `basename` `dirname` — plus your own, via `opts.commands`.

`cp -r` copies a tree into the overlay, making each directory before what goes
inside it; `-R` and `--recursive` spell the same flag, and `-v` announces a
directory once, where it is made. A destination inside the source, a
destination that is the source, and a directory over a file are refused with
GNU's own diagnostics. Directories exist in the overlay only where `cp -r` puts
them, since nothing else here makes one.

`mkdir` makes them one at a time and `mkdir -p` makes a whole path, passing
over what is already there and naming the component it stops at. `rm -r` takes
a tree away again, emptying a directory before removing it. The overlay's own
`/tmp` is where it is mounted rather than something inside it, so `rm -r /tmp`
is refused as the busy device Linux calls a mount point, and nothing in it is
removed on the way to finding that out.

`touch` creates the empty files it names, and `-c` leaves an absent name alone.
Times are the half it cannot answer: every entry carries the one time the
terminal was made, so a name already there reports an unsupported diagnostic
rather than a success that changed nothing, and `-a`, `-m`, `-d`, `-t` and `-r`
are refused for the same reason.

`ls -l` fills in what the filesystem does not keep with one deliberate model
rather than a guess per entry: every entry is the session user's alone
(`-rw-------` and `drwx------`) and is dated to the moment the terminal was
created, a time its forks carry with them. Link counts, directory sizes and
the `total` line are what ext4 would report for the same tree, and `-h`
rounds sizes as `du -h` does.

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
files are searched -- from any directory above the starting point as well as
below it -- so a tree carrying one is refused unless `--no-ignore`;
binary files are left out of a walk but a named one is refused, and `-t`, `-g`,
`--files` and the other output modes report an unsupported diagnostic. A
pattern spelling out a newline, and a file starting with a byte-order mark, are
refused rather than answered differently from ripgrep. Literal matching crosses
scripts, but Unicode-aware matching does not: `-i`, `-w`, `.` and `\w` over a
tree holding any non-ASCII file report an unsupported diagnostic.

`stat -c '%s %n' file` reports byte size and name; `%F` reports file type.
`--printf` adds escape processing and controls line endings. Default `stat`
output, directory byte sizes, and fields requiring ownership, permissions,
timestamps or other absent metadata report an unsupported diagnostic.

`diff` compares files and, with `-r`, directories, in normal, unified (`-u`,
`-U N`) and context (`-c`, `-C N`) format, with `-q`, `-s`, `-N`, `-x`, `-a`,
`-i`, `-w`, `-b`, `-Z`, `--strip-trailing-cr`, `-p`, `-L` and `-d`. The diff
itself comes from [`@preventive/diff`](https://www.npmjs.com/package/@preventive/diff),
which runs the linear-space Myers algorithm GNU diff uses and checks its own
work twice over: the change set is replayed against the first file, and what
is printed is read back and held to the change set. Neither a change set that
would not reconstruct the second file nor a rendering that does not say what
it was given is ever printed — both are refused as trouble instead, so no
diff this terminal emits loses a line. Which of several shortest change sets
it picks can differ from GNU's; given the same change set, the bytes are
GNU's. The virtual filesystem keeps no modification
times, so headers carry the name alone, as they do under `--label`; a file
`-N` stands in for gets the epoch, which is what tells `patch` it did not
exist. `-y`, `-e`, `-B`, `-I` and the rest report an unsupported diagnostic.

`patch` applies unified, context and normal diffs (and git-style headers,
including renames), locating each hunk by line number, then nearby, then
with fuzz, exactly as GNU patch does, with the same messages, reject files,
`.orig` backups, `-p`, `-R`, `-N`, `-f`, `-t`, `-E`, `-l`, `-F`, `-i`, `-o`,
`-d`, `-r`, `-b`, `-z`, `--dry-run` and `--reject-format`. It writes only
inside a writable `/tmp/` overlay; a target anywhere else is refused with an
unsupported diagnostic, while `--dry-run` and `-o -` work everywhere. Ed
scripts and git binary patches are refused the same way.

`realpath` supports GNU canonicalization modes (`-e`, `-m`, and the default),
relative output (`--relative-to`, `--relative-base`), quiet errors (`-q`) and
NUL terminators (`-z`). It resolves paths within the virtual filesystem.

Behaviour is checked against the real tools: bash 5.2, GNU grep 3.11, GNU sed
4.9, gawk 5.2, ripgrep 14.1, GNU diff 3.10 and GNU patch 2.7.6 in the C
locale, alongside the BusyBox, GNU/Spencer regex and Oils spec corpora.

MIT
