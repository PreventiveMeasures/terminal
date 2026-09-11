import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = { 'a.txt': 'alpha\nbeta\nalpha\n', 'b.txt': 'gamma\n' }
const expected = (stdout = '', exitCode = 0, stderr = '', unsupported = [], cwd = '/src') => ({ stdout, stderr, exitCode, cwd, notes: [], unsupported })
const terminal = () => createTerminal(FILES, { mount: '/src/', writable: '/tmp/' })

describe('writable tmp output redirection', () => {
  const cases = [
    ['echo data >/tmp/out; cat /tmp/out', 'data\n'],
    ['printf first >/tmp/out; printf second >>/tmp/out; cat /tmp/out', 'firstsecond'],
    ['printf first >/tmp/out; printf second >/tmp/out; cat /tmp/out', 'second'],
    ['printf first >/tmp/out; printf second >|/tmp/out; cat /tmp/out', 'second'],
    ['>/tmp/out; test -f /tmp/out; cat /tmp/out', ''],
    ['>>/tmp/out; test -f /tmp/out; cat /tmp/out', ''],
    ['echo data >/tmp/out; >/tmp/out; cat /tmp/out', ''],
    ['echo data >/tmp/out; >>/tmp/out; cat /tmp/out', 'data\n'],
    ['false >/tmp/out; echo $?; cat /tmp/out', '1\n'],
    ['false && echo skipped >/tmp/out; test -f /tmp/out; echo $?', '1\n'],
    ['true || echo skipped >/tmp/out; test -f /tmp/out; echo $?', '1\n'],
    ['grep alpha /src/a.txt >/tmp/out; cat /tmp/out', 'alpha\nalpha\n'],
    ['grep alpha /src/a.txt | sort | uniq >/tmp/out; cat /tmp/out', 'alpha\n'],
    ['printf data | cat >/tmp/out; cat /tmp/out', 'data'],
    ['printf data >/tmp/out | cat; cat /tmp/out', 'data'],
    ['echo data >/tmp/out; cat </tmp/out | sed s/data/read/', 'read\n'],
    ['echo data >/tmp/out; cat </tmp/out; cat </tmp/out', 'data\ndata\n'],
    ['echo "$(printf data >/tmp/out)"; cat /tmp/out', '\ndata'],
    ['name=/tmp/out; echo data >"$name"; cat "$name"', 'data\n'],
    ['echo data >"/tmp/$(printf out)"; cat /tmp/out', 'data\n'],
    ["echo data >'/tmp/two words'; cat '/tmp/two words'", 'data\n'],
    [String.raw`echo data >/tmp/\[x\]; cat /tmp/\[x\]`, 'data\n'],
    ['echo data >/tmp/../tmp/out; cat /tmp/out', 'data\n'],
    ['{ echo first; echo second; } >/tmp/out; cat /tmp/out', 'first\nsecond\n'],
    ['for word in first second; do echo "$word"; done >/tmp/out; cat /tmp/out', 'first\nsecond\n'],
    ['if true; then echo chosen; else echo skipped; fi >/tmp/out; cat /tmp/out', 'chosen\n'],
    ['(echo data >/tmp/out); cat /tmp/out', 'data\n'],
  ]
  for (const [command, stdout] of cases) {
    it(command, () => assert.deepEqual(terminal().run(command), expected(stdout)))
  }
  it('relative targets use the current directory', () => {
    assert.deepEqual(terminal().run('cd /tmp; echo data >out; cat out'), expected('data\n', 0, '', [], '/tmp'))
  })
  it('output survives across run calls and stays separate from source files', () => {
    const t = terminal()
    assert.deepEqual(t.run('cat /src/a.txt >/tmp/out'), expected())
    assert.deepEqual(t.run('echo tail >>/tmp/out'), expected())
    assert.deepEqual(t.run('cat /tmp/out'), expected(FILES['a.txt'] + 'tail\n'))
    assert.deepEqual(t.run('cat /src/a.txt'), expected(FILES['a.txt']))
    assert.deepEqual(FILES, { 'a.txt': 'alpha\nbeta\nalpha\n', 'b.txt': 'gamma\n' })
  })
})

describe('writable stderr and combined redirects', () => {
  const message = 'cat: missing: no such file or directory\n'
  for (const redirect of ['2>', '&>', '2>>', '&>>']) {
    it(redirect, () => {
      const t = terminal()
      const append = redirect.endsWith('>>')
      assert.deepEqual(t.run('echo prefix >/tmp/errors'), expected())
      assert.deepEqual(t.run(`cat missing ${redirect}/tmp/errors`), expected('', 1))
      assert.deepEqual(t.run('cat /tmp/errors'), expected((append ? 'prefix\n' : '') + message))
    })
  }
  it('combined redirects preserve explicit command ordering', () => {
    assert.deepEqual(terminal().run('{ echo first; cat missing; echo last; } &>/tmp/out; cat /tmp/out'), expected('first\n' + message + 'last\n'))
  })
  it('writing stdout does not suppress a separate stderr', () => {
    assert.deepEqual(terminal().run('cat missing >/tmp/out'), expected('', 1, message))
  })
  it('redirected command failures retain their exit status', () => {
    assert.deepEqual(terminal().run('cat missing 2>/tmp/errors; echo $?'), expected('1\n'))
  })
})

