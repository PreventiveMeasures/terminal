import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const SOURCES = {
  'README.md': 'readme\n',
  'src/a.js': 'alpha\n', 'src/b.js': 'beta\n',
  'home/note.txt': 'home note\n', 'home/.hidden': 'hidden\n',
  'home/projects/demo.txt': 'demo\n', 'other/note.txt': 'other note\n',
}
const OPTIONS = { mount: '/workspace', home: '/workspace/home', cwd: '/workspace' }
const terminal = (options = {}) => createTerminal(SOURCES, { ...OPTIONS, ...options })

function check(t, command, stdout, cwd = t.cwd()) {
  assert.deepEqual(t.run(command), { stdout, stderr: '', exitCode: 0, cwd, unsupported: [] }, command)
}

describe('createTerminal source mount', () => {
  for (const [name, sources] of [['Object', SOURCES], ['Map', new Map(Object.entries(SOURCES))]]) {
    it(`mounts every ${name} source beneath the configured path`, () => {
      const t = createTerminal(sources, { mount: '/workspace' })
      assert.equal(t.cwd(), '/')
      check(t, 'ls /', 'workspace\n')
      check(t, 'cat /workspace/README.md /workspace/src/a.js', 'readme\nalpha\n')
      check(t, 'echo $HOME ~', '/ /\n')
      const missing = t.run('cat /README.md')
      assert.equal(missing.stdout, '')
      assert.notEqual(missing.exitCode, 0)
      assert.match(missing.stderr, /no such file or directory/u)
      assert.deepEqual(missing.unsupported, [])
    })
  }

  for (const [mount, expected] of [
    ['/workspace', '/workspace'],
    ['workspace', '/workspace'],
    ['/a//b/../workspace/./', '/a/workspace'],
    ['../workspace', '/workspace'],
    ['', '/'],
    ['/', '/'],
  ]) {
    it(`normalizes mount ${JSON.stringify(mount)}`, () => {
      const t = createTerminal({ f: 'content' }, { mount })
      const file = expected === '/' ? '/f' : expected + '/f'
      check(t, `cat ${file}`, 'content')
      assert.equal(t.cwd(), '/')
    })
  }

  it('normalizes source paths within the mount before prefixing', () => {
    const t = createTerminal(new Map([
      ['/absolute.txt', 'absolute\n'],
      ['../outside.txt', 'outside\n'],
      ['a/../../deep.txt', 'deep\n'],
      ['./x/../inside.txt', 'inside\n'],
      ['../../../../same.txt', 'old\n'],
      ['/same.txt', 'new\n'],
    ]), { mount: '/workspace' })
    check(t, 'find /workspace -type f', '/workspace/absolute.txt\n/workspace/deep.txt\n/workspace/inside.txt\n/workspace/outside.txt\n/workspace/same.txt\n')
    check(t, 'cat /workspace/absolute.txt /workspace/deep.txt /workspace/inside.txt /workspace/outside.txt /workspace/same.txt', 'absolute\ndeep\ninside\noutside\nnew\n')
    check(t, 'ls /', 'workspace\n')
  })

  for (const [name, sources] of [['empty object', {}], ['empty Map', new Map()], ['ignored values', { ignored: null }]]) {
    it(`creates the mount and ancestors for ${name}`, () => {
      const t = createTerminal(sources, { mount: '/one/two/three', cwd: '/one/two/three' })
      assert.equal(t.cwd(), '/one/two/three')
      check(t, 'ls /; ls /one; ls /one/two; ls .', 'one\ntwo\nthree\n')
      check(t, 'find / -type d', '/\n/one\n/one/two\n/one/two/three\n')
    })
  }

  it('leaves cwd independent of mount and home defaults', () => {
    const t = terminal({ cwd: '/workspace/src' })
    check(t, 'pwd; echo $HOME; cat a.js', '/workspace/src\n/workspace/home\nalpha\n')
    check(t, 'cd ..; pwd; cat README.md', '/workspace\nreadme\n', '/workspace')
    assert.equal(t.cwd(), '/workspace')
    assert.throws(() => createTerminal(SOURCES, { mount: '/workspace', cwd: '/src' }), /cwd.*not a directory/u)
  })

  it('retains existing root file and directory collision behavior at the mount', () => {
    const t = createTerminal({ '/': 'mounted root', child: 'child' }, { mount: '/workspace' })
    assert.deepEqual(t.run('cat /workspace /workspace/child'), {
      stdout: 'child', stderr: 'cat: /workspace: is a directory\n', exitCode: 1, cwd: '/', unsupported: [],
    })
    check(t, 'cd /workspace; pwd', '/workspace\n', '/workspace')
  })

  it('keeps the default filesystem layout unchanged', () => {
    const plain = createTerminal(SOURCES)
    const explicit = createTerminal(SOURCES, { mount: '/', home: '/' })
    for (const command of ['pwd', 'echo ~ $HOME', 'cat README.md', 'find src -type f', 'ls home']) {
      assert.deepEqual(explicit.run(command), plain.run(command), command)
    }
  })
})

