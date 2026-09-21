import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const SOURCES = {
  'README.md': 'readme\n',
  'src/a.js': 'alpha\n',
  'src/b.js': 'beta\n',
  'src/util/log.js': 'log\n',
  'home/note.txt': 'note\n',
}
const OPTIONS = { mount: '/repo', writable: '/tmp/' }
const terminal = (options = {}) => createTerminal(SOURCES, { ...OPTIONS, ...options })

// cwd defaults to where the terminal stands before the line runs, so a `cd`
// names where it lands.
async function check(t, command, stdout = '', cwd = t.cwd()) {
  assert.deepEqual(await t.run(command), { stdout, stderr: '', exitCode: 0, cwd, notes: [], unsupported: [] }, command)
}

describe('fork — what a child takes from its parent', () => {
  it('starts where the parent stands', async () => {
    const t = terminal()
    await check(t, 'cd src', '', '/repo/src')
    const child = t.fork()
    assert.equal(child.cwd(), '/repo/src')
    await check(child, 'pwd; cat a.js', '/repo/src\nalpha\n')
  })

  it('copies the variables the parent has set', async () => {
    const t = terminal()
    await check(t, 'FOO=parent; export BAR=exported')
    await check(t.fork(), 'echo $FOO $BAR', 'parent exported\n')
  })

  it('copies names the parent unset, so the child does not warn about them either', async () => {
    const t = terminal()
    await check(t, 'FOO=parent; unset FOO')
    await check(t.fork(), 'echo "[$FOO]"', '[]\n')
  })

  it('copies the parent functions', async () => {
    const t = terminal()
    await check(t, 'greet() { echo hi; }')
    await check(t.fork(), 'greet', 'hi\n')
  })

  it('copies the last exit status', async () => {
    const t = terminal()
    assert.equal((await t.run('false')).exitCode, 1)
    await check(t.fork(), 'echo $?', '1\n')
  })

  it('keeps the parent home and user', async () => {
    const t = terminal({ home: '/repo/home', user: 'ada' })
    await check(t.fork(), 'echo ~ $HOME; whoami; cat ~/note.txt', '/repo/home /repo/home\nada\nnote\n')
  })

  it('keeps a HOME the parent assigned, which stands in front of the home option as it does in the parent', async () => {
    const t = terminal({ home: '/repo/home' })
    await check(t, 'HOME=/repo/src')
    await check(t.fork(), 'echo ~', '/repo/src\n')
    await check(t.fork({ home: '/repo' }), 'echo ~', '/repo/src\n')
    await check(t.fork({ home: '/repo' }), 'unset HOME; echo ~', '/repo\n')
  })
})

describe('fork — a child and its parent go their own way', () => {
  it('a cd on either side leaves the other where it was', async () => {
    const t = terminal()
    const child = t.fork()
    await check(child, 'cd src/util', '', '/repo/src/util')
    assert.equal(t.cwd(), '/repo')
    await check(t, 'cd src', '', '/repo/src')
    assert.equal(child.cwd(), '/repo/src/util')
    await check(child, 'pwd', '/repo/src/util\n')
    await check(t, 'pwd', '/repo/src\n')
  })

  it('an assignment after the fork does not cross, in either direction', async () => {
    const t = terminal()
    await check(t, 'FOO=before; export SHIPPED=before')
    const child = t.fork()
    await check(child, 'echo $FOO $SHIPPED', 'before before\n')
    // There is no environment to export to here, so an exported name is a
    // variable like any other: copied at the fork, each terminal's own after it.
    check(t, 'FOO=parent; export ONLY_PARENT=p')
    await check(child, 'FOO=child; export ONLY_CHILD=c')
    await check(t, 'echo $FOO $ONLY_PARENT', 'parent p\n')
    await check(child, 'echo $FOO $ONLY_CHILD', 'child c\n')
    for (const [t2, name] of [[t, 'ONLY_CHILD'], [child, 'ONLY_PARENT']]) {
      const result = await t2.run(`echo $${name}`)
      assert.equal(result.stdout, '\n')
      assert.deepEqual(result.unsupported.map(({ detail }) => detail), [`$${name}`])
    }
  })

  it('unset in the child leaves the parent variable alone', async () => {
    const t = terminal()
    await check(t, 'FOO=parent')
    const child = t.fork()
    await check(child, 'unset FOO; echo "[$FOO]"', '[]\n')
    await check(t, 'echo $FOO', 'parent\n')
  })

  it('a function defined after the fork does not cross', async () => {
    const t = terminal()
    const child = t.fork()
    await check(child, 'greet() { echo hi; }; greet', 'hi\n')
    const result = await t.run('greet')
    assert.equal(result.exitCode, 127)
    assert.match(result.stderr, /greet: command not found/u)
    assert.deepEqual(result.unsupported.map(({ kind, detail }) => [kind, detail]), [['command', 'greet']])
  })

  it('keeps each exit status to its own terminal', async () => {
    const t = terminal()
    const child = t.fork()
    assert.equal((await t.run('false')).exitCode, 1)
    await check(child, 'echo $?', '0\n')
    await check(t, 'echo $?', '1\n')
  })
})

