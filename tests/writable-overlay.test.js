import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const SOURCES = { 'README.md': 'source readme\n', 'src/a.js': 'source alpha\n', 'tmp/source.txt': 'mounted source\n' }
const OPTIONS = { mount: '/repo', cwd: '/repo', writable: '/tmp/' }
const terminal = (options = {}) => createTerminal(SOURCES, { ...OPTIONS, ...options })

function check(t, command, stdout = '', cwd = t.cwd()) {
  assert.deepEqual(t.run(command), { stdout, stderr: '', exitCode: 0, cwd, notes: [], unsupported: [] }, command)
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
    it(`allows disjoint normalized source mount ${JSON.stringify(mount)}`, () => {
      const t = createTerminal({}, { mount, writable: '/tmp/' })
      check(t, 'ls -d /tmp', '/tmp\n')
      check(t, 'printf ok >/tmp/result; cat /tmp/result', 'ok')
    })
  }
})

describe('disabled writable mode keeps the previous read-only behavior', () => {
  for (const writable of [false, undefined]) {
    it(`keeps writes unsupported for ${String(writable)}`, () => {
      const t = terminal({ writable })
      const result = t.run('printf bad 2>/dev/null >/tmp/result | cat')
      assert.match(result.stderr, /read-only/u)
      assert.notEqual(result.exitCode, 0)
      assert.ok(result.unsupported.length > 0)
      check(t, 'cat README.md', 'source readme\n')
      const missing = t.run('ls -d /tmp')
      assert.notEqual(missing.exitCode, 0)
      assert.deepEqual(missing.unsupported, [])
      check(t, 'printf ignored >/dev/null')
    })

    it(`does not restrict source mounts for ${String(writable)}`, () => {
      const root = createTerminal({ file: 'root' }, { writable })
      const tmp = createTerminal({ file: 'tmp' }, { mount: '/tmp', writable })
      check(root, 'cat /file', 'root')
      check(tmp, 'cat /tmp/file', 'tmp')
    })
  }
})

describe('the writable overlay is separate, persistent and private', () => {
  it('creates an empty /tmp directory independently of empty source mounts', () => {
    const t = createTerminal({}, OPTIONS)
    check(t, 'ls /', 'repo\ntmp\n')
    check(t, 'ls /tmp')
    check(t, 'find /tmp', '/tmp\n')
    assert.deepEqual(t.complete('cat /tmp/'), [])
  })

  for (const [name, sources] of [
    ['object', Object.freeze({ ...SOURCES })],
    ['Map', new Map(Object.entries(SOURCES))],
  ]) {
    it(`does not modify the caller's ${name} source map`, () => {
      const before = sources instanceof Map ? [...sources] : Object.entries(sources)
      const t = createTerminal(sources, OPTIONS)
      check(t, 'printf changed >/tmp/README.md; printf scratch >/tmp/source.txt')
      check(t, 'cat README.md /repo/tmp/source.txt', 'source readme\nmounted source\n')
      check(t, 'cat /tmp/README.md /tmp/source.txt', 'changedscratch')
      assert.deepEqual(sources instanceof Map ? [...sources] : Object.entries(sources), before)
    })
  }

  it('retains appended and overwritten content across run calls', () => {
    const t = terminal()
    check(t, "printf 'first\\n' >/tmp/log")
    check(t, 'cat /tmp/log', 'first\n')
    check(t, "printf 'second\\n' >>/tmp/log")
    check(t, 'cat /tmp/log', 'first\nsecond\n')
    check(t, "printf 'replacement\\n' >/tmp/log")
    check(t, 'cat /tmp/log', 'replacement\n')
    check(t, ': >/tmp/log')
    check(t, 'cat /tmp/log')
    check(t, 'ls /tmp', 'log\n')
  })

  it('does not share writable files between terminals using the same source map', () => {
    const a = terminal(), b = terminal()
    check(a, 'printf first >/tmp/shared')
    const missing = b.run('cat /tmp/shared')
    assert.notEqual(missing.exitCode, 0)
    assert.deepEqual(missing.unsupported, [])
    check(b, 'printf second >/tmp/shared')
    check(a, 'cat /tmp/shared', 'first')
    check(b, 'cat /tmp/shared', 'second')
  })

  it('records stderr while preserving the command failure status', () => {
    const t = terminal()
    const failed = t.run('cat missing 2>/tmp/errors')
    assert.equal(failed.stdout, '')
    assert.equal(failed.stderr, '')
    assert.equal(failed.exitCode, 1)
    assert.deepEqual(failed.unsupported, [])
    check(t, 'cat /tmp/errors', 'cat: missing: no such file or directory\n')
  })

  it('still reports unsupported commands when stderr is redirected to a file', () => {
    const t = terminal()
    const result = t.run('notacommand 2>/tmp/errors | cat')
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.equal(result.unsupported.length, 1)
    assert.equal(result.unsupported[0].command, 'notacommand')
    assert.match(t.run('cat /tmp/errors').stdout, /notacommand: command not found/u)
  })
})

