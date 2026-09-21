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
function check(t, command, stdout = '', cwd = t.cwd()) {
  assert.deepEqual(t.run(command), { stdout, stderr: '', exitCode: 0, cwd, notes: [], unsupported: [] }, command)
}

describe('fork — what a child takes from its parent', () => {
  it('starts where the parent stands', () => {
    const t = terminal()
    check(t, 'cd src', '', '/repo/src')
    const child = t.fork()
    assert.equal(child.cwd(), '/repo/src')
    check(child, 'pwd; cat a.js', '/repo/src\nalpha\n')
  })

  it('copies the variables the parent has set', () => {
    const t = terminal()
    check(t, 'FOO=parent; export BAR=exported')
    check(t.fork(), 'echo $FOO $BAR', 'parent exported\n')
  })

  it('copies names the parent unset, so the child does not warn about them either', () => {
    const t = terminal()
    check(t, 'FOO=parent; unset FOO')
    check(t.fork(), 'echo "[$FOO]"', '[]\n')
  })

  it('copies the parent functions', () => {
    const t = terminal()
    check(t, 'greet() { echo hi; }')
    check(t.fork(), 'greet', 'hi\n')
  })

  it('copies the last exit status', () => {
    const t = terminal()
    assert.equal(t.run('false').exitCode, 1)
    check(t.fork(), 'echo $?', '1\n')
  })

  it('keeps the parent home and user', () => {
    const t = terminal({ home: '/repo/home', user: 'ada' })
    check(t.fork(), 'echo ~ $HOME; whoami; cat ~/note.txt', '/repo/home /repo/home\nada\nnote\n')
  })

  it('keeps a HOME the parent assigned, which stands in front of the home option as it does in the parent', () => {
    const t = terminal({ home: '/repo/home' })
    check(t, 'HOME=/repo/src')
    check(t.fork(), 'echo ~', '/repo/src\n')
    check(t.fork({ home: '/repo' }), 'echo ~', '/repo/src\n')
    check(t.fork({ home: '/repo' }), 'unset HOME; echo ~', '/repo\n')
  })
})

describe('fork — a child and its parent go their own way', () => {
  it('a cd on either side leaves the other where it was', () => {
    const t = terminal()
    const child = t.fork()
    check(child, 'cd src/util', '', '/repo/src/util')
    assert.equal(t.cwd(), '/repo')
    check(t, 'cd src', '', '/repo/src')
    assert.equal(child.cwd(), '/repo/src/util')
    check(child, 'pwd', '/repo/src/util\n')
    check(t, 'pwd', '/repo/src\n')
  })

  it('an assignment after the fork does not cross, in either direction', () => {
    const t = terminal()
    check(t, 'FOO=before; export SHIPPED=before')
    const child = t.fork()
    check(child, 'echo $FOO $SHIPPED', 'before before\n')
    // There is no environment to export to here, so an exported name is a
    // variable like any other: copied at the fork, each terminal's own after it.
    check(t, 'FOO=parent; export ONLY_PARENT=p')
    check(child, 'FOO=child; export ONLY_CHILD=c')
    check(t, 'echo $FOO $ONLY_PARENT', 'parent p\n')
    check(child, 'echo $FOO $ONLY_CHILD', 'child c\n')
    for (const [t2, name] of [[t, 'ONLY_CHILD'], [child, 'ONLY_PARENT']]) {
      const result = t2.run(`echo $${name}`)
      assert.equal(result.stdout, '\n')
      assert.deepEqual(result.unsupported.map(({ detail }) => detail), [`$${name}`])
    }
  })

  it('unset in the child leaves the parent variable alone', () => {
    const t = terminal()
    check(t, 'FOO=parent')
    const child = t.fork()
    check(child, 'unset FOO; echo "[$FOO]"', '[]\n')
    check(t, 'echo $FOO', 'parent\n')
  })

  it('a function defined after the fork does not cross', () => {
    const t = terminal()
    const child = t.fork()
    check(child, 'greet() { echo hi; }; greet', 'hi\n')
    const result = t.run('greet')
    assert.equal(result.exitCode, 127)
    assert.match(result.stderr, /greet: command not found/u)
    assert.deepEqual(result.unsupported.map(({ kind, detail }) => [kind, detail]), [['command', 'greet']])
  })

  it('keeps each exit status to its own terminal', () => {
    const t = terminal()
    const child = t.fork()
    assert.equal(t.run('false').exitCode, 1)
    check(child, 'echo $?', '0\n')
    check(t, 'echo $?', '1\n')
  })
})

