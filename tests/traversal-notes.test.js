import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { createFs } from '../src/fs.js'
import { find } from '../src/commands/find.js'
import { tree } from '../src/commands/tree.js'

const FILES = {
  '.hidden/inner/file': '',
  'a/one/file': '',
  'a/two': '',
  'b/.hidden': '',
  'c/plain': '',
  root: '',
}

function note(command, paths) {
  const suffix = paths.length < 10 ? ': ' + paths.map((path) => JSON.stringify(path)).join(', ') : ''
  return `${command}: depth limit omitted contents of ${paths.length} ${paths.length === 1 ? 'directory' : 'directories'}${suffix}.`
}

const hiddenNote = (paths) => `tree: omitted ${paths.length} hidden ${paths.length === 1 ? 'entry' : 'entries'}: ` +
  paths.map((path) => JSON.stringify(path)).join(', ') + '. Hidden entries are included with -a.'

// tree drops dot-prefixed names from the listing and from the totals under it,
// so a walked directory reports them; find shows them and never does.
function check(command, paths, files = FILES, hidden = []) {
  const result = createTerminal(files).run(command)
  const expected = paths.length ? [note(command.startsWith('tree') ? 'tree' : 'find', paths)] : []
  if (hidden.length) expected.push(hiddenNote(hidden))
  assert.deepEqual(result.notes, expected, command)
  assert.equal(result.stderr, '', command)
  assert.equal(result.exitCode, 0, command)
  assert.deepEqual(result.unsupported, [], command)
  return result
}

describe('tree depth omission notes', () => {
  for (const [command, paths, hidden = []] of [
    ['tree -L1', ['/a', '/c'], ['/.hidden']],
    ['tree -L2', ['/a/one'], ['/.hidden', '/b/.hidden']],
    ['tree -aL1', ['/.hidden', '/a', '/b', '/c']],
    ['tree -dL1', ['/a'], ['/.hidden']],
    ['tree -adL1', ['/.hidden', '/a']],
    ['tree -dL2', [], ['/.hidden']],
    ['tree -L99', [], ['/.hidden', '/b/.hidden']],
    ['tree', [], ['/.hidden', '/b/.hidden']],
    ['tree -a', []],
    ['tree -L1 a', ['/a/one']],
    ['tree -L1 .hidden', ['/.hidden/inner']],
    ['tree -FL1 --noreport', ['/a', '/c'], ['/.hidden']],
  ]) {
    it(command + ' reports only eligible omitted contents', () => check(command, paths, FILES, hidden))
  }

  it('does not claim a hidden entry the depth limit had already cut off', () => {
    // `/dir` stops at the frontier, so its `.child` was never a name this
    // listing passed over for being hidden — the depth note covers it whole.
    check('tree -L1', ['/dir'], { 'dir/.child': '', 'dir/shown': '' })
    check('tree -L2', [], { 'dir/.child': '', 'dir/shown': '' }, ['/dir/.child'])
  })

  it('leaves output and report totals unchanged', () => {
    const result = check('tree -L1', ['/a', '/c'], FILES, ['/.hidden'])
    assert.equal(result.stdout, '.\n├── a\n├── b\n├── c\n└── root\n\n4 directories, 1 file\n')
  })

  it('does not report a frontier containing only hidden entries without -a', () => {
    check('tree -L1', [], { 'dir/.child/file': '' })
    check('tree -aL1', ['/dir'], { 'dir/.child/file': '' })
  })

  it('does not attribute files filtered by -d to the depth limit', () => {
    check('tree -dL1', [], { 'dir/file': '' })
    check('tree -dL1', [], { 'dir/.child/file': '' })
    check('tree -adL1', ['/dir'], { 'dir/.child/file': '' })
  })

  it('does not report empty directories at the frontier', () => {
    assert.deepEqual(createTerminal({}, { mount: '/empty' }).run('tree -L1').notes, [])
    check('tree -L1', [], {})
  })

  it('preserves an earlier omission when a later displayed name is unsupported', () => {
    const result = createTerminal({ 'a/file': '', 'z\nname': '' }).run('tree -L1 2>/dev/null | true')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.notes, [note('tree', ['/a'])])
    assert.ok(result.unsupported.some(({ command, detail }) => command === 'tree' && detail === 'filename escaping'))
  })

  it('keeps the hidden note when a displayed name aborts the walk', () => {
    const result = createTerminal({ '.hidden': '', 'a/file': '', 'z\nname': '' }).run('tree 2>/dev/null | true')
    assert.equal(result.stderr, '')
    assert.deepEqual(result.notes, [hiddenNote(['/.hidden'])])
    assert.ok(result.unsupported.some(({ detail }) => detail === 'filename escaping'))
  })

  for (const command of ['tree >/dev/null', 'tree | wc -l', 'value=$(tree); true', '(tree)']) {
    it(command + ' retains the hidden note independently of output routing', () => {
      const result = createTerminal({ '.hidden': '', visible: '' }).run(command)
      assert.deepEqual(result.notes, [hiddenNote(['/.hidden'])])
      assert.equal(result.exitCode, 0)
    })
  }

  it('never inspects unsupported names below the displayed frontier', () => {
    check('tree -L1', ['/dir'], { 'dir/name\nwith\nnewlines': '' })
  })

  for (const command of ['tree -L0', 'tree -Lnope', 'tree -L1 --unknown', 'tree -L1 a c', 'tree -L1 missing']) {
    it(command + ' emits no note when listing never starts', () => {
      const result = createTerminal(FILES).run(command)
      assert.notEqual(result.exitCode, 0)
      assert.deepEqual(result.notes, [])
    })
  }
})

