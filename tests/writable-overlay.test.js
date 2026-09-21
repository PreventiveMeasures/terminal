import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const SOURCES = { 'README.md': 'source readme\n', 'src/a.js': 'source alpha\n', 'tmp/source.txt': 'mounted source\n' }
const OPTIONS = { mount: '/repo', cwd: '/repo', writable: '/tmp/' }
const terminal = (options = {}) => createTerminal(SOURCES, { ...OPTIONS, ...options })

async function check(t, command, stdout = '', cwd = t.cwd()) {
  assert.deepEqual(await t.run(command), { stdout, stderr: '', exitCode: 0, cwd, notes: [], unsupported: [] }, command)
}

describe('writable option validation', () => {
  for (const writable of [true, null, 0, '', '/tmp', 'tmp/', '/tmp//', '/tmp/./', '/other/', {}, [], '/tmp/\0']) {
    it(`rejects ${JSON.stringify(writable)}`, () => {
      assert.throws(() => terminal({ writable }), /writable/u)
    })
  }

  for (const mount of ['/', '', '.', '/tmp', '/tmp/', 'tmp', '/tmp/repo', '/tmp/./repo', '/work/../tmp/repo', '/tmp/..']) {
    it(`rejects normalized source mount ${JSON.stringify(mount)} while writable`, () => {
      assert.throws(() => createTerminal({}, { mount, writable: '/tmp/' }), /mount/u)
    })
  }

  it('requires a non-root source mount when writable is enabled', () => {
    assert.throws(() => createTerminal({}, { writable: '/tmp/' }), /mount/u)
  })

  for (const mount of ['/repo', '/tmp2', '/tmp-work', '/tmpx/repo', '/repo/./src/..']) {
    it(`allows disjoint normalized source mount ${JSON.stringify(mount)}`, async () => {
      const t = createTerminal({}, { mount, writable: '/tmp/' })
      await check(t, 'ls -d /tmp', '/tmp\n')
      await check(t, 'printf ok >/tmp/result; cat /tmp/result', 'ok')
    })
  }
})

describe('disabled writable mode keeps the previous read-only behavior', () => {
  for (const writable of [false, undefined]) {
    it(`keeps writes unsupported for ${String(writable)}`, async () => {
      const t = terminal({ writable })
      const result = await t.run('printf bad 2>/dev/null >/tmp/result | cat')
      assert.match(result.stderr, /read-only/u)
      assert.notEqual(result.exitCode, 0)
      assert.ok(result.unsupported.length > 0)
      await check(t, 'cat README.md', 'source readme\n')
      const missing = await t.run('ls -d /tmp')
      assert.notEqual(missing.exitCode, 0)
      assert.deepEqual(missing.unsupported, [])
      await check(t, 'printf ignored >/dev/null')
    })

    it(`does not restrict source mounts for ${String(writable)}`, async () => {
      const root = createTerminal({ file: 'root' }, { writable })
      const tmp = createTerminal({ file: 'tmp' }, { mount: '/tmp', writable })
      await check(root, 'cat /file', 'root')
      await check(tmp, 'cat /tmp/file', 'tmp')
    })
  }
})

