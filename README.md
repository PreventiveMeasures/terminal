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
terminal.run('cd src; wc -l app.js')     // { stdout: '1 app.js\n', exitCode: 0, cwd: '/src', … }
```

`run(line)` is synchronous and returns `{ stdout, stderr, exitCode, cwd,
unsupported, notes }`; `runAsync(line)` is that same line handed back as a
promise, for a caller who would rather await a result than take one. Variables
and the working directory persist across calls. `complete(line)` returns
full-line replacements, ready to drop in. Reading a
line without running it is a separate entry point,
[`@preventive/terminal/parse.js`](docs/parser.md), which needs no terminal.

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

- [What it runs](docs/what-it-runs.md) — the shell it speaks, the commands it
  carries, and where each one stops short of the real tool.
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
of this one's session: its working directory, variables, functions, `set -e`
and `$?` as they are at the moment of the call. It is the process fork rather than a second
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
`set -e`, no `$?`, leaving the filesystem, the `/tmp/` overlay and the wired
commands as the only things shared. It is what a new home or user asks for — a session under
another name carrying the last one's variables, and its `HOME` assignment in
front of the home you just set, is the odd shape, not the useful one.

```js
const other = terminal.fork({ inherit: false, home: '/home/ada', user: 'ada' })

other.run('echo ~; whoami').stdout  // '/home/ada\nada\n' — the home it was given
other.run('echo $TAG').unsupported  // [{ …, detail: '$TAG' }] — nothing of the parent's is set
other.cwd()                         // '/repo/src' — where it stands is `cwd`'s business, not `inherit`'s
```

## License

[MIT](./LICENSE)