describe('fork — inherit: false hands the child no session at all', () => {
  async function loaded() {
    const t = terminal({ home: '/repo/home', user: 'ada' })
    await check(t, 'FOO=parent; export SHIPPED=parent; GONE=x; unset GONE; greet() { echo hi; }')
    assert.equal((await t.run('false')).exitCode, 1)
    return t
  }

  it('starts with no variables, set or known-unset', async () => {
    const child = (await loaded()).fork({ inherit: false })
    for (const name of ['FOO', 'SHIPPED', 'GONE']) {
      const result = await child.run(`echo $${name}`)
      assert.equal(result.stdout, '\n')
      // A name the parent unset is known-empty there and unknown here: the
      // child never saw it, so it says so rather than staying quiet.
      assert.deepEqual(result.unsupported.map(({ detail }) => detail), [`$${name}`])
    }
  })

  it('starts with no functions', async () => {
    const result = await (await loaded()).fork({ inherit: false }).run('greet')
    assert.equal(result.exitCode, 127)
    assert.deepEqual(result.unsupported.map(({ kind, detail }) => [kind, detail]), [['command', 'greet']])
  })

  it('starts with nothing to report as the last exit status', async () => {
    await check((await loaded()).fork({ inherit: false }), 'echo $?', '0\n')
    await check((await loaded()).fork(), 'echo $?', '1\n')
  })

  it('leaves the parent session where it was', async () => {
    const t = await loaded()
    await t.fork({ inherit: false }).run('FOO=child')
    await check(t, 'echo $FOO $SHIPPED; greet', 'parent parent\nhi\n')
  })

  it('still stands where the parent stands, under the parent home and user', async () => {
    const t = await loaded()
    await check(t, 'cd src', '', '/repo/src')
    const child = t.fork({ inherit: false })
    assert.equal(child.cwd(), '/repo/src')
    await check(child, 'pwd; echo ~; whoami', '/repo/src\n/repo/home\nada\n')
  })

  it('lets a home and a user of its own actually take, with no inherited HOME in front', async () => {
    const t = await loaded()
    await check(t, 'HOME=/repo/src')
    await check(t.fork({ home: '/repo' }), 'echo ~', '/repo/src\n')
    await check(t.fork({ inherit: false, home: '/repo', user: 'grace' }), 'echo ~ $HOME; whoami', '/repo /repo\ngrace\n')
  })

  it('shares the filesystem, the overlay and the wired commands like any other fork', async () => {
    const commands = { shout: ({ args }) => args.join(' ').toUpperCase() + '\n' }
    const t = terminal({ commands })
    await check(t, 'printf from-parent >/tmp/shared')
    const child = t.fork({ inherit: false })
    await check(child, 'cat /tmp/shared; cat /repo/src/a.js; shout hi', 'from-parentalpha\nHI\n')
    await check(child, 'printf from-child >>/tmp/shared')
    await check(t, 'cat /tmp/shared', 'from-parentfrom-child')
  })

  it('reads inherit: true as the default it is', async () => {
    const t = await loaded()
    await check(t.fork({ inherit: true }), 'echo $FOO; greet', 'parent\nhi\n')
    await check(t.fork(), 'echo $FOO; greet', 'parent\nhi\n')
  })

  it('forks a fork that inherited nothing', async () => {
    const child = (await loaded()).fork({ inherit: false })
    await check(child, 'OWN=child')
    await check(child.fork(), 'echo $OWN', 'child\n')
    const bare = await child.fork({ inherit: false }).run('echo $OWN')
    assert.deepEqual(bare.unsupported.map(({ detail }) => detail), ['$OWN'])
  })

  it('refuses an inherit that is not true or false', () => {
    const t = terminal()
    for (const inherit of ['no', 0, 1, null, {}, []]) {
      assert.throws(() => t.fork({ inherit }), /fork: inherit must be true or false/u)
    }
  })
})

