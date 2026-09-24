import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { createFs } from '../src/filesystem.js'
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
async function check(command, paths, files = FILES, hidden = []) {
  const result = await createTerminal(files).run(command)
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

  it('does not claim a hidden entry the depth limit had already cut off', async () => {
    // `/dir` stops at the frontier, so its `.child` was never a name this
    // listing passed over for being hidden — the depth note covers it whole.
    check('tree -L1', ['/dir'], { 'dir/.child': '', 'dir/shown': '' })
    await check('tree -L2', [], { 'dir/.child': '', 'dir/shown': '' }, ['/dir/.child'])
  })

  it('leaves output and report totals unchanged', async () => {
    const result = await check('tree -L1', ['/a', '/c'], FILES, ['/.hidden'])
    assert.equal(result.stdout, '.\n├── a\n├── b\n├── c\n└── root\n\n4 directories, 1 file\n')
  })

  it('does not report a frontier containing only hidden entries without -a', async () => {
    await check('tree -L1', [], { 'dir/.child/file': '' })
    await check('tree -aL1', ['/dir'], { 'dir/.child/file': '' })
  })

  it('does not attribute files filtered by -d to the depth limit', async () => {
    await check('tree -dL1', [], { 'dir/file': '' })
    await check('tree -dL1', [], { 'dir/.child/file': '' })
    await check('tree -adL1', ['/dir'], { 'dir/.child/file': '' })
  })

  it('does not report empty directories at the frontier', async () => {
    assert.deepEqual((await createTerminal({}, { mount: '/empty' }).run('tree -L1')).notes, [])
    await check('tree -L1', [], {})
  })

  it('preserves an earlier omission when a later displayed name is unsupported', async () => {
    const result = await createTerminal({ 'a/file': '', 'z\nname': '' }).run('tree -L1 2>/dev/null | true')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.notes, [note('tree', ['/a'])])
    assert.ok(result.unsupported.some(({ command, detail }) => command === 'tree' && detail === 'filename escaping'))
  })

  it('keeps the hidden note when a displayed name aborts the walk', async () => {
    const result = await createTerminal({ '.hidden': '', 'a/file': '', 'z\nname': '' }).run('tree 2>/dev/null | true')
    assert.equal(result.stderr, '')
    assert.deepEqual(result.notes, [hiddenNote(['/.hidden'])])
    assert.ok(result.unsupported.some(({ detail }) => detail === 'filename escaping'))
  })

  for (const command of ['tree >/dev/null', 'tree | wc -l', 'value=$(tree); true', '(tree)']) {
    it(command + ' retains the hidden note independently of output routing', async () => {
      const result = await createTerminal({ '.hidden': '', visible: '' }).run(command)
      assert.deepEqual(result.notes, [hiddenNote(['/.hidden'])])
      assert.equal(result.exitCode, 0)
    })
  }

  it('never inspects unsupported names below the displayed frontier', async () => {
    await check('tree -L1', ['/dir'], { 'dir/name\nwith\nnewlines': '' })
  })

  for (const command of ['tree -L0', 'tree -Lnope', 'tree -L1 --unknown', 'tree -L1 a c', 'tree -L1 missing']) {
    it(command + ' emits no note when listing never starts', async () => {
      const result = await createTerminal(FILES).run(command)
      assert.notEqual(result.exitCode, 0)
      assert.deepEqual(result.notes, [])
    })
  }
})