describe('writable redirect failures remain ordinary or unsupported as appropriate', () => {
  for (const path of ['/tmp', '/tmp/', '/tmp/missing/out', '/tmp/out/']) {
    it(`ordinary open failure: ${path}`, () => {
      const result = terminal().run(`echo data >${path}`)
      assert.equal(result.stdout, '')
      assert.equal(result.exitCode, 1)
      assert.notEqual(result.stderr, '')
      assert.deepEqual(result.unsupported, [])
    })
  }
  it('redirect glob ambiguity does not overwrite either match', () => {
    const t = terminal()
    t.run('echo first >/tmp/a; echo second >/tmp/b')
    const result = t.run('echo bad >/tmp/*')
    assert.equal(result.exitCode, 1)
    assert.match(result.stderr, /ambiguous redirect/u)
    assert.deepEqual(result.unsupported, [])
    assert.deepEqual(t.run('cat /tmp/a /tmp/b'), expected('first\nsecond\n'))
  })
  it('read-only source files still refuse writes with diagnostics', () => {
    const t = terminal()
    const result = t.run('echo before; echo bad >/src/a.txt')
    assert.equal(result.stdout, 'before\n')
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.unsupported.map(({ detail }) => detail), ['>'])
    assert.deepEqual(t.run('cat /src/a.txt'), expected(FILES['a.txt']))
  })
  it('unsupported command diagnostics survive writing stderr to a file', () => {
    const t = terminal()
    const message = 'wc: unknown option: --bogus'
    const unsupported = [{ kind: 'option', command: 'wc', detail: '--bogus', message }]
    assert.deepEqual(t.run('wc --bogus 2>/tmp/errors | cat'), expected('', 0, '', unsupported))
    assert.deepEqual(t.run('cat /tmp/errors'), expected(message + '\n'))
  })
  for (const options of [{}, { writable: false }, { writable: undefined }]) {
    it(`default read-only parsing remains unchanged: ${JSON.stringify(options)}`, () => {
      const result = createTerminal(FILES, options).run('echo before; echo data >/tmp/out')
      assert.equal(result.stdout, '')
      assert.equal(result.exitCode, 1)
      assert.deepEqual(result.unsupported.map(({ detail }) => detail), ['>'])
    })
  }
})

describe('streaming commands cannot silently consume their own new output', () => {
  for (const reader of ['head -n 10', 'grep alpha', 'egrep alpha', 'fgrep alpha', "sed -n p", "awk '{print}'"]) {
    it(reader, () => {
      const t = terminal()
      t.run('cat /src/a.txt >/tmp/out')
      const result = t.run(`${reader} /tmp/out >>/tmp/out`)
      assert.equal(result.stdout, '')
      assert.equal(result.exitCode, 1)
      assert.deepEqual(result.unsupported.map(({ detail }) => detail), ['streaming self-output'])
      assert.deepEqual(t.run('cat /tmp/out'), expected(FILES['a.txt']))
    })
  }
  it('a consumed redirected input receives the same explicit diagnostic', () => {
    const t = terminal()
    t.run('cat /src/a.txt >/tmp/out')
    const result = t.run('head </tmp/out >>/tmp/out')
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.unsupported.map(({ detail }) => detail), ['streaming self-output'])
  })
  it('no-output readers retain their normal status', () => {
    const t = terminal()
    t.run('cat /src/a.txt >/tmp/out')
    assert.deepEqual(t.run('grep -q alpha /tmp/out >>/tmp/out'), expected())
    assert.deepEqual(t.run('head -n 0 /tmp/out >>/tmp/out'), { ...expected(), notes: ['head: selected 0 of 3 lines from "/tmp/out".'] })
    assert.deepEqual(t.run('grep absent /tmp/out >>/tmp/out'), expected('', 1))
  })
  it('command substitution finishes reading before the outer append', () => {
    const t = terminal()
    t.run('echo alpha >/tmp/out')
    assert.deepEqual(t.run('echo "$(grep alpha /tmp/out)" >>/tmp/out; cat /tmp/out'), expected('alpha\nalpha\n'))
  })
  it('sort may buffer a file before appending its sorted copy', () => {
    const t = terminal()
    t.run("printf 'b\\na\\n' >/tmp/out")
    assert.deepEqual(t.run('sort /tmp/out >>/tmp/out; cat /tmp/out'), expected('b\na\na\nb\n'))
  })
})
