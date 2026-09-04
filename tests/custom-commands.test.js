// `opts.commands` — the wiring point for commands this package will
// not implement itself.
//
// The motivating case is `sha256sum`: hashing needs a crypto
// implementation, and a package with zero runtime dependencies has no
// business bundling one. So the embedder hands in the handler and the
// engine supplies the shell around it. These tests wire a REAL
// `sha256sum` using the host's crypto (available here, deliberately
// not in `src/`) and then check it behaves like any other command —
// expansion, pipes, redirects, gates, `xargs`, completion, `which` —
// alongside the contract the handler itself has to hold up.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'

import { createTerminal } from '@preventive/terminal'

const SOURCES = {
  'a.txt': 'hello\n',
  'b.txt': 'world\n',
  'src/x.js': 'const x = 1\n',
  'src/y.js': 'const y = 2\n',
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex')
// `printf 'hello\n' | sha256sum` on a real system. Hardcoded so the
// test pins the actual bytes rather than agreeing with itself.
const HELLO_SHA = '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03'

// The wiring an embedder would write: `readInputs` supplies the
// coreutils file/stdin model (including the `-` name for stdin and
// per-operand errors), leaving the handler with just the hashing.
const sha256sum = {
  pipe: true,
  run: ({ args, readInputs }) => {
    const r = readInputs(args)
    const lines = r.inputs.map((i) => `${sha256(i.content)}  ${i.name ?? '-'}\n`)
    return { stdout: lines.join(''), stderr: r.stderr, exitCode: r.failed ? 1 : 0 }
  },
}

const withSha = (opts = {}) => createTerminal(SOURCES, { commands: { sha256sum }, ...opts })

describe('createTerminal — opts.commands: a wired sha256sum', () => {
  it('hashes file operands, one `HASH  NAME` line each', () => {
    const t = withSha()
    assert.equal(t.run('sha256sum a.txt').stdout, `${HELLO_SHA}  a.txt\n`)
    assert.equal(t.run('sha256sum a.txt').exitCode, 0)
    assert.equal(
      t.run('sha256sum a.txt b.txt').stdout,
      `${HELLO_SHA}  a.txt\n${sha256('world\n')}  b.txt\n`,
    )
  })

  it('reads stdin when it has no operands, naming the input `-`', () => {
    const t = withSha()
    assert.equal(t.run('cat a.txt | sha256sum').stdout, `${HELLO_SHA}  -\n`)
    // Bare `sha256sum` at the head of a pipeline gets empty stdin,
    // and hashing the empty string is a real answer, not an error.
    assert.equal(t.run('sha256sum').stdout, `${sha256('')}  -\n`)
    assert.equal(t.run('sha256sum').exitCode, 0)
  })

  it('operands arrive expanded: globs and braces resolve before the handler sees them', () => {
    const t = withSha()
    assert.equal(t.run('sha256sum *.txt').stdout, t.run('sha256sum a.txt b.txt').stdout)
    assert.equal(t.run('sha256sum {a,b}.txt').stdout, t.run('sha256sum a.txt b.txt').stdout)
    assert.equal(t.run('sha256sum src/*.js').stdout, t.run('sha256sum src/x.js src/y.js').stdout)
  })

  it('honors the cwd, including inside a subshell', () => {
    const t = withSha({ cwd: '/src' })
    assert.equal(t.run('sha256sum x.js').stdout, `${sha256('const x = 1\n')}  x.js\n`)
    assert.equal(t.run('sha256sum /a.txt').stdout, `${HELLO_SHA}  /a.txt\n`)
    // The subshell's cwd change reaches the handler and is then rolled back.
    assert.equal(t.run('(cd /; sha256sum a.txt)').stdout, `${HELLO_SHA}  a.txt\n`)
    assert.equal(t.cwd(), '/src')
  })

  it('partial failure: reads what it can, one stderr line per miss, exit 1', () => {
    const t = withSha()
    const r = t.run('sha256sum a.txt nope.txt src')
    assert.equal(r.stdout, `${HELLO_SHA}  a.txt\n`)
    assert.equal(r.stderr, 'sha256sum: nope.txt: no such file or directory\nsha256sum: src: is a directory\n')
    assert.equal(r.exitCode, 1)
  })

  it('composes downstream, upstream, and through the shell forms', () => {
    const t = withSha()
    // Downstream of a pipe.
    assert.equal(t.run('sha256sum a.txt | cut -d " " -f 1').stdout, `${HELLO_SHA}\n`)
    assert.equal(t.run('sha256sum *.txt | wc -l').stdout, '2\n')
    // Dispatched by xargs, which goes through the same registry.
    assert.equal(t.run('echo a.txt | xargs sha256sum').stdout, `${HELLO_SHA}  a.txt\n`)
    // find -exec, the other command-dispatching surface.
    assert.equal(t.run("find . -name a.txt -exec sha256sum {} ';'").stdout, `${HELLO_SHA}  ./a.txt\n`)
    // Exit status gates `&&` / `||` like any other command's.
    assert.equal(t.run('sha256sum a.txt >/dev/null && echo ok').stdout, 'ok\n')
    assert.equal(t.run('sha256sum nope 2>/dev/null || echo failed').stdout, 'failed\n')
    // Redirects apply to a wired command's streams too.
    assert.equal(t.run('sha256sum nope 2>&1 | wc -l').stdout, '1\n')
  })

  it('is reachable under the bin prefixes, like a built-in', () => {
    const t = withSha()
    assert.equal(t.run('/usr/bin/sha256sum a.txt').stdout, `${HELLO_SHA}  a.txt\n`)
    assert.equal(t.run('/bin/sha256sum a.txt').exitCode, 0)
  })
})

describe('createTerminal — opts.commands: the handler contract', () => {
  const run = (spec, line) => createTerminal(SOURCES, { commands: { probe: spec } }).run(line)

  it('a returned string is stdout with exit 0', () => {
    assert.deepEqual(run(() => 'hi\n', 'probe'), { stdout: 'hi\n', stderr: '', exitCode: 0, cwd: '/' })
  })

  it('returning nothing is a silent success, so a no-op handler works', () => {
    assert.deepEqual(run(() => {}, 'probe'), { stdout: '', stderr: '', exitCode: 0, cwd: '/' })
    assert.deepEqual(run(() => null, 'probe'), { stdout: '', stderr: '', exitCode: 0, cwd: '/' })
  })

  it('a returned object fills in its missing fields', () => {
    assert.deepEqual(
      run(() => ({ stderr: 'bad\n', exitCode: 3 }), 'probe'),
      { stdout: '', stderr: 'bad\n', exitCode: 3, cwd: '/' },
    )
    assert.equal(run(() => ({ stdout: 'x' }), 'probe').exitCode, 0)
    // A non-zero status from a handler gates the rest of the line.
    assert.equal(run(() => ({ exitCode: 2 }), 'probe || echo caught').stdout, 'caught\n')
  })

  it('a throwing handler surfaces as `name: message`, exit 1 — run() never throws', () => {
    const r = run(() => { throw new Error('boom') }, 'probe')
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, 'probe: boom\n')
    assert.equal(r.exitCode, 1)
    // And the failure is contained: the next gated step still runs.
    assert.equal(run(() => { throw new Error('boom') }, 'probe 2>/dev/null || echo after').stdout, 'after\n')
  })

  it('rejects a promise instead of stringifying it into the stream', () => {
    // The engine is synchronous end-to-end — one stage's stdout is
    // the next stage's stdin, immediately — so there is nowhere to
    // await. Without the guard this would pipe `[object Promise]`.
    const r = run(() => Promise.resolve('hi\n'), 'probe')
    assert.equal(r.exitCode, 1)
    assert.match(r.stderr, /probe: invalid result: commands are synchronous/u)
    assert.equal(r.stdout, '')
    assert.doesNotMatch(run(() => Promise.resolve('hi\n'), 'probe | cat').stdout, /Promise/u)
    // The check is structural, so an `async run` — which returns a
    // promise without ever saying so — is caught the same way.
    const asyncRun = async () => { await Promise.resolve(); return 'hi\n' }
    assert.match(run(asyncRun, 'probe').stderr, /commands are synchronous/u)
  })

  it('rejects result fields of the wrong type rather than coercing them', () => {
    assert.match(run(() => 42, 'probe').stderr, /probe: invalid result: expected a string or an object \(got number\)/u)
    assert.match(run(() => ({ stdout: 42 }), 'probe').stderr, /invalid result: stdout must be a string \(got number\)/u)
    assert.match(run(() => ({ stderr: [] }), 'probe').stderr, /invalid result: stderr must be a string \(got object\)/u)
    assert.match(run(() => ({ exitCode: 1.5 }), 'probe').stderr, /invalid result: exitCode must be a non-negative integer/u)
    assert.match(run(() => ({ exitCode: -1 }), 'probe').stderr, /invalid result: exitCode must be a non-negative integer/u)
    assert.match(run(() => ({ exitCode: '0' }), 'probe').stderr, /invalid result: exitCode must be a non-negative integer/u)
  })

  it('io carries the registered name, expanded args, stdin and cwd', () => {
    const seen = []
    const t = createTerminal(SOURCES, {
      commands: { probe: { pipe: true, run: (io) => { seen.push(io); return '' } } },
    })
    t.run('cd src')
    t.run('echo piped | probe -n *.js literal')
    assert.equal(seen.length, 1)
    const io = seen[0]
    assert.equal(io.name, 'probe')
    assert.deepEqual(io.args, ['-n', 'x.js', 'y.js', 'literal'])
    assert.equal(io.stdin, 'piped\n')
    assert.equal(io.cwd, '/src')
  })

  it('io.cwd is a snapshot — a handler cannot move the terminal', () => {
    const t = createTerminal(SOURCES, {
      commands: {
        probe: (io) => {
          io.cwd = '/nowhere'
          return ''
        },
      },
    })
    t.run('cd src')
    assert.equal(t.run('probe').exitCode, 0)
    assert.equal(t.cwd(), '/src')
    assert.equal(t.run('pwd').stdout, '/src\n')
  })

  it('io.readInputs is the shared file/stdin model, addressable by absolute or relative path', () => {
    let seen
    const t = createTerminal(SOURCES, {
      commands: { probe: (io) => { seen = io.readInputs(io.args); return '' } },
    })
    t.run('cd src')
    t.run('probe x.js ../a.txt /b.txt')
    assert.deepEqual(seen.inputs, [
      { name: 'x.js', content: 'const x = 1\n' },
      { name: '../a.txt', content: 'hello\n' },
      { name: '/b.txt', content: 'world\n' },
    ])
    assert.equal(seen.stderr, '')
    assert.equal(seen.failed, false)
    // Errors are named after the registered command, not a generic label.
    t.run('probe missing.js')
    assert.equal(seen.stderr, 'probe: missing.js: no such file or directory\n')
    assert.equal(seen.failed, true)
  })

  it('io.readInputs rejects a bare string instead of reading it character by character', () => {
    const t = createTerminal(SOURCES, { commands: { probe: (io) => { io.readInputs(io.args[0]); return '' } } })
    const r = t.run('probe a.txt')
    assert.equal(r.exitCode, 1)
    assert.equal(r.stderr, 'probe: readInputs: expected an array of paths, got a string: a.txt\n')
  })
})

