import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const INPUT = 'x\nx\ny\n'
const options = { mount: '/repo', writable: '/tmp/' }
function terminal() {
  const t = createTerminal({ input: INPUT, bad: '\uD800', replacement: '\uFFFD' }, options)
  assert.equal(t.run('cat /repo/input >/tmp/file').exitCode, 0)
  return t
}
const expected = (stdout = '', exitCode = 0) => ({ stdout, stderr: '', exitCode, cwd: '/', unsupported: [] })

function gap(t, command, detail) {
  const r = t.run(command)
  assert.equal(r.stdout, '', command)
  assert.ok(r.unsupported.some((entry) => entry.detail === detail), JSON.stringify(r))
  return r
}

describe('self-output across command and descriptor families is never a silent snapshot', () => {
  for (const command of [
    'cut -c1 /tmp/file', 'nl /tmp/file', 'uniq /tmp/file',
    'tail -n+1 /tmp/file', 'tail -c+1 /tmp/file',
    'hexdump /tmp/file', 'xxd /tmp/file', 'od /tmp/file',
    'tr x y </tmp/file', "awk '{print}' </tmp/file", 'base64 </tmp/file',
    'cut -c1 </tmp/file', 'nl </tmp/file', 'uniq </tmp/file',
    'wc -c /tmp/file /tmp/file', 'tac /tmp/file /tmp/file',
    'wc -c /repo/input /tmp/file', 'tac /repo/input /tmp/file',
    'wc -c /repo/input - </tmp/file', 'tac /repo/input - </tmp/file',
  ]) {
    it(command, () => {
      const t = terminal()
      gap(t, command + ' 2>/dev/null >>/tmp/file | cat', 'streaming self-output')
      assert.deepEqual(t.run('cat /tmp/file'), expected(INPUT))
    })
  }

  for (const [command, content] of [
    ['wc -c /tmp/file', INPUT + '6 /tmp/file\n'],
    ['wc -c </tmp/file', INPUT + '6\n'],
    ['tac /tmp/file', INPUT + 'y\nx\nx\n'],
    ['sort /tmp/file', INPUT + 'x\nx\ny\n'],
    ['sort /tmp/file /tmp/file', INPUT + 'x\nx\nx\nx\ny\ny\n'],
  ]) {
    it(`fully consumed input remains safe: ${command}`, () => {
      const t = terminal()
      assert.deepEqual(t.run(command + ' >>/tmp/file'), expected())
      assert.deepEqual(t.run('cat /tmp/file'), expected(content))
    })
  }

  it('observes reads even when an inherited file starts empty', () => {
    const t = terminal()
    assert.deepEqual(t.run('>/tmp/file'), expected())
    gap(t, 'wc -c - - </tmp/file 2>/dev/null >>/tmp/file | cat', 'streaming self-output')
    assert.deepEqual(t.run('cat /tmp/file'), expected())
  })
})

describe('diagnostics cannot modify a later input behind a command snapshot', () => {
  for (const command of [
    'grep missing missing /tmp/file', 'grep -q missing missing /tmp/file',
    'egrep missing missing /tmp/file', 'fgrep missing missing /tmp/file',
    'head -n1 -q missing /tmp/file', 'tail -n1 -q missing /tmp/file',
    'cut -c1 missing /tmp/file', 'nl missing /tmp/file',
    'wc -c missing /tmp/file', 'tac missing /tmp/file',
    'grep missing missing - </tmp/file', 'wc -c missing - </tmp/file',
  ]) {
    it(command, () => {
      const t = terminal()
      const r = gap(t, command + ' 2>>/tmp/file | cat', 'input modified by diagnostics')
      assert.equal(r.stderr, '')
      assert.equal(r.exitCode, 0)
      assert.ok(t.run('cat /tmp/file').stdout.startsWith(INPUT))
    })
  }

  it('suppressed grep errors do not modify the input', () => {
    const t = terminal()
    assert.deepEqual(t.run('grep -s missing missing /tmp/file 2>>/tmp/file'), expected('', 2))
    assert.deepEqual(t.run('cat /tmp/file'), expected(INPUT))
  })

  it('an unrelated diagnostic file does not block normal results', () => {
    const t = terminal()
    assert.deepEqual(t.run('grep x missing /tmp/file 2>/tmp/errors'), expected('/tmp/file:x\n/tmp/file:x\n', 2))
    assert.deepEqual(t.run('cat /tmp/file'), expected(INPUT))
    assert.match(t.run('cat /tmp/errors').stdout, /missing/u)
  })
})

