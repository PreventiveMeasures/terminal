# @preventive/terminal

A virtual terminal over a virtual filesystem. Give it `{ path: content }` and it
gives you a shell: bash syntax, GNU-compatible tools, and no way out — no host
filesystem, no `eval`, no `new Function`, no Node built-ins, and no network
unless you [ask for one](#the-network).

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

(await terminal.run('grep -rn oak src')).stdout  // 'src/app.js:1:export const name = "oak"\n'
terminal.complete('cat src/a')                  // ['cat src/app.js']
await terminal.run('cd src; wc -l app.js')      // { stdout: '1 app.js\n', exitCode: 0, cwd: '/src', … }
```

`run(line)` answers with a promise of `{ stdout, stderr, exitCode, cwd,
unsupported, notes }`, because a command may have work the runtime does rather
than this code — `gzip` waits on a compression stream — and the line waits for
it where it meets it. One line runs at a time over a tree: a line handed to a
terminal, or to a fork of it, while another is in flight takes its turn rather
than starting in the gap that one left, so lines run in the order they were
given whether or not each call is awaited. Variables
and the working directory persist across calls. `complete(line)` returns
full-line replacements, ready to drop in. Reading a
line without running it is a separate entry point,
[`@preventive/terminal/parse.js`](docs/parser.md), which needs no terminal.

A source is a file's text, or its bytes as a `Uint8Array`; an object says what
else is there — `{ type: 'directory' }`, `{ type: 'symlink', target }`,
`{ type: 'file', data }`, or `{ format: 'base64', data }` for bytes that arrive
as text. The tree is an [`@preventive/vfs`](https://www.npmjs.com/package/@preventive/vfs)
one and takes a map by its rules: a path declared twice is the same entry both
times, nothing is declared under a file or through a link, and text has a
UTF-8 encoding, which one holding a lone surrogate has not. A source it cannot
take — a hard link, a `mode` or an `mtime` it does not keep yet, a value that
declares nothing — is refused with a `TypeError` when the terminal is made,
never dropped.

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
(await terminal.run('shopt -s nullglob')).unsupported
// [{ kind: 'feature', command: 'shopt', detail: 'shopt', message: 'shopt: `shopt` is not supported' }]
```

## Documentation

- [What it runs](docs/what-it-runs.md) — the shell it speaks, the commands it
  carries, and where each one stops short of the real tool.
- [The parser](docs/parser.md) — reading a line rather than running it.

## The network

Nothing here reaches outside unless you say so. `network: true` adds `curl`,
which makes its request with the runtime's own `fetch`; without it there is no
`curl` at all — the name is not a command, exactly as it was before the command
was written. How you built the terminal is not something a line running inside
it is told, or could act on.

```js
const online = createTerminal(sources, { mount: '/repo', writable: '/tmp/', network: true })

(await online.run('curl -sS https://example.com/status.json | head -c 40')).stdout
(await online.run('curl -fsSL -o /tmp/page.html https://example.com/')).exitCode
(await createTerminal(sources).run('curl https://example.com/')).unsupported
// [{ kind: 'command', command: 'curl', detail: 'curl', message: 'curl: command not found. Available: …' }]
```

`true` is whatever that `fetch` can reach, over http and https alone — there is
no allow-list, no proxy and no credential store here, and a request carries
nothing off the host: no environment, no `.netrc`, no cookie jar. What a
response holds comes back as bytes, so `curl url > /tmp/f.png` and
`curl url | sha256sum` read the answer itself. A file it writes goes in the
`/tmp/` overlay, which is the only place anything here writes.

If you need less than the whole network — an allow-list, a proxy, a signature
on every request — leave the option off and wire a `curl` of your own through
`commands`: the name is free while the network is off, and a handler may answer
with a promise, which the line waits for.

## Writing

Sources are read-only. Pass `writable: '/tmp/'` for a scratch overlay; the mount
must live outside it. The overlay starts as one directory, and `mkdir` and
`cp -r` make any others in it. Sources mount at `/` unless `mount` says otherwise, and
`cwd` and `home` start there too unless set on their own.

```js
const terminal = createTerminal({ input: 'b\na\n' }, { mount: '/repo', writable: '/tmp/' })

(await terminal.run('sort input > /tmp/out; cat /tmp/out')).stdout  // 'a\nb\n'
(await terminal.run('echo x > out')).exitCode                       // 1, and `>` refuses on the feed
```

## Forking

`fork()` gives you a second terminal over the same filesystem, carrying a copy
of this one's session: its working directory, variables, functions, `set -e`
and `$?` as they are at the moment of the call. It is the process fork rather than a second
`createTerminal` — the sources, the mount, the `/tmp/` overlay, the network and
the wired commands are the parent's own, not copies of them.

```js
const terminal = createTerminal({ 'src/app.js': 'x\n' }, { mount: '/repo', writable: '/tmp/' })
await terminal.run('cd src; TAG=v2')

const worker = terminal.fork()                  // starts in /repo/src, with TAG set
await worker.run('cd /repo; TAG=v3; echo $TAG > /tmp/tag')

(await terminal.run('pwd; echo $TAG')).stdout   // '/repo/src\nv2\n' — the parent did not move
(await terminal.run('cat /tmp/tag')).stdout     // 'v3\n' — /tmp/ is the one thing they share
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

(await other.run('echo ~; whoami')).stdout  // '/home/ada\nada\n' — the home it was given
(await other.run('echo $TAG')).unsupported  // [{ …, detail: '$TAG' }] — nothing of the parent's is set
other.cwd()                                 // '/repo/src' — where it stands is `cwd`'s business, not `inherit`'s
```

## License

[MIT](./LICENSE)