describe('createTerminal — opts.commands: the io.fs view', () => {
  const inspect = (line, fn) => {
    let out
    const t = createTerminal(SOURCES, { commands: { probe: (io) => { out = fn(io); return '' } } })
    t.run(line)
    return out
  }

  it('resolves relative paths against the cwd and normalizes absolute ones', () => {
    assert.equal(inspect('cd src; probe', (io) => io.fs.resolve('x.js')), '/src/x.js')
    assert.equal(inspect('cd src; probe', (io) => io.fs.resolve('../a.txt')), '/a.txt')
    assert.equal(inspect('probe', (io) => io.fs.resolve('/src/./y.js')), '/src/y.js')
  })

  it('exposes reads, existence checks, listings and walks', () => {
    assert.equal(inspect('cd src; probe', (io) => io.fs.readFile('x.js')), 'const x = 1\n')
    assert.equal(inspect('probe', (io) => io.fs.readFile('nope')), undefined)
    assert.equal(inspect('probe', (io) => io.fs.isFile('a.txt')), true)
    assert.equal(inspect('probe', (io) => io.fs.isFile('src')), false)
    assert.equal(inspect('probe', (io) => io.fs.isDir('src')), true)
    assert.deepEqual(inspect('probe', (io) => io.fs.listDir('/')), { dirs: ['src'], files: ['a.txt', 'b.txt'] })
    assert.deepEqual(inspect('probe', (io) => io.fs.walkFiles('src')), ['/src/x.js', '/src/y.js'])
    assert.deepEqual(inspect('probe', (io) => io.fs.walkFiles('/nope')), [])
  })

  it('listings are copies — a handler cannot corrupt the shared directory index', () => {
    const t = createTerminal(SOURCES, {
      commands: {
        probe: (io) => {
          const listing = io.fs.listDir('/')
          listing.dirs.push('injected')
          listing.files.length = 0
          return ''
        },
      },
    })
    t.run('probe')
    assert.equal(t.run('ls').stdout, 'src/\na.txt\nb.txt\n')
  })

  it('is read-only: the source tree cannot be written through it', () => {
    const t = createTerminal(SOURCES, { commands: { probe: (io) => Object.keys(io.fs).join(',') + '\n' } })
    assert.equal(t.run('probe').stdout, 'resolve,isFile,isDir,readFile,listDir,walkFiles\n')
  })
})