describe('byte-backed writes reject unrepresentable text and preserve surrounding execution', () => {
  for (const redirect of ['>/tmp/file', '>>/tmp/file']) {
    it(redirect, () => {
      const t = terminal()
      const result = t.run(`echo before; cat /repo/bad 2>/dev/null ${redirect}; echo after`)
      assert.equal(result.stdout, 'before\nafter\n')
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
      assert.deepEqual(result.unsupported.map((entry) => entry.detail), ['unpaired surrogate'])
      assert.deepEqual(t.run('cat /tmp/file'), expected(redirect.startsWith('>>') ? INPUT : ''))
    })
  }

  it('the actual Unicode replacement character remains valid file content', () => {
    const t = terminal()
    assert.deepEqual(t.run('cat /repo/replacement >/tmp/file; cat /tmp/file'), expected('\uFFFD'))
  })

  it('an in-place malformed replacement preserves the input and its backup name', () => {
    const t = terminal()
    const r = t.run(`sed -i.bak 's/x/\uD800/' /tmp/file 2>/dev/null | cat`)
    assert.equal(r.exitCode, 0)
    assert.equal(r.stderr, '')
    assert.deepEqual(r.unsupported.map((entry) => entry.detail), ['unpaired surrogate'])
    assert.deepEqual(t.run('cat /tmp/file'), expected(INPUT))
    assert.deepEqual(t.run('test -f /tmp/file.bak'), expected('', 1))
  })
})

describe('closed stdout errors retain their ordered diagnostic events', () => {
  it('rm reports its failed verbose output after removing the file', () => {
    const t = terminal()
    assert.deepEqual(t.run('rm -v /tmp/file 1>&-'), {
      ...expected('', 1), stderr: 'rm: write error: Bad file descriptor\n',
    })
    assert.deepEqual(t.run('test -f /tmp/file'), expected('', 1))
  })

  it('a prior operand error survives alongside the write error', () => {
    const t = terminal()
    assert.deepEqual(t.run('rm -v /tmp/missing /tmp/file 1>&-'), {
      ...expected('', 1), stderr: "rm: cannot remove '/tmp/missing': No such file or directory\nrm: write error: Bad file descriptor\n",
    })
  })

  it('redirects the write error through the active stderr descriptor', () => {
    const t = terminal()
    assert.deepEqual(t.run('rm -v /tmp/file 1>&- 2>/tmp/errors'), expected('', 1))
    assert.deepEqual(t.run('cat /tmp/errors'), expected('rm: write error: Bad file descriptor\n'))
  })
})

describe('external child commands report their own closed-output failure', () => {
  for (const [command, status] of [
    ["find /repo/input -exec echo {} \\; 1>&-", 0],
    ['find /repo/input -exec echo {} + 1>&-', 1],
    ["printf argument | xargs echo 1>&-", 123],
    ["printf argument | xargs xargs echo 1>&-", 123],
  ]) {
    it(command, () => {
      const t = terminal()
      assert.deepEqual(t.run(command), { ...expected('', status), stderr: 'echo: write error: Bad file descriptor\n' })
    })
  }

  it('a failed -exec predicate still permits an OR fallback without failing find', () => {
    const t = terminal()
    assert.deepEqual(t.run('find /repo/input -exec echo {} \\; -o -exec true \\; 1>&-'), {
      ...expected(), stderr: 'echo: write error: Bad file descriptor\n',
    })
  })
})