describe('find depth omission notes', () => {
  // Every name below is one `find` itself prints for the same command: the note
  // reads beside the output, so it spells a directory the way the start it was
  // reached through spells it. A start named three ways is three entries.
  for (const [command, paths] of [
    ['find . -maxdepth 0', ['.']],
    ['find . -maxdepth 1', ['./.hidden', './a', './b', './c']],
    ['find . -maxdepth 2', ['./.hidden/inner', './a/one']],
    ['find . -maxdepth 99', []],
    ['find .', []],
    ['find root -maxdepth 0', []],
    ['find a -maxdepth 1', ['a/one']],
    ['find a ./a /a/ -maxdepth 1', ['./a/one', '/a/one', 'a/one']],
    ['find . -maxdepth 1 -name absent', ['./.hidden', './a', './b', './c']],
    ['find . -maxdepth 1 -type f', ['./.hidden', './a', './b', './c']],
    ['find . -maxdepth 1 -mindepth 3', ['./.hidden', './a', './b', './c']],
    ['find . -maxdepth 0 -mindepth 1 -prune', ['.']],
    ['find . -maxdepth 0 -prune', []],
    ['find . -maxdepth 1 -prune', []],
    ['find . -maxdepth 1 -name a -prune -o -print', ['./.hidden', './b', './c']],
    ['find . -maxdepth 2 -name a -prune -o -print', ['./.hidden/inner']],
    ['find . -maxdepth 1 ! -prune -o -print', []],
    ['find . -maxdepth 1 -name absent -prune -o -print', ['./.hidden', './a', './b', './c']],
  ]) {
    it(command + ' reports only depth-pruned directories', () => check(command, paths))
  }

  it('preserves normal printed paths', async () => {
    const result = await check('find . -maxdepth 1', ['./.hidden', './a', './b', './c'])
    // Each noted name is a line of this very output.
    assert.equal(result.stdout, '.\n./.hidden\n./a\n./b\n./c\n./root\n')
  })

  it('ignores empty frontier directories and an empty root', async () => {
    assert.deepEqual((await createTerminal({}, { mount: '/empty' }).run('find /empty -maxdepth 0')).notes, [])
    await check('find . -maxdepth 0', [], {})
  })

  it('retains omissions across later root errors and visits remaining roots', async () => {
    const result = await createTerminal(FILES).run('find a missing c -maxdepth 0')
    assert.equal(result.stdout, 'a\nc\n')
    assert.equal(result.stderr, 'find: \'missing\': No such file or directory\n')
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.unsupported, [])
    assert.deepEqual(result.notes, [note('find', ['a', 'c'])])
  })

  it('retains an omission when an executed command reports unsupported', async () => {
    const result = await createTerminal(FILES).run('find a -maxdepth 0 -exec unknown {} \\; 2>/dev/null | true')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.notes, [note('find', ['a'])])
    assert.ok(result.unsupported.some(({ command }) => command === 'unknown'))
  })

  it('preserves depth notes and failed batched execution status', async () => {
    const result = await createTerminal(FILES).run('find a -maxdepth 0 -exec false {} +')
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.unsupported, [])
    assert.deepEqual(result.notes, [note('find', ['a'])])
  })

  it('checks frontier contents after per-entry actions remove or create files', async () => {
    const terminal = createTerminal({ file: 'text' }, { mount: '/repo', writable: '/tmp/' })
    const created = await terminal.run('find /tmp -maxdepth 0 -exec cp /repo/file /tmp/file \\;')
    assert.equal(created.exitCode, 0)
    assert.deepEqual(created.notes, [note('find', ['/tmp'])])
    const removed = await terminal.run('find /tmp -maxdepth 0 -exec rm /tmp/file \\;')
    assert.equal(removed.exitCode, 0)
    assert.deepEqual(removed.notes, [])
  })

  for (const command of ['find . -maxdepth -1', 'find . -maxdepth 1 -unknown', 'find . -maxdepth 1 -quit']) {
    it(command + ' produces no omission notes when the expression is rejected', async () => {
      const result = await createTerminal(FILES).run(command)
      assert.notEqual(result.exitCode, 0)
      assert.deepEqual(result.notes, [])
    })
  }
})

describe('depth notes retain full paths, bounded details, and shell channel semantics', () => {
  // `tree` prints bare names under a heading, so an omitted directory has no
  // spelling of its own there and keeps the absolute one; `find . …` prints
  // every path from `.`, and its note follows.
  for (const [command, named] of [['tree -L1', (paths) => paths], ['find . -maxdepth 1', (paths) => paths.map((path) => '.' + path)]]) {
    for (const count of [9, 10]) {
      it(command + ' lists full paths only for ' + count + ' < 10 directories', async () => {
        const paths = Array.from({ length: count }, (_, i) => '/dir' + i)
        const files = Object.fromEntries(paths.map((path) => [path + '/child/file', '']))
        await check(command, named(paths), files)
      })
    }

    it(command + ' quotes unusual path names', async () => {
      const files = { 'dir "quoted"/file': '', 'dir with spaces/file': '' }
      await check(command, named(['/dir "quoted"', '/dir with spaces']), files)
    })

    it(command + ' emits normalized mounted paths', async () => {
      const terminal = createTerminal({ 'src/dir/file': '' }, { mount: '/workspace', cwd: '/workspace/src' })
      const result = await terminal.run(command + ' 2>/dev/null')
      assert.deepEqual(result.notes, [note(command.split(' ')[0], command.startsWith('find') ? ['./dir'] : ['/workspace/src/dir'])])
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
    it(command + ' retains the note independently of output routing', async () => {
      const result = await createTerminal(FILES).run(command)
      assert.deepEqual(result.notes, [note(command.includes('tree') ? 'tree' : 'find', command.includes('tree') ? ['/a/one'] : ['a/one'])])
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
      assert.deepEqual(result.unsupported, [])
    })
  }

  it('does not carry notes into later runs', async () => {
    const terminal = createTerminal(FILES)
    assert.ok((await terminal.run('tree -L1; find . -maxdepth 0')).notes.length > 0)
    assert.deepEqual((await terminal.run('tree -a; find .')).notes, [])
  })
})

describe('frontier inspection is bounded', () => {
  for (const [command, tokens] of [[tree, ['-L1']], [find, ['.', '-maxdepth', '1']]]) {
    it(command.name + ' does not traverse below the immediate frontier children', async () => {
      const fs = createFs({ 'frontier/child/deep/file': '' })
      const listed = []
      const listDir = fs.listDir
      fs.listDir = (path) => {
        assert.ok(path === '/' || path === '/frontier', 'unexpected descendant enumeration: ' + path)
        listed.push(path)
        return listDir(path)
      }
      const ctx = { cwd: '/', fs, notes: new Set(), flushOutput: (output) => output }
      const result = await command('', tokens, ctx)
      assert.equal(result.exitCode, 0)
      assert.ok(listed.includes('/frontier'))
      assert.deepEqual([...ctx.notes], [note(command.name, [command === find ? './frontier' : '/frontier'])])
    })
  }
})