describe('createTerminal — opts.commands: registry integration', () => {
  it('completes in command position, after the builtins, in registration order', () => {
    const t = createTerminal(SOURCES, { commands: { sha256sum, shasum: sha256sum.run, zzz: () => '' } })
    assert.deepEqual(t.complete('sha'), ['sha256sum', 'shasum'])
    assert.deepEqual(t.complete('sha256'), ['sha256sum'])
    assert.deepEqual(t.complete('/usr/bin/sha2'), ['/usr/bin/sha256sum'])
    // The built-in ordering is untouched — `ls` still leads, and the
    // three wired names are appended as a contiguous tail.
    const all = t.complete('')
    assert.equal(all[0], 'ls')
    assert.deepEqual(all.slice(-3), ['sha256sum', 'shasum', 'zzz'])
    assert.equal(all.indexOf('sha256sum'), all.length - 3)
  })

  it('`pipe: true` offers the command as a pipe target; without it, it stays out', () => {
    const t = createTerminal(SOURCES, {
      commands: { sha256sum, standalone: () => '' },
    })
    assert.deepEqual(t.complete('cat a.txt | sha'), ['cat a.txt | sha256sum'])
    assert.deepEqual(t.complete('cat a.txt | stand'), [])
    // Still dispatchable in a pipeline — `pipe` is a completion hint,
    // not an access control.
    assert.equal(t.run('cat a.txt | standalone').exitCode, 0)
  })

  it('which resolves wired commands', () => {
    const t = withSha()
    assert.equal(t.run('which sha256sum').stdout, '/usr/bin/sha256sum\n')
    assert.equal(t.run('which sha256sum cat').exitCode, 0)
  })

  it('appears in the "Available: …" hint, after the builtins', () => {
    const hint = withSha().run('frobnicate').stderr
    assert.equal(hint.trimEnd().endsWith(', sha256sum'), true, hint)
    assert.match(hint, /^frobnicate: command not found\. Available: ls, cd, cat/u)
  })

  it('`hidden: true` keeps it dispatchable but out of completion and the hint', () => {
    const t = createTerminal(SOURCES, {
      commands: { md5sum: { hidden: true, pipe: true, run: () => 'stub\n' } },
    })
    assert.equal(t.run('md5sum a.txt').stdout, 'stub\n')
    assert.equal(t.run('cat a.txt | md5sum').stdout, 'stub\n')
    assert.equal(t.run('which md5sum').stdout, '/usr/bin/md5sum\n')
    assert.deepEqual(t.complete('md5'), [])
    assert.deepEqual(t.complete('cat | md5'), [])
    assert.doesNotMatch(t.run('frobnicate').stderr, /md5sum/u)
  })

  it('accepts a Map, like `sources` does', () => {
    const t = createTerminal(SOURCES, { commands: new Map([['sha256sum', sha256sum]]) })
    assert.equal(t.run('sha256sum a.txt').stdout, `${HELLO_SHA}  a.txt\n`)
  })

  it('wiring is per terminal — nothing leaks into other instances', () => {
    const wired = withSha()
    const plain = createTerminal(SOURCES)
    assert.equal(wired.run('sha256sum a.txt').exitCode, 0)
    assert.equal(plain.run('sha256sum a.txt').exitCode, 127)
    assert.match(plain.run('sha256sum a.txt').stderr, /command not found/u)
    assert.deepEqual(plain.complete('sha'), [])
    assert.equal(plain.run('which sha256sum').stdout, 'sha256sum not found\n')
    // …and the shared default registry is not mutated by either.
    assert.equal(createTerminal(SOURCES).run('sha256sum').exitCode, 127)
  })

  it('a name is only reachable as itself: no PATH lookup, no partial match', () => {
    const t = withSha()
    assert.equal(t.run('sha256').exitCode, 127)
    assert.equal(t.run('sha256sum2').exitCode, 127)
    assert.equal(t.run('./sha256sum a.txt').exitCode, 127)
  })
})

