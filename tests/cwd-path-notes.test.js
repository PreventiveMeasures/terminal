import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const SOURCES = {
  file: 'x\n',
  'src/file': 'source\n',
  'dir/keep': '',
  'sub/keep': 'local\n',
}
const OPTIONS = { mount: '/repo', cwd: '/repo/sub' }

function note(command, path, alternatives, cwd = '/repo/sub', kind = 'file', differ = false) {
  const paths = alternatives.map((name) => JSON.stringify(name))
  const location = paths.length === 1 ? `A ${kind} exists at ${paths[0]}` : `Both of ${paths.join(' and ')} exist${differ ? ', and they differ in contents' : ''}`
  return `${command}: relative path ${JSON.stringify(path)} was not found from cwd ${JSON.stringify(cwd)}. ${location}.`
}

const cases = [
  ['cat file', 'cat', 'file', 1, 'cat: file: no such file or directory\n'],
  ['head file', 'head', 'file', 1, 'head: file: no such file or directory\n'],
  ['tail file', 'tail', 'file', 1, 'tail: file: no such file or directory\n'],
  ['wc file', 'wc', 'file', 1, 'wc: file: no such file or directory\n'],
  ['tac file', 'tac', 'file', 1, 'tac: file: no such file or directory\n'],
  ['nl file', 'nl', 'file', 1, 'nl: file: no such file or directory\n'],
  ['cut -c1 file', 'cut', 'file', 1, 'cut: file: no such file or directory\n'],
  ['base64 file', 'base64', 'file', 1, 'base64: file: no such file or directory\n'],
  ['sort file', 'sort', 'file', 2, 'sort: file: no such file or directory\n'],
  ['ls dir', 'ls', 'dir', 2, 'ls: dir: no such file or directory\n'],
  ['find dir', 'find', 'dir', 1, 'find: dir: no such file or directory\n'],
  ['cd dir', 'cd', 'dir', 1, 'cd: dir: No such file or directory\n'],
  ['grep x file', 'grep', 'file', 2, 'grep: file: no such file or directory\n'],
  ['grep -r x dir', 'grep', 'dir', 2, 'grep: dir: no such file or directory\n'],
  ['grep -s x file', 'grep', 'file', 2, ''],
  ['grep -rs x dir', 'grep', 'dir', 2, ''],
  ['grep -f file keep', 'grep', 'file', 2, 'grep: file: no such file or directory\n'],
  ["sed 's/x/y/' file", 'sed', 'file', 2, 'sed: file: no such file or directory\n'],
  ["sed -i 's/x/y/' file", 'sed', 'file', 2, 'sed: file: no such file or directory\n'],
  ['sed -f file keep', 'sed', 'file', 4, 'sed: file: no such file or directory\n'],
  ["awk '{print}' file", 'awk', 'file', 2, 'awk: file: no such file or directory\n'],
  ['awk -f file', 'awk', 'file', 2, 'awk: cannot open program file `file`: No such file or directory\n'],
  ['cp file /tmp/file', 'cp', 'file', 1, "cp: cannot stat 'file': No such file or directory\n"],
  ['cp keep src/file', 'cp', 'src/file', 1, "cp: cannot create regular file 'src/file': No such file or directory\n"],
  ['cp -t dir keep', 'cp', 'dir', 1, "cp: target directory 'dir': No such file or directory\n"],
  ['cp keep keep dir', 'cp', 'dir', 1, "cp: target 'dir': No such file or directory\n"],
  ['rm file', 'rm', 'file', 1, "rm: cannot remove 'file': No such file or directory\n"],
  ['cat <file', 'shell', 'file', 1, 'error: file: No such file or directory\n'],
]