describe('find depth omission notes', () => {
  for (const [command, paths] of [
    ['find . -maxdepth 0', ['/']],
    ['find . -maxdepth 1', ['/.hidden', '/a', '/b', '/c']],
    ['find . -maxdepth 2', ['/.hidden/inner', '/a/one']],
    ['find . -maxdepth 99', []],
    ['find .', []],
    ['find root -maxdepth 0', []],
    ['find a -maxdepth 1', ['/a/one']],
    ['find a ./a /a/ -maxdepth 1', ['/a/one']],
    ['find . -maxdepth 1 -name absent', ['/.hidden', '/a', '/b', '/c']],
    ['find . -maxdepth 1 -type f', ['/.hidden', '/a', '/b', '/c']],
    ['find . -maxdepth 1 -mindepth 3', ['/.hidden', '/a', '/b', '/c']],
    ['find . -maxdepth 0 -mindepth 1 -prune', ['/']],
    ['find . -maxdepth 0 -prune', []],
    ['find . -maxdepth 1 -prune', []],
    ['find . -maxdepth 1 -name a -prune -o -print', ['/.hidden', '/b', '/c']],
    ['find . -maxdepth 2 -name a -prune -o -print', ['/.hidden/inner']],
    ['find . -maxdepth 1 ! -prune -o -print', []],
    ['find . -maxdepth 1 -name absent -prune -o -print', ['/.hidden', '/a', '/b', '/c']],
  ]) {
    it(command + ' reports only depth-pruned directories', () => check(command, paths))
  }

  it('preserves normal printed paths', () => {
    const result = check('find . -maxdepth 1', ['/.hidden', '/a', '/b', '/c'])
    assert.equal(result.stdout, '.\n./.hidden\n./a\n./b\n./c\n./root\n')
  })

  it('ignores empty frontier directories and an empty root', () => {
    assert.deepEqual(createTerminal({}, { mount: '/empty' }).run('find /empty -maxdepth 0').notes, [])
    check('find . -maxdepth 0', [], {})
  })

  it('retains omissions across later root errors and visits remaining roots', () => {
    const result = createTerminal(FILES).run('find a missing c -maxdepth 0')
    assert.equal(result.stdout, 'a\nc\n')
    assert.equal(result.stderr, 'find: missing: no such file or directory\n')
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.unsupported, [])
    assert.deepEqual(result.notes, [note('find', ['/a', '/c'])])
  })

  it('retains an omission when an executed command reports unsupported', () => {
    const result = createTerminal(FILES).run('find a -maxdepth 0 -exec unknown {} \\; 2>/dev/null | true')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.notes, [note('find', ['/a'])])
    assert.ok(result.unsupported.some(({ command }) => command === 'unknown'))
  })

  it('preserves depth notes and failed batched execution status', () => {
    const result = createTerminal(FILES).run('find a -maxdepth 0 -exec false {} +')
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.unsupported, [])
    assert.deepEqual(result.notes, [note('find', ['/a'])])
  })

  it('checks frontier contents after per-entry actions remove or create files', () => {
    const terminal = createTerminal({ file: 'text' }, { mount: '/repo', writable: '/tmp/' })
    const created = terminal.run('find /tmp -maxdepth 0 -exec cp /repo/file /tmp/file \\;')
    assert.equal(created.exitCode, 0)
    assert.deepEqual(created.notes, [note('find', ['/tmp'])])
    const removed = terminal.run('find /tmp -maxdepth 0 -exec rm /tmp/file \\;')
    assert.equal(removed.exitCode, 0)
    assert.deepEqual(removed.notes, [])
  })

  for (const command of ['find . -maxdepth -1', 'find . -maxdepth 1 -unknown', 'find . -maxdepth 1 -quit']) {
    it(command + ' produces no omission notes when the expression is rejected', () => {
      const result = createTerminal(FILES).run(command)
      assert.notEqual(result.exitCode, 0)
      assert.deepEqual(result.notes, [])
    })
  }
})