describe('createTerminal — opts.commands: wiring errors throw at construction', () => {
  const build = (commands) => () => createTerminal(SOURCES, { commands })

  it('refuses to redefine a built-in — visible or hidden', () => {
    for (const name of ['cat', 'grep', 'ls', 'which']) {
      assert.throws(build({ [name]: () => '' }), /cannot redefine a built-in command/u, name)
    }
    // Hidden builtins count too: silently shadowing `sed` or `true`
    // would change how existing lines behave.
    for (const name of ['sed', 'od', 'xxd', 'whoami', 'date', 'true', 'false', ':']) {
      assert.throws(build({ [name]: () => '' }), /createTerminal: /u, name)
    }
  })

  it('refuses names that could never be typed as a command', () => {
    for (const name of ['', ' ', 'a b', 'a|b', 'a;b', 'a>b', "a'b", '-x', '.hidden', '/usr/bin/x', 'a/b', '__proto__']) {
      assert.throws(build({ [name]: () => '' }), /invalid command name/u, JSON.stringify(name))
    }
    // …while the shapes real tools use are fine.
    assert.doesNotThrow(build({ sha256sum: () => '', 'my-tool': () => '', 'tool.js': () => '', b3sum: () => '', '7z': () => '' }))
  })

  it('refuses a descriptor that is not a function or a { run } object', () => {
    assert.throws(build({ probe: 'nope' }), /probe: expected a function or a \{ run \} object/u)
    assert.throws(build({ probe: null }), /probe: expected a function or a \{ run \} object/u)
    assert.throws(build({ probe: {} }), /probe: `run` must be a function/u)
    assert.throws(build({ probe: { run: 'x' } }), /probe: `run` must be a function/u)
  })

  it('refuses unknown descriptor options, so a typo is not silently ignored', () => {
    assert.throws(build({ probe: { run: () => '', hide: true } }), /probe: unknown option `hide` \(known: run, pipe, hidden\)/u)
    assert.throws(build({ probe: { run: () => '', piped: true } }), /unknown option `piped`/u)
  })

  it('refuses a non-object `commands`', () => {
    assert.throws(build('sha256sum'), /opts\.commands must be an object or a Map \(got string\)/u)
    assert.throws(build(() => ''), /opts\.commands must be an object or a Map \(got function\)/u)
    // Omitted / empty is fine and leaves the builtins alone.
    assert.doesNotThrow(build())
    assert.doesNotThrow(build({}))
    assert.equal(createTerminal(SOURCES, { commands: {} }).run('cat a.txt').stdout, 'hello\n')
  })
})