describe('mounted paths participate in shell and custom command I/O', () => {
  it('preserves spaces and glob characters in a configured mount and home', () => {
    const t = createTerminal({ 'note.txt': 'literal path\n' }, { mount: '/work [x]', home: '/work [x]' })
    check(t, 'printf "[%s]\\n" ~; cat ~/note.txt; cat \'/work [x]/note.txt\'', '[/work [x]]\nliteral path\nliteral path\n')
    assert.deepEqual(t.complete('cat ~/no'), ['cat ~/note.txt'])
    check(t, 'cd; pwd', '/work [x]\n', '/work [x]')
  })

  for (const [command, stdout] of [
    ['cat src/a.js ../workspace/README.md', 'alpha\nreadme\n'],
    [String.raw`printf '%s\n' src/*.js`, 'src/a.js\nsrc/b.js\n'],
    [String.raw`printf '%s\n' /workspace/src/*.js`, '/workspace/src/a.js\n/workspace/src/b.js\n'],
    ["find . -type f -name '*.js'", './src/a.js\n./src/b.js\n'],
    ["find /workspace -type f -name '*.js'", '/workspace/src/a.js\n/workspace/src/b.js\n'],
    ['cat <README.md; cat </workspace/src/b.js', 'readme\nbeta\n'],
    ['cat README.md | grep readme', 'readme\n'],
    ['(cd src; cat a.js); pwd', 'alpha\n/workspace\n'],
    ["find src -name a.js -exec cat {} ';'", 'alpha\n'],
    ["echo src/a.js | xargs cat", 'alpha\n'],
    ['echo ~/note.txt; cat ~/note.txt', '/workspace/home/note.txt\nhome note\n'],
    ['cat <~/note.txt', 'home note\n'],
  ]) {
    it(command, () => check(terminal(), command, stdout))
  }

  it('exposes mounted absolute paths and cwd-relative operations to custom handlers', () => {
    const t = terminal({
      cwd: '/workspace/src',
      commands: {
        inspect: ({ cwd, fs }) => JSON.stringify({
          cwd, relative: fs.resolve('../README.md'), absolute: fs.resolve('/README.md'),
          file: fs.readFile('../README.md'), mounted: fs.isFile('/workspace/README.md'), unmounted: fs.isFile('/README.md'),
          directory: fs.isDir('/workspace'), files: fs.walkFiles('.'), listing: fs.listDir('.'),
        }),
        read: ({ args, readInputs }) => {
          const result = readInputs(args)
          return { stdout: result.inputs.map((input) => input.content).join(''), stderr: result.stderr, exitCode: result.failed ? 1 : 0 }
        },
      },
    })
    check(t, 'inspect', JSON.stringify({
      cwd: '/workspace/src', relative: '/workspace/README.md', absolute: '/README.md',
      file: 'readme\n', mounted: true, unmounted: false, directory: true,
      files: ['/workspace/src/a.js', '/workspace/src/b.js'], listing: { dirs: [], files: ['a.js', 'b.js'] },
    }))
    check(t, 'read a.js /workspace/README.md', 'alpha\nreadme\n')
  })
})

