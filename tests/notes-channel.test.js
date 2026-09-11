import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const HIDDEN = { '.hidden': 'hidden\n', visible: 'visible\n' }
const ONE_NOTE = 'ls: omitted 1 hidden entry: "/.hidden". Hidden entries are included with -a.'
const expected = (stdout = '', notes = [], extra = {}) => ({ stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [], notes, ...extra })

function noteFor(paths) {
  const count = paths.length
  return `ls: omitted ${count} hidden ${count === 1 ? 'entry' : 'entries'}: ${paths.map((path) => JSON.stringify(path)).join(', ')}. Hidden entries are included with -a.`
}

describe('RunResult notes describe actual ls omissions', () => {
  it('adds a note without changing ordinary ls output, stderr or status', () => {
    assert.deepEqual(createTerminal(HIDDEN).run('ls'), expected('visible\n', [ONE_NOTE]))
  })

  for (const [sources, command, stdout] of [
    [{ visible: '' }, 'ls', 'visible\n'],
    [{}, 'ls', ''],
    [HIDDEN, 'ls -a', '.\n..\n.hidden\nvisible\n'],
    [HIDDEN, 'ls -A', '.hidden\nvisible\n'],
    [HIDDEN, 'ls -d /', '/\n'],
    [HIDDEN, 'ls /.hidden', '/.hidden\n'],
    [HIDDEN, 'ls .*', '.hidden\n'],
    [HIDDEN, 'true || ls', ''],
    [HIDDEN, 'false && ls; true', ''],
  ]) {
    it('has no omissions for ' + command + ' over ' + JSON.stringify(sources), () => {
      assert.deepEqual(createTerminal(sources).run(command), expected(stdout))
    })
  }

  it('counts hidden files and directories without descending into excluded directories', () => {
    const sources = { '.env': '', '.git/config': '', '.git/.nested': '', visible: '' }
    assert.deepEqual(createTerminal(sources).run('ls'), expected('visible\n', [noteFor(['/.env', '/.git'])]))
  })

  it('counts hidden children of an explicitly listed hidden directory', () => {
    const sources = { '.git/.secret': '', '.git/config': '' }
    assert.deepEqual(createTerminal(sources).run('ls /.git'), expected('config\n', [noteFor(['/.git/.secret'])]))
    assert.deepEqual(createTerminal(sources).run('ls -d /.git'), expected('/.git\n'))
  })

  it('deduplicates omitted paths across repeated operands and recursive traversals', () => {
    const sources = { '.root': '', 'dir/.local': '', 'dir/.secret/deep': '', 'dir/visible': '' }
    const result = createTerminal(sources).run('ls -R . ./dir ./dir')
    assert.deepEqual(result.notes, [noteFor(['/.root', '/dir/.local', '/dir/.secret'])])
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.unsupported, [])
    assert.ok(result.stdout.includes('visible\n'))
    assert.ok(!result.stdout.includes('.local'))
    assert.ok(!result.notes[0].includes('deep'))
  })

  it('does not emit omission notes for recursive -a or -A listings', () => {
    const sources = { '.root': '', 'dir/.local': '' }
    for (const flag of ['-aR', '-AR']) {
      const result = createTerminal(sources).run('ls ' + flag)
      assert.deepEqual(result.notes, [])
      assert.ok(result.stdout.includes('.root'))
      assert.ok(result.stdout.includes('.local'))
    }
  })

  for (const count of [9, 10]) {
    it('formats the ' + count + '-entry boundary', () => {
      const paths = Array.from({ length: count }, (_, index) => '/.hidden' + index)
      const sources = Object.fromEntries(paths.map((path) => [path, '']))
      const message = count === 9 ? noteFor(paths) : 'ls: omitted 10 hidden entries. Hidden entries are included with -a.'
      assert.deepEqual(createTerminal(sources).run('ls'), expected('', [message]))
    })
  }

  it('quotes unusual paths and sorts by Unicode code point rather than UTF-16', () => {
    const names = ['.😀', '.\uE000', '.line\nbreak', '.quote"', '.slash\\']
    const sources = Object.fromEntries(names.map((name) => [name, '']))
    const paths = ['/.line\nbreak', '/.quote"', '/.slash\\', '/.\uE000', '/.😀']
    assert.deepEqual(createTerminal(sources).run('ls -r'), expected('', [noteFor(paths)]))
  })

  it('keeps the normal mixed-success ls error and exit status', () => {
    const result = createTerminal(HIDDEN).run('ls / /missing')
    assert.deepEqual(result, expected('/:\nvisible\n', [ONE_NOTE], {
      stderr: 'ls: /missing: no such file or directory\n', exitCode: 2,
    }))
  })
})