describe('fork — inherit: false hands the child no session at all', () => {
  function loaded() {
    const t = terminal({ home: '/repo/home', user: 'ada' })
    check(t, 'FOO=parent; export SHIPPED=parent; GONE=x; unset GONE; greet() { echo hi; }')
    assert.equal(t.run('false').exitCode, 1)
    return t
  }

  it('starts with no variables, set or known-unset', () => {
    const child = loaded().fork({ inherit: false })
    for (const name of ['FOO', 'SHIPPED', 'GONE']) {
      const result = child.run(`echo $${name}`)
      assert.equal(result.stdout, '\n')
      // A name the parent unset is known-empty there and unknown here: the
      // child never saw it, so it says so rather than staying quiet.
      assert.deepEqual(result.unsupported.map(({ detail }) => detail), [`$${name}`])
    }
  })

  it('starts with no functions', () => {
    const result = loaded().fork({ inherit: false }).run('greet')
    assert.equal(result.exitCode, 127)
    assert.deepEqual(result.unsupported.map(({ kind, detail }) => [kind, detail]), [['command', 'greet']])
  })

  it('starts with nothing to report as the last exit status', () => {
    check(loaded().fork({ inherit: false }), 'echo $?', '0\n')
    check(loaded().fork(), 'echo $?', '1\n')
  })

  it('leaves the parent session where it was', () => {
    const t = loaded()
    t.fork({ inherit: false }).run('FOO=child')
    check(t, 'echo $FOO $SHIPPED; greet', 'parent parent\nhi\n')
  })

  it('still stands where the parent stands, under the parent home and user', () => {
    const t = loaded()
    check(t, 'cd src', '', '/repo/src')
    const child = t.fork({ inherit: false })
    assert.equal(child.cwd(), '/repo/src')
    check(child, 'pwd; echo ~; whoami', '/repo/src\n/repo/home\nada\n')
  })

  it('lets a home and a user of its own actually take, with no inherited HOME in front', () => {
    const t = loaded()
    check(t, 'HOME=/repo/src')
    check(t.fork({ home: '/repo' }), 'echo ~', '/repo/src\n')
    check(t.fork({ inherit: false, home: '/repo', user: 'grace' }), 'echo ~ $HOME; whoami', '/repo /repo\ngrace\n')
  })

  it('shares the filesystem, the overlay and the wired commands like any other fork', () => {
    const commands = { shout: ({ args }) => args.join(' ').toUpperCase() + '\n' }
    const t = terminal({ commands })
    check(t, 'printf from-parent >/tmp/shared')
    const child = t.fork({ inherit: false })
    check(child, 'cat /tmp/shared; cat /repo/src/a.js; shout hi', 'from-parentalpha\nHI\n')
    check(child, 'printf from-child >>/tmp/shared')
    check(t, 'cat /tmp/shared', 'from-parentfrom-child')
  })

  it('reads inherit: true as the default it is', () => {
    const t = loaded()
    check(t.fork({ inherit: true }), 'echo $FOO; greet', 'parent\nhi\n')
    check(t.fork(), 'echo $FOO; greet', 'parent\nhi\n')
  })

  it('forks a fork that inherited nothing', () => {
    const child = loaded().fork({ inherit: false })
    check(child, 'OWN=child')
    check(child.fork(), 'echo $OWN', 'child\n')
    const bare = child.fork({ inherit: false }).run('echo $OWN')
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
  it('hands the parent what the child wrote', () => {
    const t = terminal()
    const child = t.fork()
    check(child, 'printf from-child >/tmp/shared')
    check(t, 'cat /tmp/shared', 'from-child')
    check(t, 'ls /tmp', 'shared\n')
  })

  it('hands the child what the parent wrote, as it is written', () => {
    const t = terminal()
    const child = t.fork()
    check(t, 'printf one >/tmp/shared')
    check(child, 'cat /tmp/shared', 'one')
    check(t, 'printf " two" >>/tmp/shared')
    check(child, 'cat /tmp/shared', 'one two')
    check(child, 'printf " three" >>/tmp/shared')
    check(t, 'cat /tmp/shared', 'one two three')
  })

  it('lets either remove what the other wrote', () => {
    const t = terminal()
    const child = t.fork()
    check(t, 'printf gone >/tmp/shared')
    check(child, 'rm /tmp/shared')
    const result = t.run('cat /tmp/shared')
    assert.equal(result.exitCode, 1)
    assert.match(result.stderr, /No such file or directory/u)
    assert.deepEqual(result.unsupported, [])
  })

  it('carries an in-place edit across', () => {
    const t = terminal()
    const child = t.fork()
    check(t, 'cat /repo/src/a.js >/tmp/copy')
    check(child, "sed -i 's/alpha/omega/' /tmp/copy")
    check(t, 'cat /tmp/copy', 'omega\n')
    check(t, 'cat /repo/src/a.js', 'alpha\n')
  })

  it('gives a fork of a read-only terminal no /tmp/ either', () => {
    const child = terminal({ writable: false }).fork()
    const missing = child.run('ls -d /tmp')
    assert.notEqual(missing.exitCode, 0)
    assert.deepEqual(missing.unsupported, [])
    const refused = child.run('printf bad >/tmp/shared')
    assert.notEqual(refused.exitCode, 0)
    assert.match(refused.stderr, /read-only/u)
    assert.ok(refused.unsupported.length > 0, JSON.stringify(refused))
  })
})

describe('fork — the sources, the mount and the wired commands are the parent ones', () => {
  const commands = { shout: ({ args }) => args.join(' ').toUpperCase() + '\n' }

  it('runs, completes and resolves the commands the parent was wired with', () => {
    const child = terminal({ commands }).fork({ cwd: 'src' })
    check(child, 'shout hello', 'HELLO\n')
    assert.deepEqual(child.complete('shou'), ['shout'])
    check(child, 'which shout', '/usr/bin/shout\n')
  })

  it('keeps the source tree read-only for the child', () => {
    const t = terminal()
    const child = t.fork()
    const refused = child.run('printf bad >/repo/README.md')
    assert.notEqual(refused.exitCode, 0)
    assert.ok(refused.unsupported.length > 0, JSON.stringify(refused))
    check(t, 'cat /repo/README.md', 'readme\n')
  })

  it('runs a line against the same write policy', () => {
    const t = terminal({ writable: false })
    assert.deepEqual(t.fork().run('printf x >/tmp/out').unsupported.map((gap) => gap.detail), ['>'])
    assert.equal(t.fork().run('printf x').stdout, 'x')
    assert.equal(t.fork().run('printf x >/dev/null').exitCode, 0)
  })
})

describe('fork options', () => {
  it('takes a relative cwd from the parent current directory', () => {
    const t = terminal()
    check(t, 'cd src', '', '/repo/src')
    assert.equal(t.fork({ cwd: 'util' }).cwd(), '/repo/src/util')
    assert.equal(t.fork({ cwd: '../src/./util/..' }).cwd(), '/repo/src')
    assert.equal(t.fork({ cwd: '/repo' }).cwd(), '/repo')
    assert.equal(t.fork({ cwd: '/tmp' }).cwd(), '/tmp')
    assert.equal(t.cwd(), '/repo/src')
  })

  it('takes home and user of its own', () => {
    const t = terminal({ home: '/repo/home', user: 'ada' })
    check(t.fork({ home: '/repo/src', user: 'grace' }), 'echo ~ $HOME; whoami', '/repo/src /repo/src\ngrace\n')
    check(t.fork(), 'echo ~; whoami', '/repo/home\nada\n')
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

  it('refuses an option a fork cannot honor rather than dropping it', () => {
    const t = terminal()
    for (const opts of [{ writable: false }, { mount: '/other' }, { commands: {} }, { cwd: '/repo', user: 'ada', bogus: 1 }]) {
      assert.throws(() => t.fork(opts), /fork: unknown option/u)
    }
    check(t, 'cat /repo/README.md', 'readme\n')
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
  it('keeps diagnostics and notes with the terminal that ran the line', () => {
    const t = terminal()
    const child = t.fork()
    const gap = child.run('shopt -s nullglob')
    assert.deepEqual(gap.unsupported.map(({ detail }) => detail), ['shopt'])
    check(t, 'cat /repo/README.md', 'readme\n')
    const noted = child.run('ls /repo/src')
    assert.deepEqual(noted.notes, [])
    check(t, 'echo after', 'after\n')
  })

  it('forks a fork, without either reaching the terminal it came from', () => {
    const t = terminal()
    check(t, 'FOO=parent')
    const child = t.fork({ cwd: 'src' })
    check(child, 'FOO=child; cd util', '', '/repo/src/util')
    const grandchild = child.fork()
    assert.equal(grandchild.cwd(), '/repo/src/util')
    check(grandchild, 'echo $FOO; pwd', 'child\n/repo/src/util\n')
    check(grandchild, 'cd /repo; FOO=grandchild', '', '/repo')
    check(child, 'pwd; echo $FOO', '/repo/src/util\nchild\n')
    check(t, 'pwd; echo $FOO', '/repo\nparent\n')
  })

  it('completes and reads paths from the fork own directory', () => {
    const t = terminal()
    const child = t.fork({ cwd: 'src' })
    assert.deepEqual(child.complete('cat a'), ['cat a.js'])
    assert.deepEqual(t.complete('cat a'), [])
    assert.deepEqual(t.complete('cat src/a'), ['cat src/a.js'])
    check(child, 'cat a.js', 'alpha\n')
  })
})

describe('fork — the self-output guard covers both terminals', () => {
  it('still catches the parent own streaming self-output after a fork', () => {
    const t = terminal()
    check(t, 'cat /repo/src/a.js >/tmp/file')
    t.fork()
    for (const at of [t, t.fork()]) {
      const result = at.run('cut -c1 /tmp/file 2>/dev/null >>/tmp/file | cat')
      assert.deepEqual(result.unsupported.map(({ detail }) => detail), ['streaming self-output'], JSON.stringify(result))
      check(t, 'cat /tmp/file', 'alpha\n')
    }
  })

  it('catches a fork writing into a file its parent is streaming', () => {
    const gaps = []
    let child = null
    const commands = {
      poke: () => {
        const result = child.run('printf changed >>/tmp/file')
        gaps.push(...result.unsupported.map(({ detail }) => detail))
        return ''
      },
    }
    const t = terminal({ commands })
    child = t.fork()
    check(t, 'cat /repo/src/a.js >/tmp/file')
    check(t, 'xargs -I{} poke </tmp/file')
    assert.deepEqual(gaps, ['streaming self-output'])
    check(t, 'cat /tmp/file', 'alpha\n')
  })
})