describe('the writable overlay is separate, persistent and private', () => {
  it('creates an empty /tmp directory independently of empty source mounts', async () => {
    const t = createTerminal({}, OPTIONS)
    await check(t, 'ls /', 'repo\ntmp\n')
    await check(t, 'ls /tmp')
    await check(t, 'find /tmp', '/tmp\n')
    assert.deepEqual(t.complete('cat /tmp/'), [])
  })

  for (const [name, sources] of [
    ['object', Object.freeze({ ...SOURCES })],
    ['Map', new Map(Object.entries(SOURCES))],
  ]) {
    it(`does not modify the caller's ${name} source map`, async () => {
      const before = sources instanceof Map ? [...sources] : Object.entries(sources)
      const t = createTerminal(sources, OPTIONS)
      await check(t, 'printf changed >/tmp/README.md; printf scratch >/tmp/source.txt')
      await check(t, 'cat README.md /repo/tmp/source.txt', 'source readme\nmounted source\n')
      await check(t, 'cat /tmp/README.md /tmp/source.txt', 'changedscratch')
      assert.deepEqual(sources instanceof Map ? [...sources] : Object.entries(sources), before)
    })
  }

  it('retains appended and overwritten content across run calls', async () => {
    const t = terminal()
    await check(t, "printf 'first\\n' >/tmp/log")
    await check(t, 'cat /tmp/log', 'first\n')
    await check(t, "printf 'second\\n' >>/tmp/log")
    await check(t, 'cat /tmp/log', 'first\nsecond\n')
    await check(t, "printf 'replacement\\n' >/tmp/log")
    await check(t, 'cat /tmp/log', 'replacement\n')
    await check(t, ': >/tmp/log')
    await check(t, 'cat /tmp/log')
    await check(t, 'ls /tmp', 'log\n')
  })

  it('does not share writable files between terminals using the same source map', async () => {
    const a = terminal(), b = terminal()
    await check(a, 'printf first >/tmp/shared')
    const missing = await b.run('cat /tmp/shared')
    assert.notEqual(missing.exitCode, 0)
    assert.deepEqual(missing.unsupported, [])
    await check(b, 'printf second >/tmp/shared')
    await check(a, 'cat /tmp/shared', 'first')
    await check(b, 'cat /tmp/shared', 'second')
  })

  it('records stderr while preserving the command failure status', async () => {
    const t = terminal()
    const failed = await t.run('cat missing 2>/tmp/errors')
    assert.equal(failed.stdout, '')
    assert.equal(failed.stderr, '')
    assert.equal(failed.exitCode, 1)
    assert.deepEqual(failed.unsupported, [])
    await check(t, 'cat /tmp/errors', 'cat: missing: No such file or directory\n')
  })

  it('still reports unsupported commands when stderr is redirected to a file', async () => {
    const t = terminal()
    const result = await t.run('notacommand 2>/tmp/errors | cat')
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.equal(result.unsupported.length, 1)
    assert.equal(result.unsupported[0].command, 'notacommand')
    assert.match((await t.run('cat /tmp/errors')).stdout, /notacommand: command not found/u)
  })
})

describe('existing filesystem consumers see current overlay contents', () => {
  it('updates listings, find, globs, readers and completion after writes', async () => {
    const t = terminal()
    await check(t, 'ls /tmp')
    assert.deepEqual(t.complete('cat /tmp/'), [])
    await check(t, "printf 'beta\\nalpha\\n' >/tmp/alpha.txt; printf 'export x\\n' >/tmp/zeta.js; printf hidden >/tmp/.hidden")
    assert.deepEqual(await t.run('ls /tmp'), {
      stdout: 'alpha.txt\nzeta.js\n', stderr: '', exitCode: 0, cwd: '/repo', unsupported: [],
      notes: ['ls: omitted 1 hidden entry: "/tmp/.hidden". Hidden entries are included with -a.'],
    })
    await check(t, 'ls -A /tmp', '.hidden\nalpha.txt\nzeta.js\n')
    await check(t, 'find /tmp -type f', '/tmp/.hidden\n/tmp/alpha.txt\n/tmp/zeta.js\n')
    // `.hidden` is not a `.txt` name, so the dotfile gate changed nothing here.
    check(t, "printf '%s\\n' /tmp/*.txt", '/tmp/alpha.txt\n')
    assert.deepEqual(await t.run("printf '%s\\n' /tmp/*"), {
      stdout: '/tmp/alpha.txt\n/tmp/zeta.js\n', stderr: '', exitCode: 0, cwd: '/repo', unsupported: [],
      notes: ['glob: omitted 1 hidden entry while expanding "/tmp/*": "/tmp/.hidden".'],
    })
    await check(t, 'cat /tmp/alpha.txt | sort', 'alpha\nbeta\n')
    await check(t, 'grep -rn export /tmp', '/tmp/zeta.js:1:export x\n')
    await check(t, 'cat </tmp/alpha.txt', 'beta\nalpha\n')
    assert.deepEqual(t.complete('cat /tmp/al'), ['cat /tmp/alpha.txt'])
    assert.deepEqual(t.complete('cat /tmp/.'), ['cat /tmp/.hidden'])
    assert.deepEqual(t.complete('cd /tmp/a'), [])
    await check(t, "printf 'updated\\n' >/tmp/alpha.txt; grep updated /tmp/alpha.txt", 'updated\n')
    await check(t, 'find /tmp -type f | wc -l', '3\n')
  })

  it('uses /tmp as a configured home and supports relative output there', async () => {
    const t = terminal({ home: '/tmp' })
    await check(t, 'cd; pwd; printf note >~/note.txt', '/tmp\n', '/tmp')
    await check(t, 'printf more >>note.txt; cat ~/note.txt', 'notemore')
    assert.deepEqual(t.complete('cat ~/no'), ['cat ~/note.txt'])
    await check(t, 'cat /repo/README.md', 'source readme\n')
  })

  it('allows the initial cwd to be the empty writable directory', async () => {
    const t = terminal({ cwd: '/tmp' })
    await check(t, 'pwd; printf initial >result; cat result', '/tmp\ninitial')
  })

  it('preserves filenames with spaces and Unicode', async () => {
    const t = terminal()
    await check(t, "printf one >'/tmp/two words.txt'; printf unicode >'/tmp/é.txt'")
    await check(t, "cat '/tmp/two words.txt' '/tmp/é.txt'", 'oneunicode')
    await check(t, "printf '[%s]\\n' /tmp/*.txt", '[/tmp/two words.txt]\n[/tmp/é.txt]\n')
  })

  it('makes current overlay files visible through custom filesystem views', async () => {
    let saved
    const t = terminal({ commands: {
      capture: ({ fs }) => { saved = fs },
      inspect: ({ fs }) => JSON.stringify({
        files: fs.walkFiles('/tmp'), listing: fs.listDir('/tmp'),
        content: fs.readFile('/tmp/result'), original: fs.readFile('/repo/README.md'),
      }),
      read: ({ args, readInputs }) => {
        const r = readInputs(args)
        return { stdout: r.inputs.map((entry) => entry.content).join(''), stderr: r.stderr, exitCode: r.failed ? 1 : 0 }
      },
    } })
    await check(t, 'capture; printf overlay >/tmp/result')
    assert.deepEqual(saved.walkFiles('/tmp'), ['/tmp/result'])
    await check(t, 'inspect', JSON.stringify({
      files: ['/tmp/result'], listing: { dirs: [], files: ['result'], links: [] }, content: 'overlay', original: 'source readme\n',
    }))
    await check(t, 'read /tmp/result /repo/README.md', 'overlaysource readme\n')
  })
})