describe('fork — /tmp/ is the one thing they share', () => {
  it('hands the parent what the child wrote', async () => {
    const t = terminal()
    const child = t.fork()
    await check(child, 'printf from-child >/tmp/shared')
    await check(t, 'cat /tmp/shared', 'from-child')
    await check(t, 'ls /tmp', 'shared\n')
  })

  it('hands the child what the parent wrote, as it is written', async () => {
    const t = terminal()
    const child = t.fork()
    await check(t, 'printf one >/tmp/shared')
    await check(child, 'cat /tmp/shared', 'one')
    await check(t, 'printf " two" >>/tmp/shared')
    await check(child, 'cat /tmp/shared', 'one two')
    await check(child, 'printf " three" >>/tmp/shared')
    await check(t, 'cat /tmp/shared', 'one two three')
  })

  it('lets either remove what the other wrote', async () => {
    const t = terminal()
    const child = t.fork()
    await check(t, 'printf gone >/tmp/shared')
    await check(child, 'rm /tmp/shared')
    const result = await t.run('cat /tmp/shared')
    assert.equal(result.exitCode, 1)
    assert.match(result.stderr, /No such file or directory/u)
    assert.deepEqual(result.unsupported, [])
  })

  it('carries an in-place edit across', async () => {
    const t = terminal()
    const child = t.fork()
    await check(t, 'cat /repo/src/a.js >/tmp/copy')
    await check(child, "sed -i 's/alpha/omega/' /tmp/copy")
    await check(t, 'cat /tmp/copy', 'omega\n')
    await check(t, 'cat /repo/src/a.js', 'alpha\n')
  })

  it('gives a fork of a read-only terminal no /tmp/ either', async () => {
    const child = terminal({ writable: false }).fork()
    const missing = await child.run('ls -d /tmp')
    assert.notEqual(missing.exitCode, 0)
    assert.deepEqual(missing.unsupported, [])
    const refused = await child.run('printf bad >/tmp/shared')
    assert.notEqual(refused.exitCode, 0)
    assert.match(refused.stderr, /read-only/u)
    assert.ok(refused.unsupported.length > 0, JSON.stringify(refused))
  })
})

describe('fork — the sources, the mount and the wired commands are the parent ones', () => {
  const commands = { shout: ({ args }) => args.join(' ').toUpperCase() + '\n' }

  it('runs, completes and resolves the commands the parent was wired with', async () => {
    const child = terminal({ commands }).fork({ cwd: 'src' })
    await check(child, 'shout hello', 'HELLO\n')
    assert.deepEqual(child.complete('shou'), ['shout'])
    await check(child, 'which shout', '/usr/bin/shout\n')
  })

  it('keeps the source tree read-only for the child', async () => {
    const t = terminal()
    const child = t.fork()
    const refused = await child.run('printf bad >/repo/README.md')
    assert.notEqual(refused.exitCode, 0)
    assert.ok(refused.unsupported.length > 0, JSON.stringify(refused))
    await check(t, 'cat /repo/README.md', 'readme\n')
  })

  it('runs a line against the same write policy', async () => {
    const t = terminal({ writable: false })
    assert.deepEqual((await t.fork().run('printf x >/tmp/out')).unsupported.map((gap) => gap.detail), ['>'])
    assert.equal((await t.fork().run('printf x')).stdout, 'x')
    assert.equal((await t.fork().run('printf x >/dev/null')).exitCode, 0)
  })
})

describe('fork options', () => {
  it('takes a relative cwd from the parent current directory', async () => {
    const t = terminal()
    await check(t, 'cd src', '', '/repo/src')
    assert.equal(t.fork({ cwd: 'util' }).cwd(), '/repo/src/util')
    assert.equal(t.fork({ cwd: '../src/./util/..' }).cwd(), '/repo/src')
    assert.equal(t.fork({ cwd: '/repo' }).cwd(), '/repo')
    assert.equal(t.fork({ cwd: '/tmp' }).cwd(), '/tmp')
    assert.equal(t.cwd(), '/repo/src')
  })

  it('takes home and user of its own', async () => {
    const t = terminal({ home: '/repo/home', user: 'ada' })
    await check(t.fork({ home: '/repo/src', user: 'grace' }), 'echo ~ $HOME; whoami', '/repo/src /repo/src\ngrace\n')
    await check(t.fork(), 'echo ~; whoami', '/repo/home\nada\n')
  })

  it('refuses a cwd that is not a directory', () => {
    const t = terminal()
    assert.throws(() => t.fork({ cwd: '/nope' }), /fork: cwd is not a directory: \/nope/u)
    assert.throws(() => t.fork({ cwd: 'README.md' }), /fork: cwd is not a directory: \/repo\/README\.md/u)
  })

  it('refuses a path that is not a string, or holds a NUL', () => {
    const t = terminal()
    for (const cwd of [1, null, ['/repo'], '/repo\0']) {
      assert.throws(() => t.fork({ cwd }), /fork: cwd must be a string without NUL characters/u)
    }
    assert.throws(() => t.fork({ home: '/repo\0' }), /fork: home must be a string without NUL characters/u)
  })

  it('refuses an option a fork cannot honor rather than dropping it', async () => {
    const t = terminal()
    for (const opts of [{ writable: false }, { mount: '/other' }, { commands: {} }, { cwd: '/repo', user: 'ada', bogus: 1 }]) {
      assert.throws(() => t.fork(opts), /fork: unknown option/u)
    }
    await check(t, 'cat /repo/README.md', 'readme\n')
  })

  it('refuses options that are not an object', () => {
    const t = terminal()
    for (const opts of [null, 'src', 7, ['src']]) {
      assert.throws(() => t.fork(opts), /fork: options must be an object/u)
    }
    assert.equal(t.fork().cwd(), '/repo')
    for (const opts of [undefined, {}]) assert.equal(t.fork(opts).cwd(), '/repo')
  })
})