describe('notes survive nested shell execution and output routing', () => {
  for (const [command, stdout, extraNotes = []] of [
    ['ls | wc -l', '1\n'],
    ['ls >/dev/null', ''],
    ['ls 2>/dev/null | cat', 'visible\n'],
    ['(ls)', 'visible\n'],
    ['{ ls; } >/dev/null', ''],
    ['value=$(ls); printf "%s" "$value"', 'visible'],
    ['find . -maxdepth 0 -exec ls {} \\;', 'visible\n', ['find: depth limit omitted contents of 1 directory: "/".']],
    ["printf '%s\\n' / | xargs ls", 'visible\n'],
    ['for dir in / /; do ls "$dir"; done', 'visible\nvisible\n'],
    ['ls; ls', 'visible\nvisible\n'],
  ]) {
    it(command, () => assert.deepEqual(createTerminal(HIDDEN).run(command), expected(stdout, [ONE_NOTE, ...extraNotes])))
  }

  it('retains notes from earlier input units after a later parse error', () => {
    const result = createTerminal(HIDDEN).run('ls\necho $(if true)')
    assert.equal(result.stdout, 'visible\n')
    assert.equal(result.exitCode, 2)
    assert.notEqual(result.stderr, '')
    assert.deepEqual(result.unsupported, [])
    assert.deepEqual(result.notes, [ONE_NOTE])
  })

  it('does not emit notes for commands prevented by a same-unit parse error', () => {
    const result = createTerminal(HIDDEN).run('ls; echo $(if true)')
    assert.equal(result.stdout, '')
    assert.equal(result.exitCode, 2)
    assert.deepEqual(result.notes, [])
  })

  it('keeps notes separate from unsupported diagnostics and stderr', () => {
    const result = createTerminal(HIDDEN).run('ls; grep --unsupported x visible 2>/dev/null | true')
    assert.equal(result.stdout, 'visible\n')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.notes, [ONE_NOTE])
    assert.ok(result.unsupported.some(({ command, detail }) => command === 'grep' && detail === '--unsupported'))
  })

  it('does not invent an omission note when ls fails before enumerating', () => {
    const result = createTerminal(HIDDEN).run('ls -l')
    assert.equal(result.stdout, '')
    assert.notEqual(result.exitCode, 0)
    assert.ok(result.unsupported.length > 0)
    assert.deepEqual(result.notes, [])
  })

  it('retains encounter order while deduplicating identical invocation messages', () => {
    const sources = { 'a/.hidden': '', 'b/.hidden': '' }
    const result = createTerminal(sources).run('ls b; ls a; ls b')
    assert.deepEqual(result.notes, [noteFor(['/b/.hidden']), noteFor(['/a/.hidden'])])
  })
})

describe('notes use absolute filesystem paths and isolated run storage', () => {
  it('resolves mounted paths relative to a non-root cwd', () => {
    const terminal = createTerminal({ 'dir/.hidden': '', 'dir/visible': '' }, { mount: '/workspace [x]', cwd: '/workspace [x]/dir' })
    assert.deepEqual(terminal.run('ls .'), expected('visible\n', [noteFor(['/workspace [x]/dir/.hidden'])], { cwd: '/workspace [x]/dir' }))
  })

  it('includes hidden files from the writable overlay', () => {
    const terminal = createTerminal({}, { mount: '/repo', writable: '/tmp/' })
    const result = terminal.run('printf hidden >/tmp/.hidden; printf visible >/tmp/visible; ls /tmp')
    assert.deepEqual(result, expected('visible\n', [noteFor(['/tmp/.hidden'])], { cwd: '/repo' }))
  })

  it('freezes note arrays and resets them for each run and terminal', () => {
    const terminal = createTerminal(HIDDEN)
    const first = terminal.run('ls')
    assert.ok(Object.isFrozen(first.notes))
    assert.ok(first.notes.every((note) => typeof note === 'string'))
    assert.throws(() => first.notes.push('changed'), TypeError)
    assert.throws(() => { first.notes[0] = 'changed' }, TypeError)
    const next = terminal.run('echo next')
    assert.deepEqual(next, expected('next\n'))
    assert.ok(Object.isFrozen(next.notes))
    assert.notEqual(next.notes, first.notes)
    assert.deepEqual(first.notes, [ONE_NOTE])
    assert.deepEqual(createTerminal({ visible: '' }).run('ls').notes, [])
  })

  it('isolates reentrant runs and restores the enclosing note collection', () => {
    let inner
    const terminal = createTerminal({ 'outer/.hidden': '', 'inner/.hidden': '' }, {
      commands: { reenter: () => { inner = terminal.run('ls inner'); return '' } },
    })
    const result = terminal.run('ls outer; reenter; ls outer')
    assert.deepEqual(result.notes, [noteFor(['/outer/.hidden'])])
    assert.deepEqual(inner.notes, [noteFor(['/inner/.hidden'])])
    assert.notEqual(result.notes, inner.notes)
    assert.ok(Object.isFrozen(result.notes))
    assert.ok(Object.isFrozen(inner.notes))
    assert.deepEqual(terminal.run('true').notes, [])
  })
})
