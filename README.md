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
terminal.parse('wc -l src/app.js')       // { ok: true, commands: [{ name: 'wc', … }], … }
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
working directory, the variables, or the overlay — and you get the shell's
verdict on the input.

```js
terminal.parse('sort input | uniq -c')
// { ok: true, incomplete: false, error: null, unsupported: [],
//   commands: [{ name: 'sort', resolved: 'sort' }, { name: 'uniq', resolved: 'uniq' }] }

terminal.parse('for f in src/*.js; do').incomplete   // true — ask for another line
terminal.parse('echo )').error                       // 'unexpected `)`'
terminal.parse('while :; do echo x; done').unsupported[0].detail  // 'while'
```

`commands` is what the line *names*, in source order, through pipelines, gates,
subshells, groups, loop bodies and `if` branches. A name only expansion can
produce — `$tool`, `` `which ls` ``, `~/bin/x`, a glob — is `null`, `resolved`
is `null` for a name this terminal has nothing under (`/bin/grep` resolves to
`grep`), and a command inside `$( … )` stays part of the word it sits in. Which
of them run is still up to the gates: this is a reading of the line, not a
permission boundary.

Only parsing happens, so only parsing's answers come back. An unregistered
command, an option a command refuses, a gap an expansion hits — `run()` finds
those.

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
`printf` `test` `cp` `rm` `pwd` `seq` `which` `basename` `dirname` — plus your
own, via `opts.commands`.

Behaviour is checked against the real tools: bash 5.2, GNU grep 3.11, GNU sed
4.9 and gawk 5.2 in the C locale, alongside the BusyBox, GNU/Spencer regex and
Oils spec corpora.

## Development

```sh
npm test
npm run lint
```

MIT