describe('cwd notes accompany actual relative-path lookup failures', () => {
  for (const [line, command, path, exitCode, stderr] of cases) {
    it(line + ' preserves the failure and points to a verified absolute path', () => {
      const result = createTerminal(SOURCES, OPTIONS).run(line)
      assert.equal(result.exitCode, exitCode)
      assert.equal(result.stderr, stderr)
      assert.deepEqual(result.unsupported, [])
      assert.equal(result.cwd, '/repo/sub')
      assert.deepEqual(result.notes, [note(command, path, ['/repo/' + path], undefined, path === 'dir' ? 'dir' : 'file')])
    })
  }

  it('reports tree failures even though tree writes the error to stdout', () => {
    const result = createTerminal(SOURCES, OPTIONS).run('tree dir')
    assert.equal(result.exitCode, 2)
    assert.equal(result.stderr, '')
    assert.equal(result.stdout, 'dir  [error opening dir]\n\n0 directories, 0 files\n')
    assert.deepEqual(result.notes, [note('tree', 'dir', ['/repo/dir'], undefined, 'dir')])
  })

  it('retains successful file output alongside a missing operand', () => {
    const result = createTerminal(SOURCES, OPTIONS).run('cat keep file keep')
    assert.equal(result.stdout, 'local\nlocal\n')
    assert.equal(result.stderr, 'cat: file: no such file or directory\n')
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.notes, [note('cat', 'file', ['/repo/file'])])
  })

  it('does not turn a valid path in the wrong location into a successful read', () => {
    const terminal = createTerminal(SOURCES, OPTIONS)
    const result = terminal.run('cat file')
    assert.equal(result.stdout, '')
    assert.equal(result.exitCode, 1)
    assert.equal(terminal.cwd(), '/repo/sub')
    assert.equal(terminal.run('cat /repo/file').stdout, 'x\n')
  })

  for (const [line, stdout] of [
    ['awk \'BEGIN {print (getline value < "file"); print ERRNO}\'', '-1\nNo such file or directory\n'],
    ["awk 'BEGINFILE {if (ERRNO) nextfile} {print}' file keep", 'local\n'],
  ]) {
    it(line + ' notes an attempted open even when awk handles its error', () => {
      const result = createTerminal(SOURCES, OPTIONS).run(line)
      assert.equal(result.stdout, stdout)
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
      assert.deepEqual(result.notes, [note('awk', 'file', ['/repo/file'])])
    })
  }
})

describe('cwd alternatives use real filesystem lookups', () => {
  it('finds root-relative paths when the source map is mounted at root', () => {
    const result = createTerminal(SOURCES, { cwd: '/sub' }).run('cat src/file')
    assert.deepEqual(result.notes, [note('cat', 'src/file', ['/src/file'], '/sub')])
  })

  it('finds mount-relative paths from the initial root cwd', () => {
    const result = createTerminal(SOURCES, { mount: '/repo' }).run('cat file')
    assert.deepEqual(result.notes, [note('cat', 'file', ['/repo/file'], '/')])
  })

  it('normalizes mount, cwd and the suggested path while retaining the requested spelling', () => {
    const result = createTerminal(SOURCES, { mount: '/workspace/../repo//', cwd: '/repo/./sub' }).run('cat ./src//file')
    assert.deepEqual(result.notes, [note('cat', './src//file', ['/repo/src/file'])])
  })

  it('reports both root and mounted alternatives without duplicate paths', () => {
    const terminal = createTerminal({ ...SOURCES, 'tmp/file': 'mounted\n' }, { ...OPTIONS, writable: '/tmp/' })
    terminal.run('printf overlay >/tmp/file')
    const result = terminal.run('cat tmp/file')
    assert.deepEqual(result.notes, [note('cat', 'tmp/file', ['/repo/tmp/file', '/tmp/file'], undefined, 'file', true)])
  })

  it('checks intermediate components before simplifying dot-dot', () => {
    const result = createTerminal(SOURCES, OPTIONS).run('cat file/../src/file')
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.notes, [])
  })

  it('checks trailing slashes on candidates', () => {
    const result = createTerminal(SOURCES, OPTIONS).run('cat file/')
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.notes, [])
  })

  it('quotes requested paths, cwd and alternatives safely', () => {
    const path = 'line\n"quoted"'
    const files = { [path]: '', 'sub/keep': '' }
    const result = createTerminal(files, { mount: '/repo "name"', cwd: '/repo "name"/sub' }).run("cat 'line\n\"quoted\"'")
    assert.deepEqual(result.notes, [note('cat', path, ['/repo "name"/' + path], '/repo "name"/sub')])
  })

  it('does not search unrelated directories or suggest only matching basenames', () => {
    const result = createTerminal({ 'elsewhere/file': '', 'sub/keep': '' }, OPTIONS).run('cat file')
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.notes, [])
  })
})