describe('configured home controls tilde, HOME and argumentless cd', () => {
  for (const [home, expected] of [
    ['/workspace/home', '/workspace/home'],
    ['workspace/home', '/workspace/home'],
    ['/workspace//src/../home/', '/workspace/home'],
    ['../workspace/home', '/workspace/home'],
    ['', '/'],
    ['/', '/'],
  ]) {
    it(`normalizes home ${JSON.stringify(home)}`, () => {
      const t = terminal({ home })
      check(t, 'printf "%s\\n" ~ "$HOME"', expected + '\n' + expected + '\n')
      check(t, 'cd; pwd', expected + '\n', expected)
    })
  }

  it('allows home to be set independently of the source mount', () => {
    const t = createTerminal(SOURCES, { home: '/home' })
    check(t, 'echo ~ $HOME; cat ~/note.txt', '/home /home\nhome note\n')
    check(t, 'cd; pwd', '/home\n', '/home')
  })

  it('respects tilde quoting and escaping', () => {
    check(terminal(), String.raw`printf '[%s]\n' '~' "~" \~ ~`, '[~]\n[~]\n[~]\n[/workspace/home]\n')
  })

  it('does not expand glob characters supplied by the configured home', () => {
    const t = createTerminal({
      'home [x]/note.txt': 'literal home\n',
      'home x/note.txt': 'wrong glob match\n',
      'home x/not-this.txt': 'wrong completion\n',
    }, { home: '/home [x]' })
    check(t, 'cat ~/note.txt', 'literal home\n')
    assert.deepEqual(t.complete('cat ~/no'), ['cat ~/note.txt'])
  })

  it('expands configured home in assignments and colon-separated assignment words', () => {
    check(terminal(), 'p=~/note.txt; q=~:~/projects; printf "%s\\n" "$p" "$q"', '/workspace/home/note.txt\n/workspace/home:/workspace/home/projects\n')
  })

  it('uses a persistent runtime HOME override', () => {
    const t = terminal()
    check(t, 'HOME=/workspace/other; echo ~ $HOME; cat ~/note.txt', '/workspace/other /workspace/other\nother note\n')
    check(t, 'cd; pwd', '/workspace/other\n', '/workspace/other')
    check(t, 'echo ~ $HOME', '/workspace/other /workspace/other\n')
  })

  it('restores configured home after a temporary HOME assignment', () => {
    const t = terminal()
    check(t, 'HOME=/workspace/other cd; pwd; echo ~ $HOME', '/workspace/other\n/workspace/home /workspace/home\n', '/workspace/other')
  })

  it('retains the configured tilde fallback after HOME is unset', () => {
    const t = terminal()
    check(t, 'unset HOME; printf "[%s]\\n" ~ "$HOME"', '[/workspace/home]\n[]\n')
    const result = t.run('cd')
    assert.equal(result.stdout, '')
    assert.notEqual(result.exitCode, 0)
    assert.match(result.stderr, /HOME not set/u)
    assert.deepEqual(result.unsupported, [])
  })

  it('does not create a nonexistent home directory', () => {
    const t = terminal({ home: '/missing/home' })
    check(t, 'echo ~ $HOME', '/missing/home /missing/home\n')
    const result = t.run('cd')
    assert.notEqual(result.exitCode, 0)
    assert.match(result.stderr, /no such file or directory/iu)
    assert.deepEqual(result.unsupported, [])
    assert.equal(t.cwd(), '/workspace')
    assert.deepEqual(t.complete('cat ~/'), [])
  })

  it('does not turn an existing home file into a directory', () => {
    const t = terminal({ home: '/workspace/README.md' })
    check(t, 'cat ~', 'readme\n')
    const result = t.run('cd')
    assert.notEqual(result.exitCode, 0)
    assert.match(result.stderr, /not a directory/iu)
    assert.deepEqual(result.unsupported, [])
  })
})

describe('completion resolves mounted paths and configured home', () => {
  it('completes source paths at the mount and relative to cwd', () => {
    const t = terminal()
    assert.deepEqual(t.complete('cat /work'), ['cat /workspace/'])
    assert.deepEqual(t.complete('cat src/a'), ['cat src/a.js'])
    assert.deepEqual(t.complete('cat /workspace/src/b'), ['cat /workspace/src/b.js'])
    assert.deepEqual(t.complete('cat /src/'), [])
  })

  it('preserves the typed tilde prefix', () => {
    const t = terminal()
    assert.deepEqual(t.complete('cat ~'), ['cat ~/'])
    assert.deepEqual(t.complete('cat ~/n'), ['cat ~/note.txt'])
    assert.deepEqual(t.complete('cat ~/projects/d'), ['cat ~/projects/demo.txt'])
    assert.deepEqual(t.complete('cd ~/p'), ['cd ~/projects/'])
    assert.deepEqual(t.complete('cd ~/n'), [])
    assert.deepEqual(t.complete('cat ~/.'), ['cat ~/.hidden'])
  })

  it('follows runtime HOME overrides and the unset fallback', () => {
    const t = terminal()
    check(t, 'HOME=/workspace/other', '')
    assert.deepEqual(t.complete('cat ~/n'), ['cat ~/note.txt'])
    assert.deepEqual(t.complete('cat ~/p'), [])
    check(t, 'unset HOME', '')
    assert.deepEqual(t.complete('cat ~/p'), ['cat ~/projects/'])
  })

  it('completes a directory created by an empty mount', () => {
    const t = createTerminal({}, { mount: '/a/b/c' })
    assert.deepEqual(t.complete('cd /a/b/'), ['cd /a/b/c/'])
  })
})

describe('mount and home option validation', () => {
  for (const option of ['mount', 'home']) {
    for (const value of [null, 0, false, {}, []]) {
      it(`rejects non-string ${option}: ${JSON.stringify(value)}`, () => {
        assert.throws(() => createTerminal(SOURCES, { [option]: value }), (error) => {
          assert.match(error.message, new RegExp(option, 'u'))
          assert.match(error.message, /string/u)
          return true
        })
      })
    }

    it(`rejects NUL in ${option}`, () => {
      assert.throws(() => createTerminal(SOURCES, { [option]: '/bad\0path' }), (error) => {
        assert.match(error.message, new RegExp(option, 'u'))
        assert.match(error.message, /NUL/u)
        return true
      })
    })
  }

  it('undefined options keep their defaults', () => {
    const t = createTerminal(SOURCES, { mount: undefined, home: undefined })
    check(t, 'pwd; echo ~ $HOME; cat README.md', '/\n/ /\nreadme\n')
  })
})