describe('existing filesystem consumers see current overlay contents', () => {
  it('updates listings, find, globs, readers and completion after writes', () => {
    const t = terminal()
    check(t, 'ls /tmp')
    assert.deepEqual(t.complete('cat /tmp/'), [])
    check(t, "printf 'beta\\nalpha\\n' >/tmp/alpha.txt; printf 'export x\\n' >/tmp/zeta.js; printf hidden >/tmp/.hidden")
    assert.deepEqual(t.run('ls /tmp'), {
      stdout: 'alpha.txt\nzeta.js\n', stderr: '', exitCode: 0, cwd: '/repo', unsupported: [],
      notes: ['ls: omitted 1 hidden entry: "/tmp/.hidden". Hidden entries are included with -a.'],
    })
    check(t, 'ls -A /tmp', '.hidden\nalpha.txt\nzeta.js\n')
    check(t, 'find /tmp -type f', '/tmp/.hidden\n/tmp/alpha.txt\n/tmp/zeta.js\n')
    assert.deepEqual(t.run("printf '%s\\n' /tmp/*.txt"), {
      stdout: '/tmp/alpha.txt\n', stderr: '', exitCode: 0, cwd: '/repo', unsupported: [],
      notes: ['glob: omitted 1 hidden entry while expanding "/tmp/*.txt": "/tmp/.hidden". Dot-prefixed patterns can include hidden entries.'],
    })
    check(t, 'cat /tmp/alpha.txt | sort', 'alpha\nbeta\n')
    check(t, 'grep -rn export /tmp', '/tmp/zeta.js:1:export x\n')
    check(t, 'cat </tmp/alpha.txt', 'beta\nalpha\n')
    assert.deepEqual(t.complete('cat /tmp/al'), ['cat /tmp/alpha.txt'])
    assert.deepEqual(t.complete('cat /tmp/.'), ['cat /tmp/.hidden'])
    assert.deepEqual(t.complete('cd /tmp/a'), [])
    check(t, "printf 'updated\\n' >/tmp/alpha.txt; grep updated /tmp/alpha.txt", 'updated\n')
    check(t, 'find /tmp -type f | wc -l', '3\n')
  })

  it('uses /tmp as a configured home and supports relative output there', () => {
    const t = terminal({ home: '/tmp' })
    check(t, 'cd; pwd; printf note >~/note.txt', '/tmp\n', '/tmp')
    check(t, 'printf more >>note.txt; cat ~/note.txt', 'notemore')
    assert.deepEqual(t.complete('cat ~/no'), ['cat ~/note.txt'])
    check(t, 'cat /repo/README.md', 'source readme\n')
  })

  it('allows the initial cwd to be the empty writable directory', () => {
    const t = terminal({ cwd: '/tmp' })
    check(t, 'pwd; printf initial >result; cat result', '/tmp\ninitial')
  })

  it('preserves filenames with spaces and Unicode', () => {
    const t = terminal()
    check(t, "printf one >'/tmp/two words.txt'; printf unicode >'/tmp/é.txt'")
    check(t, "cat '/tmp/two words.txt' '/tmp/é.txt'", 'oneunicode')
    check(t, "printf '[%s]\\n' /tmp/*.txt", '[/tmp/two words.txt]\n[/tmp/é.txt]\n')
  })

  it('makes current overlay files visible through custom filesystem views', () => {
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
    check(t, 'capture; printf overlay >/tmp/result')
    assert.deepEqual(saved.walkFiles('/tmp'), ['/tmp/result'])
    check(t, 'inspect', JSON.stringify({
      files: ['/tmp/result'], listing: { dirs: [], files: ['result'] }, content: 'overlay', original: 'source readme\n',
    }))
    check(t, 'read /tmp/result /repo/README.md', 'overlaysource readme\n')
  })
})

describe('output paths respect the writable directory boundary', () => {
  for (const path of ['/repo/README.md', '/new', '/tmp-other/result', '/tmp/../repo/README.md', '/tmp/../outside']) {
    it(`diagnoses output outside /tmp: ${path}`, () => {
      const t = terminal()
      const result = t.run(`printf corrupt 2>/dev/null >${path} | cat`)
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
      assert.ok(result.unsupported.length > 0)
      check(t, 'cat README.md', 'source readme\n')
      check(t, 'ls /tmp')
    })
  }

  it('diagnoses append outside /tmp without altering source content', () => {
    const t = terminal()
    const result = t.run('printf corrupt 2>/dev/null >>/repo/README.md | cat')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.ok(result.unsupported.length > 0)
    check(t, 'cat README.md', 'source readme\n')
  })

  for (const path of ['/tmp/missing/result', '/tmp/missing/../result', '/tmp/file/child', '/tmp/file/../result', '/tmp/file/./result', '/tmp/file/', '/tmp/new/', '/tmp', '/tmp/']) {
    it(`reports an ordinary path error for ${path}`, () => {
      const t = terminal()
      check(t, 'printf existing >/tmp/file')
      const result = t.run(`printf bad >${path}`)
      assert.equal(result.stdout, '')
      assert.notEqual(result.exitCode, 0)
      assert.notEqual(result.stderr, '')
      assert.deepEqual(result.unsupported, [])
      check(t, 'cat /tmp/file', 'existing')
      check(t, 'ls /tmp', 'file\n')
    })
  }

  it('normalizes valid directory traversal without fabricating directories', () => {
    const t = terminal()
    check(t, 'printf valid >/tmp/../tmp/result; cat /tmp/./result', 'valid')
    check(t, 'printf relative >../tmp/from-relative; printf source >/repo/src/../../tmp/from-source')
    check(t, 'cat /tmp/from-relative /tmp/from-source', 'relativesource')
    const result = t.run('mkdir /tmp/nested 2>/dev/null | cat')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.ok(result.unsupported.length > 0)
    check(t, 'ls /tmp', 'from-relative\nfrom-source\nresult\n')
  })
})