describe('cwd notes do not describe probes, successful operations or different failures', () => {
  for (const line of [
    'test -f file', '[ -e file ]', '[[ -f file ]]', 'rm -f file',
    'cat absent', 'cat /file', 'cat keep/../file', "cat ''", 'echo file',
    'cp keep file', 'printf x >file', 'unknown', 'false && cat file', 'true || cat file',
    'grep -m0 x file', 'grep -q local keep file', "sed 'q' keep file", "awk 'BEGIN {exit}' file",
    "awk '{exit}' keep file", 'basename file', 'dirname file', './file',
  ]) {
    it(line + ' has no cwd note', () => {
      const result = createTerminal(SOURCES, OPTIONS).run(line)
      assert.deepEqual(result.notes.filter((message) => message.includes('was not found from cwd')), [])
    })
  }

  it('does not emit cwd notes for unmatched globs passed to a successful command', () => {
    const result = createTerminal({ 'file.txt': '', 'sub/keep': '' }, OPTIONS).run('echo *.txt')
    assert.equal(result.stdout, '*.txt\n')
    assert.equal(result.exitCode, 0)
    assert.ok(!result.notes.some((message) => message.includes('was not found from cwd')))
  })

  it('does not report alternative paths when a valid write creates the requested file', () => {
    const terminal = createTerminal(SOURCES, { mount: '/repo', cwd: '/tmp', writable: '/tmp/' })
    const result = terminal.run('cp /repo/file file; cat file')
    assert.equal(result.stdout, 'x\n')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.notes, [])
  })
})

describe('cwd notes survive output routing and respect run isolation', () => {
  for (const line of [
    'cat file 2>/dev/null | true', '(cat file) 2>/dev/null | true',
    'value=$(cat file 2>/dev/null); true', 'cat file >/dev/null 2>&1; true',
    'find keep -exec cat file \\; 2>/dev/null | true',
    "printf file | xargs cat 2>/dev/null | true",
  ]) {
    it(line + ' keeps the note when stderr is hidden', () => {
      const result = createTerminal(SOURCES, OPTIONS).run(line)
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
      assert.deepEqual(result.notes, [note('cat', 'file', ['/repo/file'])])
    })
  }

  it('deduplicates identical failures but preserves different commands and paths', () => {
    const result = createTerminal(SOURCES, OPTIONS).run('cat file file; cat file; ls file; cat src/file')
    assert.deepEqual(result.notes, [note('cat', 'file', ['/repo/file']), note('ls', 'file', ['/repo/file']), note('cat', 'src/file', ['/repo/src/file'])])
  })

  it('uses the cwd at each failure and clears notes for later runs', () => {
    const terminal = createTerminal(SOURCES, OPTIONS)
    const first = terminal.run('cat file; cd /repo/dir; cat file')
    assert.deepEqual(first.notes, [note('cat', 'file', ['/repo/file']), note('cat', 'file', ['/repo/file'], '/repo/dir')])
    assert.deepEqual(terminal.run('cat /repo/file').notes, [])
    assert.ok(Object.isFrozen(first.notes))
  })

  it('keeps notes from earlier completed input units after a parse error', () => {
    const result = createTerminal(SOURCES, OPTIONS).run('cat file\necho $(if true)')
    assert.equal(result.exitCode, 2)
    assert.deepEqual(result.notes, [note('cat', 'file', ['/repo/file'])])
  })
})