describe('fork — every terminal answers for its own line', () => {
  it('keeps diagnostics and notes with the terminal that ran the line', async () => {
    const t = terminal()
    const child = t.fork()
    const gap = await child.run('shopt -s nullglob')
    assert.deepEqual(gap.unsupported.map(({ detail }) => detail), ['shopt'])
    await check(t, 'cat /repo/README.md', 'readme\n')
    const noted = await child.run('ls /repo/src')
    assert.deepEqual(noted.notes, [])
    await check(t, 'echo after', 'after\n')
  })

  it('forks a fork, without either reaching the terminal it came from', async () => {
    const t = terminal()
    await check(t, 'FOO=parent')
    const child = t.fork({ cwd: 'src' })
    await check(child, 'FOO=child; cd util', '', '/repo/src/util')
    const grandchild = child.fork()
    assert.equal(grandchild.cwd(), '/repo/src/util')
    await check(grandchild, 'echo $FOO; pwd', 'child\n/repo/src/util\n')
    await check(grandchild, 'cd /repo; FOO=grandchild', '', '/repo')
    await check(child, 'pwd; echo $FOO', '/repo/src/util\nchild\n')
    await check(t, 'pwd; echo $FOO', '/repo\nparent\n')
  })

  it('completes and reads paths from the fork own directory', async () => {
    const t = terminal()
    const child = t.fork({ cwd: 'src' })
    assert.deepEqual(child.complete('cat a'), ['cat a.js'])
    assert.deepEqual(t.complete('cat a'), [])
    assert.deepEqual(t.complete('cat src/a'), ['cat src/a.js'])
    await check(child, 'cat a.js', 'alpha\n')
  })
})

describe('fork — the self-output guard covers both terminals', () => {
  it('still catches the parent own streaming self-output after a fork', async () => {
    const t = terminal()
    await check(t, 'cat /repo/src/a.js >/tmp/file')
    t.fork()
    for (const at of [t, t.fork()]) {
      const result = await at.run('cut -c1 /tmp/file 2>/dev/null >>/tmp/file | cat')
      assert.deepEqual(result.unsupported.map(({ detail }) => detail), ['streaming self-output'], JSON.stringify(result))
      await check(t, 'cat /tmp/file', 'alpha\n')
    }
  })

  it('catches a line a command runs writing into a file the line is streaming', async () => {
    // A command runs its own line inside the turn it is holding, so what it
    // writes there lands in the middle of whatever the line around it is
    // reading — which is the guard's business, wherever the write came from.
    const gaps = []
    const commands = {
      poke: async ({ run }) => {
        const result = await run('printf changed >>/tmp/file')
        gaps.push(...result.unsupported.map(({ detail }) => detail))
        return ''
      },
    }
    const t = terminal({ commands })
    await check(t, 'cat /repo/src/a.js >/tmp/file')
    await check(t, 'xargs -I{} poke </tmp/file')
    assert.deepEqual(gaps, ['streaming self-output'])
    await check(t, 'cat /tmp/file', 'alpha\n')
  })

  it('has a fork wait for the line in flight rather than writing into it', async () => {
    // A fork writing in the middle of a line its parent was streaming is what
    // the guard used to catch. The turn is the tree's rather than either
    // terminal's now, so the fork's line waits for the parent's to end and
    // writes after it, and there is nothing left to catch.
    const t = terminal()
    const child = t.fork()
    await check(t, 'cat /repo/src/a.js >/tmp/file')
    const streaming = t.run('cut -c1 /tmp/file | cat')
    const poke = child.run('printf changed >>/tmp/file')
    assert.deepEqual(await streaming, { stdout: 'a\n', stderr: '', exitCode: 0, cwd: '/repo', notes: [], unsupported: [] })
    assert.equal((await poke).exitCode, 0)
    await check(t, 'cat /tmp/file', 'alpha\nchanged')
  })
})