describe('output paths respect the writable directory boundary', () => {
  for (const path of ['/repo/README.md', '/new', '/tmp-other/result', '/tmp/../repo/README.md', '/tmp/../outside']) {
    it(`diagnoses output outside /tmp: ${path}`, async () => {
      const t = terminal()
      const result = await t.run(`printf corrupt 2>/dev/null >${path} | cat`)
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
      assert.ok(result.unsupported.length > 0)
      await check(t, 'cat README.md', 'source readme\n')
      await check(t, 'ls /tmp')
    })
  }

  it('diagnoses append outside /tmp without altering source content', async () => {
    const t = terminal()
    const result = await t.run('printf corrupt 2>/dev/null >>/repo/README.md | cat')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.ok(result.unsupported.length > 0)
    await check(t, 'cat README.md', 'source readme\n')
  })

  for (const path of ['/tmp/missing/result', '/tmp/missing/../result', '/tmp/file/child', '/tmp/file/../result', '/tmp/file/./result', '/tmp/file/', '/tmp/new/', '/tmp', '/tmp/']) {
    it(`reports an ordinary path error for ${path}`, async () => {
      const t = terminal()
      await check(t, 'printf existing >/tmp/file')
      const result = await t.run(`printf bad >${path}`)
      assert.equal(result.stdout, '')
      assert.notEqual(result.exitCode, 0)
      assert.notEqual(result.stderr, '')
      assert.deepEqual(result.unsupported, [])
      await check(t, 'cat /tmp/file', 'existing')
      await check(t, 'ls /tmp', 'file\n')
    })
  }

  it('normalizes valid directory traversal without fabricating directories', async () => {
    const t = terminal()
    await check(t, 'printf valid >/tmp/../tmp/result; cat /tmp/./result', 'valid')
    await check(t, 'printf relative >../tmp/from-relative; printf source >/repo/src/../../tmp/from-source')
    await check(t, 'cat /tmp/from-relative /tmp/from-source', 'relativesource')
    // A redirect makes the file it names and nothing above it; making the
    // directory is `mkdir`'s to do, and then the same redirect lands.
    const result = await t.run('printf x >/tmp/nested/file')
    assert.notEqual(result.exitCode, 0)
    assert.deepEqual(result.unsupported, [])
    await check(t, 'ls /tmp', 'from-relative\nfrom-source\nresult\n')
    await check(t, 'mkdir /tmp/nested; printf x >/tmp/nested/file; cat /tmp/nested/file', 'x')
  })
})