describe('depth notes retain full paths, bounded details, and shell channel semantics', () => {
  for (const command of ['tree -L1', 'find . -maxdepth 1']) {
    for (const count of [9, 10]) {
      it(command + ' lists full paths only for ' + count + ' < 10 directories', () => {
        const paths = Array.from({ length: count }, (_, i) => '/dir' + i)
        const files = Object.fromEntries(paths.map((path) => [path + '/child/file', '']))
        check(command, paths, files)
      })
    }

    it(command + ' quotes unusual path names', () => {
      const files = { 'dir "quoted"/file': '', 'dir with spaces/file': '' }
      check(command, ['/dir "quoted"', '/dir with spaces'], files)
    })

    it(command + ' emits normalized mounted paths', () => {
      const terminal = createTerminal({ 'src/dir/file': '' }, { mount: '/workspace', cwd: '/workspace/src' })
      const result = terminal.run(command + ' 2>/dev/null')
      assert.deepEqual(result.notes, [note(command.split(' ')[0], ['/workspace/src/dir'])])
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
    })
  }

  for (const command of [
    'tree -L1 a | wc -l',
    'tree -L1 a >/dev/null',
    'tree -L1 a 2>/dev/null | cat',
    '(tree -L1 a)',
    'value=$(tree -L1 a); true',
    'tree -L1 a; tree -L1 a',
    'find a -maxdepth 1 | wc -l',
    'find a -maxdepth 1 >/dev/null',
    'find a -maxdepth 1 2>/dev/null | cat',
    '(find a -maxdepth 1)',
    'value=$(find a -maxdepth 1); true',
    'find a -maxdepth 1; find a -maxdepth 1',
  ]) {
    it(command + ' retains the note independently of output routing', () => {
      const result = createTerminal(FILES).run(command)
      assert.deepEqual(result.notes, [note(command.includes('tree') ? 'tree' : 'find', ['/a/one'])])
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
      assert.deepEqual(result.unsupported, [])
    })
  }

  it('does not carry notes into later runs', () => {
    const terminal = createTerminal(FILES)
    assert.ok(terminal.run('tree -L1; find . -maxdepth 0').notes.length > 0)
    assert.deepEqual(terminal.run('tree -a; find .').notes, [])
  })
})

describe('frontier inspection is bounded', () => {
  for (const [command, tokens] of [[tree, ['-L1']], [find, ['.', '-maxdepth', '1']]]) {
    it(command.name + ' does not traverse below the immediate frontier children', () => {
      const fs = createFs({ 'frontier/child/deep/file': '' })
      const listed = []
      const listDir = fs.listDir
      fs.listDir = (path) => {
        assert.ok(path === '/' || path === '/frontier', 'unexpected descendant enumeration: ' + path)
        listed.push(path)
        return listDir(path)
      }
      const ctx = { cwd: '/', fs, notes: new Set(), flushOutput: (output) => output }
      const result = command('', tokens, ctx)
      assert.equal(result.exitCode, 0)
      assert.ok(listed.includes('/frontier'))
      assert.deepEqual([...ctx.notes], [note(command.name, ['/frontier'])])
    })
  }
})