describe('custom commands and writable failures use the shared cwd note path', () => {
  it('supports custom readInputs without changing returned read errors', () => {
    const terminal = createTerminal(SOURCES, { ...OPTIONS, commands: {
      read: (io) => {
        const result = io.readInputs(io.args)
        return { stdout: result.inputs.map((input) => input.content).join(''), stderr: result.stderr, exitCode: result.failed ? 1 : 0 }
      },
    } })
    const result = terminal.run('read file')
    assert.equal(result.stderr, 'read: file: no such file or directory\n')
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.notes, [note('read', 'file', ['/repo/file'])])
  })

  it('supports custom directory reads while leaving existence probes silent', () => {
    const terminal = createTerminal(SOURCES, { ...OPTIONS, commands: {
      list: ({ fs, args }) => fs.listDir(args[0]).files.join('\n'),
      probe: ({ fs }) => String(fs.isFile('file') || fs.isDir('dir') || fs.readFile('file') !== undefined),
    } })
    const listed = terminal.run('list dir')
    assert.equal(listed.stderr, 'list: dir: no such file or directory\n')
    assert.equal(listed.exitCode, 1)
    assert.deepEqual(listed.notes, [note('list', 'dir', ['/repo/dir'], undefined, 'dir')])
    const probed = terminal.run('probe')
    assert.equal(probed.stdout, 'false')
    assert.deepEqual(probed.notes, [])
  })

  it('isolates notes from reentrant runs', () => {
    let inner
    const terminal = createTerminal(SOURCES, { ...OPTIONS, commands: {
      reenter: () => { inner = terminal.run('ls file'); return '' },
    } })
    const outer = terminal.run('cat file; reenter; cat file')
    assert.deepEqual(outer.notes, [note('cat', 'file', ['/repo/file'])])
    assert.deepEqual(inner.notes, [note('ls', 'file', ['/repo/file'])])
  })

  for (const read of [
    (io) => io.fs.listDir('dir'),
    (io) => { const result = io.readInputs(['dir']); if (result.failed) throw new Error(result.stderr.trim()) },
  ]) {
    it('routes a retained custom I/O view to the active run while preserving its cwd', () => {
      let nested, saved
      const terminal = createTerminal(SOURCES, { ...OPTIONS, commands: {
        save: (io) => { saved = io; return '' },
        use: () => { read(saved); return '' },
        reenter: () => { nested = terminal.run('use'); return '' },
      } })
      const first = terminal.run('save; cd /repo')
      assert.deepEqual(first.notes, [])
      const second = terminal.run('use')
      assert.notEqual(second.exitCode, 0)
      assert.deepEqual(second.notes, [note('save', 'dir', ['/repo/dir'], undefined, 'dir')])
      assert.deepEqual(first.notes, [])
      const outer = terminal.run('reenter')
      assert.deepEqual(outer.notes, [])
      assert.deepEqual(nested.notes, [note('save', 'dir', ['/repo/dir'], undefined, 'dir')])
      assert.deepEqual(terminal.run('true').notes, [])
    })
  }

  for (const [line, command] of [
    ['printf x >missing/../repo/file', 'shell'],
    ["sed 'w missing/../repo/file' /repo/repo/file", 'sed'],
    ["sed -i'missing/../repo/*' p file", 'sed'],
  ]) {
    it(line + ' reports a structured writable ENOENT without parsing stderr', () => {
      const terminal = createTerminal({ 'missing/keep': '', 'repo/file': 'text' }, { mount: '/repo', cwd: '/tmp', writable: '/tmp/' })
      terminal.run('printf text >file')
      const result = terminal.run(line)
      assert.notEqual(result.exitCode, 0)
      assert.deepEqual(result.unsupported, [])
      assert.deepEqual(result.notes, [note(command, 'missing/../repo/file', ['/repo/repo/file'], '/tmp')])
    })
  }
})
