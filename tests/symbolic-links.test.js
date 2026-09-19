import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { createFs, lookup, walkTree } from '../src/fs.js'

// A source value that is not a string declares what the entry is, where a
// path-to-content map cannot spell it: today `{ type: 'link', target }`, the
// symbolic link `find -type l` asks about and `node_modules/.bin` is full of.
// Checked against GNU coreutils 9.4, findutils 4.9, tree 2.1 and bash 5.2 over
// the same tree made on disk.
const SOURCES = {
  'node_modules/pkg/bin/cli.js': 'run\n',
  'node_modules/pkg/index.js': 'module\n',
  'node_modules/.bin/cli': { type: 'link', target: '../pkg/bin/cli.js' },
  'node_modules/.bin/stale': { type: 'link', target: '../gone/cli.js' },
  'src/app.js': 'app\n',
  pkg: { type: 'link', target: 'node_modules/pkg' },
}

const terminal = (sources = SOURCES, options = {}) => createTerminal(sources, options)

function check(t, command, stdout = '', { stderr = '', exitCode = 0, notes = [], cwd = '/' } = {}) {
  assert.deepEqual(t.run(command), { stdout, stderr, exitCode, cwd, notes, unsupported: [] }, command)
}

// A gap reports on every channel: the command fails, says why, and the run
// carries the diagnostic where a redirect cannot hide it.
function gap(t, command, detail, stderr) {
  const result = t.run(command)
  assert.deepEqual(result.unsupported.map((u) => u.detail), [detail], command)
  assert.equal(result.stderr, stderr, command)
  assert.notEqual(result.exitCode, 0, command)
  return result
}

describe('a source entry can declare a symbolic link', () => {
  it('lists links apart from the files and the directories a map implies', () => {
    const fs = createFs({ 'a/file': 'x\n', 'a/link': { type: 'link', target: 'file' }, dir: { type: 'link', target: 'a' } })
    assert.deepEqual(fs.listDir('/'), { dirs: ['a'], files: [], links: ['dir'] })
    assert.deepEqual(fs.listDir('/a'), { dirs: [], files: ['file'], links: ['link'] })
    assert.deepEqual([fs.isLink('/a/link'), fs.isFile('/a/link'), fs.isDir('/dir')], [true, false, false])
    assert.equal(fs.readLink('/a/link'), 'file')
    assert.equal(fs.readFile('/a/link'), undefined)
    // A link is as long as the path it holds, which is what it takes on disk.
    assert.equal(fs.fileSize('/a/link'), 4)
  })

  it('walks a link as an entry of its own, and never through it', () => {
    const fs = createFs({ 'a/file': 'x\n', 'a/link': { type: 'link', target: 'file' }, up: { type: 'link', target: '.' } })
    assert.deepEqual([...walkTree(fs, '/')].map((e) => [e.path, e.kind]), [
      ['/', 'dir'], ['/a', 'dir'], ['/a/file', 'file'], ['/a/link', 'link'], ['/up', 'link'],
    ])
    assert.deepEqual([...walkTree(fs, '/up')].map((e) => [e.path, e.kind]), [['/up', 'link']])
    assert.deepEqual([...fs.walkFiles('/')], ['/a/file'])
  })

  it('replaces an earlier declaration of the same name, whichever kind each was', () => {
    const fs = createFs(new Map([['x', 'file\n'], ['./x', { type: 'link', target: 'y' }], ['y', { type: 'link', target: 'x' }], ['/y', 'later\n']]))
    assert.deepEqual(fs.listDir('/'), { dirs: [], files: ['y'], links: ['x'] })
    assert.equal(fs.readFile('/y'), 'later\n')
    assert.equal(fs.readLink('/x'), 'y')
  })

  it('refuses a declaration it cannot read, and still ignores a value declaring nothing', () => {
    for (const [sources, message] of [
      [{ x: { type: 'lnik', target: 'y' } }, /declares type "lnik"/u],
      [{ x: { target: 'y' } }, /declares type null/u],
      [{ x: { type: 'link' } }, /non-empty target/u],
      [{ x: { type: 'link', target: '' } }, /non-empty target/u],
      [{ x: { type: 'link', target: 'a\0b' } }, /NUL/u],
    ]) {
      assert.throws(() => createTerminal(sources), message)
    }
    const fs = createFs({ nothing: null, list: ['a'], nested: { file: '' }, kept: 'x\n' })
    assert.deepEqual(fs.listDir('/'), { dirs: [], files: ['kept'], links: [] })
  })
})

describe('a link is resolved the way the kernel resolves one', () => {
  it('reads the target from the directory the link itself is in', () => {
    const t = terminal()
    check(t, 'cat node_modules/.bin/cli', 'run\n')
    check(t, 'cat pkg/index.js', 'module\n')
    check(t, 'wc -c pkg/bin/cli.js node_modules/.bin/cli', '4 pkg/bin/cli.js\n4 node_modules/.bin/cli\n8 total\n')
  })

  it('follows a link to a link, and a link named by a target of its own', () => {
    const t = terminal({ file: 'x\n', one: { type: 'link', target: 'two' }, two: { type: 'link', target: 'file' } })
    check(t, 'cat one two', 'x\nx\n')
    assert.deepEqual(lookup('/', 'one', createFs({ file: 'x\n', one: { type: 'link', target: 'two' }, two: { type: 'link', target: 'file' } })), { path: '/file', error: null })
  })

  it('reports a link that leads nowhere as the missing path it is', () => {
    const t = terminal()
    check(t, 'cat node_modules/.bin/stale', '', { stderr: 'cat: node_modules/.bin/stale: No such file or directory\n', exitCode: 1 })
    check(t, 'cat node_modules/.bin/cli/deeper', '', { stderr: 'cat: node_modules/.bin/cli/deeper: Not a directory\n', exitCode: 1 })
  })

  it('stops a resolution that never ends, as ELOOP does', () => {
    const t = terminal({ self: { type: 'link', target: 'self' }, ping: { type: 'link', target: 'pong' }, pong: { type: 'link', target: 'ping' } })
    check(t, 'cat self', '', { stderr: 'cat: self: Too many levels of symbolic links\n', exitCode: 1 })
    check(t, 'cat ping', '', { stderr: 'cat: ping: Too many levels of symbolic links\n', exitCode: 1 })
  })

  it('takes an absolute target as a path in this filesystem, not one inside the mount', () => {
    const sources = { file: 'mounted\n', inside: { type: 'link', target: '/repo/file' }, outside: { type: 'link', target: '/file' } }
    const t = createTerminal(sources, { mount: '/repo' })
    check(t, 'cat inside', 'mounted\n', { cwd: '/repo' })
    check(t, 'cat outside', '', { stderr: 'cat: outside: No such file or directory\n', exitCode: 1, cwd: '/repo' })
  })

  it('holds a target written with a trailing slash to the directory it names', () => {
    const t = terminal({ 'one/a.txt': 'one\n', 'two/b.txt': 'two\n', toDir: { type: 'link', target: 'two/' }, toFile: { type: 'link', target: 'one/a.txt/' } })
    check(t, 'cat toDir/b.txt', 'two\n')
    check(t, 'cat toFile', '', { stderr: 'cat: toFile: Not a directory\n', exitCode: 1 })
    check(t, 'realpath toFile', '', { stderr: 'realpath: toFile: Not a directory\n', exitCode: 1 })
    check(t, 'ls toDir', 'b.txt\n')
  })

  it('resolves `..` after a link against what the link leads to', () => {
    const t = terminal({ 'one/a.txt': 'one\n', 'two/b.txt': 'two\n', 'one/over': { type: 'link', target: '../two' } })
    check(t, 'cat one/over/b.txt', 'two\n')
    check(t, 'cat one/over/../a.txt', '', { stderr: 'cat: one/over/../a.txt: No such file or directory\n', exitCode: 1 })
    check(t, 'cat one/over/../two/b.txt', 'two\n')
  })
})

describe('find names a link, and passes over what it points at', () => {
  it('answers -type l beside -type f, which is the pairing a walk of node_modules needs', () => {
    const t = terminal()
    check(t, 'find node_modules -type f -o -type l',
      'node_modules/.bin/cli\nnode_modules/.bin/stale\nnode_modules/pkg/bin/cli.js\nnode_modules/pkg/index.js\n')
    check(t, 'find . -type l', './node_modules/.bin/cli\n./node_modules/.bin/stale\n./pkg\n')
    check(t, 'find . -type f -name "*.js"', './node_modules/pkg/bin/cli.js\n./node_modules/pkg/index.js\n./src/app.js\n')
    check(t, 'find node_modules/.bin -mindepth 1 -type d')
  })

  it('answers over a tree that declares no link at all', () => {
    const t = terminal({ 'a.txt': 'x\n' })
    check(t, 'find . -type l')
    check(t, 'find . -type f -o -type l', './a.txt\n')
    check(t, 'find . -type l -o -type f', './a.txt\n')
  })

  it('reports the link it is given rather than the tree it names', () => {
    const t = terminal()
    check(t, 'find pkg', 'pkg\n')
    check(t, 'find pkg -type l', 'pkg\n')
    // A trailing slash names the directory, which is the target's to be.
    check(t, 'find pkg/', 'pkg/\npkg/bin\npkg/bin/cli.js\npkg/index.js\n')
  })

  it('counts a link neither empty nor a directory', () => {
    const t = terminal({ 'holder/link': { type: 'link', target: 'gone' }, 'file.txt': '' })
    check(t, 'find . -empty', './file.txt\n')
  })

  it('keeps `-type l` apart from the types this filesystem cannot represent', () => {
    const t = terminal()
    gap(t, 'find . -type p', '-type p', "find: -type/--type expects 'f', 'd' or 'l', got: p\n")
    const bad = t.run('find . -type q')
    assert.deepEqual(bad.unsupported, [])
    assert.equal(bad.stderr, "find: -type/--type expects 'f', 'd' or 'l', got: q\n")
  })
})

describe('ls shows a link as the entry it is', () => {
  const MADE = Date.UTC(2026, 8, 18, 5, 52)
  const at = (fn) => {
    mock.timers.enable({ apis: ['Date'], now: MADE })
    try { return fn() } finally { mock.timers.reset() }
  }
  const dated = (sources) => at(() => {
    const t = createTerminal(sources)
    t.run('TZ=UTC')
    return t
  })

  it('lists the name, and marks it with `@` under -F', () => {
    const t = terminal()
    check(t, 'ls node_modules/.bin', 'cli\nstale\n')
    check(t, 'ls -F node_modules/.bin', 'cli@\nstale@\n')
    check(t, 'ls -F', 'node_modules/\npkg@\nsrc/\n')
  })

  it('names what a link points at in a long listing, with the length of that path as its size', () => {
    const t = dated({ 'dir/file': 'x\n', 'dir/link': { type: 'link', target: 'file' }, far: { type: 'link', target: 'a'.repeat(60) } })
    assert.deepEqual(at(() => t.run('ls -l dir')).stdout, [
      'total 4',
      '-rw------- 1 user user 2 Sep 18 05:52 file',
      'lrwxrwxrwx 1 user user 4 Sep 18 05:52 link -> file',
      '',
    ].join('\n'))
    // ext4 keeps a target of under 60 bytes in the inode, where it takes no
    // block at all — the four bytes of `link` above add nothing to that
    // listing's 4 KiB. A target of 60 takes a block like any other file, so
    // this root counts one for the directory and one for the link.
    assert.deepEqual(at(() => t.run('ls -l far')).stdout, `lrwxrwxrwx 1 user user 60 Sep 18 05:52 far -> ${'a'.repeat(60)}\n`)
    assert.deepEqual(at(() => t.run('ls -l')).stdout.split('\n')[0], 'total 8')
  })

  it('marks what a link points at in a long listing, which is where GNU puts the indicator', () => {
    const t = dated({ 'two/b.txt': 'two\n', 'one/a.txt': 'one\n', dir: { type: 'link', target: 'two/' }, file: { type: 'link', target: 'one/a.txt' } })
    // The row names both, so the mark goes on the target, on the target as it
    // was written: a target already ending in a slash takes another.
    assert.deepEqual(at(() => t.run('ls -lF dir file')).stdout, [
      'lrwxrwxrwx 1 user user 4 Sep 18 05:52 dir -> two//',
      'lrwxrwxrwx 1 user user 9 Sep 18 05:52 file -> one/a.txt',
      '',
    ].join('\n'))
    assert.deepEqual(at(() => t.run('ls -F dir file')).stdout, 'dir@\nfile@\n')
  })

  it('lists what a link leads to when it is named alone, and the link itself under -l, -F or -d', () => {
    const t = terminal()
    check(t, 'ls pkg', 'bin\nindex.js\n')
    check(t, 'ls -d pkg', 'pkg\n')
    check(t, 'ls -F pkg', 'pkg@\n')
    check(t, 'ls pkg/', 'bin\nindex.js\n')
  })

  it('lists a link that leads nowhere, which is there however little it names', () => {
    const t = terminal()
    check(t, 'ls node_modules/.bin/stale', 'node_modules/.bin/stale\n')
    check(t, 'ls node_modules/.bin/gone', '', { stderr: "ls: cannot access 'node_modules/.bin/gone': No such file or directory\n", exitCode: 2 })
  })

  it('does not descend into a link under -R', () => {
    const t = terminal({ 'a/file': 'x\n', 'a/up': { type: 'link', target: '.' } })
    check(t, 'ls -R a', 'a:\nfile\nup\n')
  })
})

describe('the rest of the tree tools answer for a link without crossing it', () => {
  it('tree names the target beside the link, and counts it as what it leads to', () => {
    const t = terminal({
      'a/file': 'x\n', 'a/dir/deep': 'y\n',
      'a/link': { type: 'link', target: 'file' },
      'a/up': { type: 'link', target: 'dir' },
      'a/gone': { type: 'link', target: 'nowhere' },
    })
    // A link is named beside what it points at and crossed no further, while
    // the counts follow where it leads: `up` is one of the directories.
    check(t, 'tree a', 'a\n├── dir\n│   └── deep\n├── file\n├── gone -> nowhere\n├── link -> file\n└── up -> dir\n\n3 directories, 4 files\n')
    // `-F` marks what a name leads to, so the mark lands on the target.
    check(t, 'tree -F a', 'a/\n├── dir/\n│   └── deep\n├── file\n├── gone -> nowhere\n├── link -> file\n└── up -> dir/\n\n3 directories, 4 files\n')
    // `-d` lists the directories, which a link to one is, and marks none.
    check(t, 'tree -d a', 'a\n├── dir\n└── up -> dir\n\n3 directories\n')
    // The operand is opened for where it leads and printed for what it is, so
    // the `@` is its own and a link leading nowhere is still a name found.
    check(t, 'tree -F a/up', 'a/up@\n└── deep\n\n1 directory, 1 file\n')
    check(t, 'tree -F a/gone', 'a/gone@  [error opening dir]\n\n0 directories, 1 file\n')
  })

  it('du measures the link rather than what it points at', () => {
    const t = terminal()
    check(t, 'du -b node_modules/.bin', '31\tnode_modules/.bin\n')
    check(t, 'du -ab node_modules/.bin', '17\tnode_modules/.bin/cli\n14\tnode_modules/.bin/stale\n31\tnode_modules/.bin\n')
    check(t, 'du -b node_modules/.bin/cli', '17\tnode_modules/.bin/cli\n')
    check(t, 'du --inodes -s node_modules/.bin', '3\tnode_modules/.bin\n')
    // `-D`, spelled `-H` as well, asks about what an operand points at, which
    // is a name away and needs no walk; `-L` asks it of every link a walk
    // reaches. The three name one setting, so the last of them answers.
    check(t, 'du -Db node_modules/.bin/cli', '4\tnode_modules/.bin/cli\n')
    check(t, 'du -Hb node_modules/.bin/cli', '4\tnode_modules/.bin/cli\n')
    check(t, 'du -PHb node_modules/.bin/cli', '4\tnode_modules/.bin/cli\n')
    check(t, 'du -HPb node_modules/.bin/cli', '17\tnode_modules/.bin/cli\n')
    // An operand followed is the only link `-D` and `-H` follow: the ones a
    // walk reaches below it are measured as the links they are.
    check(t, 'du -Hb node_modules/.bin', '31\tnode_modules/.bin\n')
    gap(t, 'du -Lb node_modules/.bin', 'dereference', 'du: following symbolic links is not supported: node_modules/.bin/cli\n')
    check(t, 'du -LPb node_modules/.bin', '31\tnode_modules/.bin\n')
  })

  it('stat describes the name it is given, and -L what that name leads to', () => {
    const t = terminal()
    check(t, 'stat -c "%F %s" node_modules/.bin/cli', 'symbolic link 17\n')
    check(t, 'stat -c "%F" node_modules/.bin/stale', 'symbolic link\n')
    check(t, 'stat -L -c "%F %s" node_modules/.bin/cli', 'regular file 4\n')
    check(t, 'stat -c "%F" pkg', 'symbolic link\n')
    check(t, 'stat -L -c "%F" pkg', 'directory\n')
  })

  it('test asks about the link with -L and -h, and about the target otherwise', () => {
    const t = terminal()
    check(t, 'test -L node_modules/.bin/cli && echo link', 'link\n')
    check(t, 'test -h node_modules/.bin/stale && echo link', 'link\n')
    check(t, 'test -f node_modules/.bin/cli && echo file', 'file\n')
    check(t, 'test -d pkg && echo dir', 'dir\n')
    check(t, 'test -L src; echo $?', '1\n')
    // A link leading nowhere is a link, and is nothing else.
    check(t, 'test -e node_modules/.bin/stale; echo $?', '1\n')
    check(t, 'test -f node_modules/.bin/stale; echo $?', '1\n')
  })
})

describe('the shell expands and completes a link by its own name', () => {
  it('matches a link with a pattern, including one that leads nowhere', () => {
    const t = terminal()
    check(t, 'echo node_modules/.bin/*', 'node_modules/.bin/cli node_modules/.bin/stale\n')
    check(t, 'echo p*', 'pkg\n')
    // A segment with a path after it is crossed where the link leads to a
    // directory, as the shell resolves each component before matching the next.
    check(t, 'echo p*/index.js', 'pkg/index.js\n')
    check(t, 'echo */bin/cli.js', 'pkg/bin/cli.js\n')
    check(t, 'echo */*/bin/cli.js', 'node_modules/pkg/bin/cli.js\n')
  })

  it('completes a link, with the slash that lets a path go on through it', () => {
    const t = terminal()
    assert.deepEqual(t.complete('cat pk'), ['cat pkg/'])
    assert.deepEqual(t.complete('cd pk'), ['cd pkg/'])
    assert.deepEqual(t.complete('cat node_modules/.bin/'), ['cat node_modules/.bin/cli', 'cat node_modules/.bin/stale'])
    assert.deepEqual(t.complete('cd node_modules/.bin/'), [])
  })

  it('refuses a working directory reached through a link rather than answering as `cd -P`', () => {
    const t = terminal()
    gap(t, 'cd pkg', 'symbolic link cwd', 'cd: pkg: a working directory reached through a symbolic link is not supported (it leads to /node_modules/pkg)\n')
    check(t, 'cd node_modules/pkg; pwd', '/node_modules/pkg\n', { cwd: '/node_modules/pkg' })
  })
})

describe('a search, a copy and a comparison each meet a link on their own terms', () => {
  it('grep -r passes over a link a walk reaches, where -R searches what it names', () => {
    const t = terminal()
    check(t, 'grep -rn run node_modules', 'node_modules/pkg/bin/cli.js:1:run\n')
    check(t, 'grep -n run node_modules/.bin/cli', '1:run\n')
    // `-R` reads the file a link names, under the link's own name, and says so
    // of one that names nothing — which is an error, and the status GNU gives
    // a search that could not read something it was going to.
    check(t, 'grep -Rn run node_modules', 'node_modules/.bin/cli:1:run\nnode_modules/pkg/bin/cli.js:1:run\n', {
      stderr: 'grep: node_modules/.bin/stale: No such file or directory\n', exitCode: 2,
    })
    // A rule keeping the name out is what no spelling ever opens, so no
    // diagnostic is earned by a link the rules have already passed over.
    check(t, 'grep -Rn --exclude=stale run node_modules', 'node_modules/.bin/cli:1:run\nnode_modules/pkg/bin/cli.js:1:run\n', {
      notes: ['grep: excluded 1 entry by --include/--exclude/--exclude-dir rules: "/node_modules/.bin/stale".'],
    })
  })

  it('grep -R refuses the one link it would have to walk into, unless a rule keeps it out', () => {
    const t = terminal()
    gap(t, 'grep -Rn run .', '-R', 'grep: following a symbolic link to a directory is not supported: ./pkg\n')
    // `--exclude-dir` names a link to a directory as it names a directory,
    // where `--exclude` names neither.
    check(t, 'grep -Rn --exclude-dir=pkg --exclude=stale run .', './node_modules/.bin/cli:1:run\n', {
      notes: ['grep: excluded 3 entries by --include/--exclude/--exclude-dir rules: "/node_modules/.bin/stale", "/node_modules/pkg", "/pkg".'],
    })
  })

  it('rg leaves the links out of its walk, as ripgrep does without -L', () => {
    const t = terminal()
    check(t, 'rg -n run node_modules', 'node_modules/pkg/bin/cli.js:1:run\n', {
      notes: ['rg: skipped 1 hidden entry: "/node_modules/.bin". Hidden entries are searched with --hidden.'],
    })
    check(t, 'rg -n --hidden run node_modules', 'node_modules/pkg/bin/cli.js:1:run\n')
  })

  it('cp reads through a link it is handed, which is what GNU does without -r', () => {
    const t = createTerminal(SOURCES, { mount: '/repo', writable: '/tmp/' })
    check(t, 'cp node_modules/.bin/cli /tmp/cli; cat /tmp/cli', 'run\n', { cwd: '/repo' })
    // A link leading nowhere is one GNU cannot read through either.
    check(t, 'cp node_modules/.bin/stale /tmp/stale', '', {
      stderr: "cp: cannot stat 'node_modules/.bin/stale': No such file or directory\n", exitCode: 1, cwd: '/repo',
    })
  })

  it('cp answers for the destination before it looks at the tree for links', () => {
    const sources = { 'a/file': 'x\n', 'a/link': { type: 'link', target: 'file' }, afile: 'f\n' }
    const t = createTerminal(sources, { mount: '/repo', writable: '/tmp/' })
    // A copy the destination turns away never reaches the tree, so what it
    // holds is not what the refusal is about.
    check(t, 'cp -rT a a', '', { stderr: "cp: 'a' and 'a' are the same file\n", exitCode: 1, cwd: '/repo' })
    check(t, 'cp -r a afile', '', { stderr: "cp: cannot overwrite non-directory 'afile' with directory 'a'\n", exitCode: 1, cwd: '/repo' })
    check(t, 'cp -r a /tmp/nodir/deep', '', { stderr: "cp: cannot create directory '/tmp/nodir/deep': No such file or directory\n", exitCode: 1, cwd: '/repo' })
    // GNU makes the destination before the walk can find it reaching back
    // into the source, so a directory it cannot make answers ahead of that
    // loop — and where it can be made, the loop is what answers.
    check(t, 'cp -r a a', '', { stderr: "cp: cannot create directory 'a/a': Read-only file system\n", exitCode: 1, cwd: '/repo' })
    check(t, 'mkdir /tmp/d; cp -r /tmp/d /tmp/d/sub', '', {
      stderr: "cp: cannot copy a directory, '/tmp/d', into itself, '/tmp/d/sub'\n", exitCode: 1, cwd: '/repo',
    })
  })

  it('cp reads a destination link for where it leads, loop and all', () => {
    const sources = { 'a/file': 'x\n', into: { type: 'link', target: '/tmp/src' } }
    const made = () => createTerminal(sources, { mount: '/repo', writable: '/tmp/' })
    const at = { cwd: '/repo' }
    const seed = 'mkdir /tmp/src; printf a > /tmp/src/f; '
    // A destination reaching back into the source through a link is the loop
    // it is however it is spelled, and nothing of it is written.
    check(made(), seed + 'cp -r /tmp/src into', '', {
      stderr: "cp: cannot copy a directory, '/tmp/src', into itself, 'into/src'\n", exitCode: 1, ...at,
    })
    check(made(), seed + 'cp -r /tmp/src into/sub; find /tmp -type f', '/tmp/src/f\n', {
      stderr: "cp: cannot copy a directory, '/tmp/src', into itself, 'into/sub'\n", ...at,
    })
    // Two names for one directory are the same file, which GNU answers before
    // it asks what the destination is.
    check(made(), seed + 'cp -rT /tmp/src into', '', {
      stderr: "cp: '/tmp/src' and 'into' are the same file\n", exitCode: 1, ...at,
    })
    // A link leading somewhere else is a directory to copy into, as ever.
    check(made(), 'mkdir /tmp/src; cp -r a into; find /tmp -type f', '/tmp/src/a/file\n', at)
  })

  it('cp refuses a link a recursive copy meets, before that copy writes anything', () => {
    const sources = { 'a/file': 'x\n', 'a/link': { type: 'link', target: 'file' }, 'a/sub/deep': 'y\n', 'plain/f': 'z\n' }
    const t = createTerminal(sources, { mount: '/repo', writable: '/tmp/' })
    // `-r` keeps every link it meets as the link it is, and only `-L` reads
    // through one. Nothing here can make a link, so writing the file it points
    // at in its place would be a tree the copy was never asked for.
    const refused = gap(t, 'cp -r a /tmp/copy', 'symbolic link', 'cp: copying a symbolic link is not supported: a/link (a recursive copy keeps the link, and nothing here makes one)\n')
    assert.equal(refused.stdout, '')
    check(t, 'ls /tmp', '', { cwd: '/repo' })
    gap(t, 'cp -r a/link /tmp/copy', 'symbolic link', 'cp: copying a symbolic link is not supported: a/link (a recursive copy keeps the link, and nothing here makes one)\n')
    // A tree with no link in it is copied as ever.
    check(t, 'cp -r plain /tmp/plain; find /tmp -type f', '/tmp/plain/f\n', { cwd: '/repo' })
    check(t, 'cp -r a/sub /tmp/sub; find /tmp/sub -type f', '/tmp/sub/deep\n', { cwd: '/repo' })
  })

  it('diff names a link that is only on one side, and refuses only a walk that would cross one', () => {
    const t = terminal({ 'a/file': 'one\n', 'a/over': { type: 'link', target: '../b' }, 'b/file': 'two\n', 'b/over/x': 'x\n' })
    check(t, 'diff a b', [
      'diff a/file b/file', '1c1', '< one', '---', '> two',
      'Common subdirectories: a/over and b/over', '',
    ].join('\n'), { exitCode: 1 })
    gap(t, 'diff -r a b', 'symbolic link to a directory', 'diff: comparing what a symbolic link to a directory holds is not supported: a/over\n')
  })

  it('diff names the side a one-sided link is on, where -N stands in for the other', () => {
    const t = terminal({ 'a/file': 'one\n', 'b/file': 'one\n', 'b/only': { type: 'link', target: '../d' }, 'd/x': 'x\n' })
    // `-N` stands a name one side lacks in as an empty directory, so the walk
    // still meets the link — which is on the side whose listing held it,
    // whichever side that is.
    for (const order of ['a b', 'b a']) {
      gap(t, `diff -rN ${order}`, 'symbolic link to a directory', 'diff: comparing what a symbolic link to a directory holds is not supported: b/only\n')
    }
    // With no walk to cross it, GNU names it a directory the two share.
    check(t, 'diff -N a b', 'Common subdirectories: a/only and b/only\n')
  })

  it('diff answers for a link leading nowhere rather than standing in for it under -N', () => {
    const sources = {
      'a/keep': 'same\n', 'b/keep': 'same\n', 'b/only': 'real\n', 'b/pair': 'realfile\n',
      'a/both': { type: 'link', target: 'nowhere' }, 'b/both': { type: 'link', target: 'nowhere' },
      'a/pair': { type: 'link', target: 'nowhere' }, 'a/alone': { type: 'link', target: 'nowhere' },
    }
    const t = terminal(sources)
    // `-N` stands in for a name the directory does not have; a name it has and
    // cannot read is answered for, whatever is across from it.
    check(t, 'diff -rN a b', 'diff -rN a/only b/only\n0a1\n> real\n', {
      stderr: [
        'diff: a/alone: No such file or directory',
        'diff: a/both: No such file or directory',
        'diff: b/both: No such file or directory',
        'diff: a/pair: No such file or directory',
        '',
      ].join('\n'),
      exitCode: 2,
    })
    // Two operands have no listing behind them, so `-N` covers the one that
    // cannot be read — unless it is all either of them is.
    check(t, 'diff -N a/pair b/pair', '0a1\n> realfile\n', { exitCode: 1 })
    check(t, 'diff -N a/alone b/nothere', '', {
      stderr: 'diff: a/alone: No such file or directory\ndiff: b/nothere: No such file or directory\n', exitCode: 2,
    })
  })

  it('diff compares what two links point at', () => {
    const t = terminal({ 'a/file': 'one\n', 'a/link': { type: 'link', target: 'file' }, 'b/file': 'two\n', 'b/link': { type: 'link', target: 'file' } })
    check(t, 'diff a/link b/link', '1c1\n< one\n---\n> two\n', { exitCode: 1 })
    check(t, 'diff -r a b', [
      'diff -r a/file b/file', '1c1', '< one', '---', '> two',
      'diff -r a/link b/link', '1c1', '< one', '---', '> two', '',
    ].join('\n'), { exitCode: 1 })
  })
})

describe('what a link cannot change', () => {
  it('writes where a link leads, which is the file the overlay answers for', () => {
    const sources = {
      file: 'src\n',
      out: { type: 'link', target: '/tmp/out' },
      fresh: { type: 'link', target: '/tmp/new' },
      dirlink: { type: 'link', target: '/tmp/d' },
      outside: { type: 'link', target: '/repo/file' },
    }
    const made = () => createTerminal(sources, { mount: '/repo', writable: '/tmp/' })
    const at = { cwd: '/repo' }
    // Opening a link opens what it names, and a link to a name not there yet
    // is that name made — the file written either way is the overlay's.
    check(made(), 'printf seed > /tmp/out; echo x > out; cat /tmp/out', 'x\n', at)
    check(made(), 'echo y > fresh; cat /tmp/new', 'y\n', at)
    check(made(), 'printf seed > /tmp/out; cp file out; cat /tmp/out', 'src\n', at)
    check(made(), 'touch fresh; wc -c /tmp/new', '0 /tmp/new\n', at)
    check(made(), 'mkdir /tmp/d; mkdir -p dirlink/sub; find /tmp -type d', '/tmp\n/tmp/d\n/tmp/d/sub\n', at)
    // A link leading into the sources leads nowhere a write may go.
    gap(made(), 'echo z > outside', '>', 'error: `>` cannot write to `outside`: only `/tmp/` is writable\n')
  })

  it('refuses a write to a link naming a file under a directory that is not there', () => {
    const sources = { file: 'x\n', orphan: { type: 'link', target: '/tmp/gone/file' } }
    const made = () => createTerminal(sources, { mount: '/repo', writable: '/tmp/' })
    // The name a link leads to answers for its own parent: where that is not
    // there, the write fails as the kernel fails it rather than leaving bytes
    // under a directory nothing can reach.
    check(made(), 'echo x > orphan', '', { stderr: 'error: orphan: No such file or directory\n', exitCode: 1, cwd: '/repo' })
    check(made(), 'touch orphan', '', { stderr: "touch: cannot touch 'orphan': No such file or directory\n", exitCode: 1, cwd: '/repo' })
    // `cp` has a rule of its own for a destination leading nowhere, which it
    // gives whatever the name is missing.
    check(made(), 'cp file orphan', '', { stderr: "cp: not writing through dangling symlink 'orphan'\n", exitCode: 1, cwd: '/repo' })
    // Nothing of the refused write is left behind, reachable or not.
    const after = made()
    after.run('echo x > orphan')
    check(after, 'find /tmp', '/tmp\n', { cwd: '/repo' })
  })

  it('writes through no link that leads nowhere, where GNU writes through neither half', () => {
    const sources = {
      file: 'src\n', 'd/inner': 'in\n',
      out: { type: 'link', target: '/tmp/out' },
      fresh: { type: 'link', target: '/tmp/new' },
      outside: { type: 'link', target: '/repo/newname' },
    }
    const made = () => createTerminal(sources, { mount: '/repo', writable: '/tmp/' })
    const at = { cwd: '/repo' }
    // `cp` opens neither the link, which is a name already taken, nor the file
    // it names, which is not there — so a name a redirect would have made is
    // refused here.
    check(made(), 'cp file fresh', '', { stderr: "cp: not writing through dangling symlink 'fresh'\n", exitCode: 1, ...at })
    check(made(), 'cp file outside', '', { stderr: "cp: not writing through dangling symlink 'outside'\n", exitCode: 1, ...at })
    // Nothing is left where that copy would have gone.
    const refused = made()
    refused.run('cp file fresh')
    check(refused, 'find /tmp', '/tmp\n', at)
    // GNU announces the copy it is about to make before the refusal, as it
    // announces one it goes on to make.
    check(made(), 'cp -v file fresh', "'file' -> 'fresh'\n", {
      stderr: "cp: not writing through dangling symlink 'fresh'\n", exitCode: 1, ...at,
    })
    // A directory copy meets the same name as one already taken by something
    // that is not a directory, however little is at the end of it.
    check(made(), 'cp -r d fresh', '', {
      stderr: "cp: cannot overwrite non-directory 'fresh' with directory 'd'\n", exitCode: 1, ...at,
    })
    // A link leading somewhere is written through, as it always was.
    check(made(), 'printf seed > /tmp/out; cp file out; cat /tmp/out', 'src\n', at)
  })

  it('copies into the directory a link names, and over no link that is not one', () => {
    const sources = { file: 'src\n', 'd/inner': 'in\n', dirlink: { type: 'link', target: '/tmp/d' } }
    const made = () => createTerminal(sources, { mount: '/repo', writable: '/tmp/' })
    const at = { cwd: '/repo' }
    // A copy lands where the name leads, so what the overlay may hold is asked
    // of the walk rather than of the spelling.
    check(made(), 'mkdir /tmp/d; cp -r d dirlink; find /tmp', '/tmp\n/tmp/d\n/tmp/d/d\n/tmp/d/d/inner\n', at)
    check(made(), 'mkdir /tmp/d; cp -r d dirlink/sub; find /tmp', '/tmp\n/tmp/d\n/tmp/d/sub\n/tmp/d/sub/inner\n', at)
    check(made(), 'mkdir /tmp/d; cp -rv d dirlink', "'d' -> 'dirlink/d'\n'd/inner' -> 'dirlink/d/inner'\n", at)
    // A regular file can be written through a link and a directory cannot, so
    // GNU reads the destination of a directory copy as `lstat` reads it: `-T`
    // names the link itself, which is no directory to overwrite.
    check(made(), 'mkdir /tmp/d; cp -rT d dirlink', '', {
      stderr: "cp: cannot overwrite non-directory 'dirlink' with directory 'd'\n", exitCode: 1, ...at,
    })
  })

  it('makes no directory over a name a link holds, however far the link leads', () => {
    const sources = {
      file: 'x\n',
      dirlink: { type: 'link', target: '/tmp/d' },
      fresh: { type: 'link', target: '/tmp/new' },
      through: { type: 'link', target: '/repo/file/sub' },
    }
    const made = () => createTerminal(sources, { mount: '/repo', writable: '/tmp/' })
    const at = { cwd: '/repo' }
    const taken = (name) => `mkdir: cannot create directory '${name}': File exists\n`
    // The name is taken whatever the link leads to, which `mkdir` never
    // follows — `-p` follows it, and passes over a directory at the end of it.
    check(made(), 'mkdir fresh', '', { stderr: taken('fresh'), exitCode: 1, ...at })
    check(made(), 'mkdir -p fresh', '', { stderr: taken('fresh'), exitCode: 1, ...at })
    check(made(), 'mkdir -p through', '', { stderr: taken('through'), exitCode: 1, ...at })
    check(made(), 'mkdir /tmp/d; mkdir dirlink', '', { stderr: taken('dirlink'), exitCode: 1, ...at })
    check(made(), 'mkdir /tmp/d; mkdir -p dirlink', '', at)
    check(made(), 'mkdir /tmp/d; mkdir -p dirlink/sub; find /tmp -type d', '/tmp\n/tmp/d\n/tmp/d/sub\n', at)
    // Under `-p` a component that is not the last answers with what stopped
    // the walk: a link leading nowhere is its own name in the way, and one
    // leading through a file cannot hold the name below it.
    check(made(), 'mkdir -p fresh/sub', '', { stderr: taken('fresh'), exitCode: 1, ...at })
    check(made(), 'mkdir -p through/sub', '', {
      stderr: "mkdir: cannot create directory 'through': Not a directory\n", exitCode: 1, ...at,
    })
  })

  it('answers for the parent of the name a link leads to before the boundary answers', () => {
    const sources = {
      file: 'x\n',
      orphan: { type: 'link', target: '/repo/missing/file' },
      spelled: { type: 'link', target: '/repo/newname' },
      through: { type: 'link', target: '/repo/file/sub' },
    }
    const made = () => createTerminal(sources, { mount: '/repo', writable: '/tmp/' })
    const at = { cwd: '/repo' }
    // Resolution answers before the filesystem does, as it does for the name
    // written out in full: what is left for a name that resolves is the
    // read-only filesystem it lands on.
    check(made(), 'touch orphan', '', { stderr: "touch: cannot touch 'orphan': No such file or directory\n", exitCode: 1, ...at })
    check(made(), 'touch /repo/missing/file', '', {
      stderr: "touch: cannot touch '/repo/missing/file': No such file or directory\n", exitCode: 1, ...at,
    })
    check(made(), 'touch through', '', { stderr: "touch: cannot touch 'through': Not a directory\n", exitCode: 1, ...at })
    check(made(), 'touch spelled', '', { stderr: "touch: cannot touch 'spelled': Read-only file system\n", exitCode: 1, ...at })
  })

  it('leaves a link alone where -n has left its destination alone', () => {
    const sources = {
      file: 'x\n', 'e/f': 'e\n',
      'e/el': { type: 'link', target: 'f' },
      out: { type: 'link', target: '/tmp/out' },
    }
    const made = () => createTerminal(sources, { mount: '/repo', writable: '/tmp/' })
    const at = { cwd: '/repo' }
    const kept = 'mkdir -p /tmp/dest/e; printf kept > /tmp/dest/e/el; printf kept > /tmp/dest/e/f; '
    // `-n` answers from the destination before the source is opened, so a
    // name already there is left as it is and the copy neither fails nor
    // happens — the link it would have carried is never in question.
    check(made(), 'printf seed > /tmp/out; cp -rn out /tmp/out; cat /tmp/out', 'seed', at)
    check(made(), kept + 'cp -rn e /tmp/dest; cat /tmp/dest/e/el /tmp/dest/e/f', 'keptkept', at)
    check(made(), kept + 'cp -rn e/el /tmp/dest/e/el; cat /tmp/dest/e/el', 'kept', at)
    // A link the copy would reach is refused as ever, and before it writes.
    const refusal = 'cp: copying a symbolic link is not supported: e/el (a recursive copy keeps the link, and nothing here makes one)\n'
    gap(made(), 'cp -rn e /tmp/dest', 'symbolic link', refusal)
    const partial = made()
    partial.run('mkdir -p /tmp/dest/e; printf kept > /tmp/dest/e/f')
    gap(partial, 'cp -rn e /tmp/dest', 'symbolic link', refusal)
    check(partial, 'find /tmp -type f', '/tmp/dest/e/f\n', at)
  })

  it('patches through a link on the way, and patches no link itself', () => {
    const sources = { file: 'a\n', into: { type: 'link', target: '/tmp' }, out: { type: 'link', target: '/tmp/out' } }
    const made = () => {
      const t = createTerminal(sources, { mount: '/repo', writable: '/tmp/' })
      t.run("printf 'a\\n' > /tmp/out; printf -- '--- out\\n+++ out\\n@@ -1 +1 @@\\n-a\\n+b\\n' > /tmp/d.patch")
      return t
    }
    const at = { cwd: '/repo' }
    // The file a write lands on is the walk's answer, so a link on the way
    // leads where it leads — the overlay owns what is under it.
    check(made(), 'patch into/out < /tmp/d.patch; cat /tmp/out', 'patching file into/out\nb\n', at)
    // GNU patches a regular file and nothing else, and reads the name itself
    // to decide: a link is none, whatever it leads to. What is left is the
    // rejects, beside the link and so in the read-only sources.
    const refused = gap(made(), 'patch out < /tmp/d.patch', 'read-only target', 'patch: out.rej: file system is read-only\n')
    assert.equal(refused.stdout, 'File out is not a regular file -- refusing to patch\n1 out of 1 hunk ignored -- saving rejects to file out.rej\n')
    check(made(), 'cat /tmp/out', 'a\n', at)
  })

  it('sed guards the file it reads, which a link naming that file is', () => {
    const sources = { file: 'a\n', out: { type: 'link', target: '/tmp/out' } }
    const refusal = 'sed: writing to an actively read input file is not supported\n'
    // The guard is about the file rather than the name it was opened by, so
    // both spellings of one file answer alike.
    for (const name of ['/tmp/out', 'out']) {
      const t = createTerminal(sources, { mount: '/repo', writable: '/tmp/' })
      t.run("printf 'a\\n' > /tmp/out")
      gap(t, `sed 's/a/b/' ${name} >> /tmp/out`, 'streaming self-output', refusal)
      check(t, 'cat /tmp/out', 'a\n', { cwd: '/repo' })
    }
  })

  it('empties what a slashed link names and still cannot unlink the name', () => {
    const t = createTerminal({ dirlink: { type: 'link', target: '/tmp/d' } }, { mount: '/repo', writable: '/tmp/' })
    check(t, 'mkdir /tmp/d; printf x > /tmp/d/f', '', { cwd: '/repo' })
    // GNU walks into the directory the slash asked for, empties it, and then
    // fails the name itself, which is a link and not the directory it led to.
    check(t, 'rm -r dirlink/', '', { stderr: "rm: cannot remove 'dirlink/': Not a directory\n", exitCode: 1, cwd: '/repo' })
    check(t, 'find /tmp', '/tmp\n/tmp/d\n', { cwd: '/repo' })
  })

  it('watches the file a copy will write, where a link names the one it reports on', () => {
    const sources = { file: 'src\n', out: { type: 'link', target: '/tmp/out' } }
    const made = () => createTerminal(sources, { mount: '/repo', writable: '/tmp/' })
    // GNU buffers its verbose line, so a copy whose report shares the file it
    // writes is refused — by the name the copy lands on, link or not.
    const spelled = gap(made(), 'printf seed > /tmp/out; cp -v file /tmp/out > /tmp/out', 'copy output buffering', 'cp: buffered verbose output sharing a copied file is not supported\n')
    const linked = gap(made(), 'printf seed > /tmp/out; cp -v file out > /tmp/out', 'copy output buffering', 'cp: buffered verbose output sharing a copied file is not supported\n')
    assert.deepEqual(linked.stdout, spelled.stdout)
    check(made(), 'printf seed > /tmp/out; cp -v file out; cat /tmp/out', "'file' -> 'out'\nsrc\n", { cwd: '/repo' })
  })

  it('unlinks and replaces the name it was given, which a link in the sources is not', () => {
    const sources = {
      file: 'x\n',
      out: { type: 'link', target: '/tmp/out' },
      dirlink: { type: 'link', target: '/tmp/d' },
    }
    const made = () => createTerminal(sources, { mount: '/repo', writable: '/tmp/' })
    const at = { cwd: '/repo' }
    // `rm` takes the name away and `sed -i` writes a file over it, so both
    // answer for a name the sources hold — never for what it points at.
    check(made(), 'printf kept > /tmp/out; rm out; cat /tmp/out', 'kept', {
      stderr: "rm: cannot remove 'out': Read-only file system\n", cwd: '/repo',
    })
    gap(made(), 'printf seed > /tmp/out; sed -i s/seed/other/ out', '-i', 'sed: out: file system is read-only\n')
    // A link on the way to the name is followed all the same.
    check(made(), 'mkdir /tmp/d; printf a > /tmp/d/f; sed -i s/a/b/ dirlink/f; cat /tmp/d/f', 'b', at)
    check(made(), 'mkdir /tmp/d; printf a > /tmp/d/f; rm dirlink/f; find /tmp -type f', '', at)
  })

  it('realpath resolves every link on the way, and -s keeps the name as written', () => {
    const t = terminal()
    check(t, 'realpath pkg/index.js', '/node_modules/pkg/index.js\n')
    check(t, 'realpath node_modules/.bin/cli', '/node_modules/pkg/bin/cli.js\n')
    check(t, 'realpath -s node_modules/.bin/cli', '/node_modules/.bin/cli\n')
    // Only the last component may be missing: a link to a name in a directory
    // that is not there is the resolution failing before it.
    check(t, 'realpath node_modules/.bin/stale', '', {
      stderr: 'realpath: node_modules/.bin/stale: No such file or directory\n', exitCode: 1,
    })
    check(t, 'realpath -m node_modules/.bin/stale', '/node_modules/gone/cli.js\n')
    check(t, 'realpath -e pkg', '/node_modules/pkg\n')
    check(t, 'realpath --relative-to=. pkg/index.js', 'node_modules/pkg/index.js\n')
  })

  it('realpath takes `..` from the name as written under -L, and from what a link leads to under -P', () => {
    const t = terminal({ 'd/f': 'f\n', 'x/y/z': 'z\n', 'sub/l': { type: 'link', target: '../x/y' }, l: { type: 'link', target: 'd' } })
    // `-P`, the default, expands the link and takes `..` from where it leads.
    check(t, 'realpath sub/l/../z', '/x/z\n')
    check(t, 'realpath -P sub/l/../z', '/x/z\n')
    // `-L` cancels the component before a `..` — link or not — and resolves
    // what is left, so the link is never expanded at all.
    check(t, 'realpath -L sub/l/../z', '/sub/z\n')
    check(t, 'realpath -L l/f', '/d/f\n')
    // What a `..` passes over is still checked where the walk would check it.
    check(t, 'realpath -L nope/../l/f', '', { stderr: 'realpath: nope/../l/f: No such file or directory\n', exitCode: 1 })
    check(t, 'realpath -Lm nope/../l/f', '/d/f\n')
    // The last of `-L`, `-P` and `-s` on the line is the one that answers.
    check(t, 'realpath -sL l/f', '/d/f\n')
    check(t, 'realpath -Ls l/f', '/l/f\n')
  })

  it('realpath expands no link under -s, in the existence mode as well as the default', () => {
    const t = terminal({ 'd/f': 'f\n', l: { type: 'link', target: 'd' } })
    check(t, 'realpath -s l/f', '/l/f\n')
    check(t, 'realpath -s -e l/f', '/l/f\n')
    check(t, 'realpath -s -m l/nope', '/l/nope\n')
    check(t, 'realpath -s -m l/../z', '/z\n')
    // `-e` still asks the filesystem, which answers through the link.
    check(t, 'realpath -s -e l/nope', '', { stderr: 'realpath: l/nope: No such file or directory\n', exitCode: 1 })
  })

  it('realpath -s -e asks about the name it reduced to, not the spelling it came from', () => {
    const t = terminal({ 'x/z': 'z\n', 'x/y/f': 'y\n', l: { type: 'link', target: 'x/y' } })
    // `l/../z` is `z` where no link is expanded, and `z` is what has to be
    // there; the walk `-e` makes without `-s` asks about `x/z` instead.
    check(t, 'realpath -s l/../z', '/z\n')
    check(t, 'realpath -s -e l/../z', '', { stderr: 'realpath: l/../z: No such file or directory\n', exitCode: 1 })
    check(t, 'realpath -e l/../z', '/x/z\n')
    check(t, 'realpath -s -e l/f', '/l/f\n')
  })

  it('stat measures the link a redirect points through, and refuses only what -L would measure', () => {
    const sources = { file: 'content\n', link: { type: 'link', target: '/tmp/out' } }
    const t = createTerminal(sources, { mount: '/repo', writable: '/tmp/' })
    // The size is the link's own — the path it holds — so the file the output
    // is going to is nothing this measured, and GNU answers it too.
    check(t, 'printf seed > /tmp/out; stat -c %s link > /tmp/out; cat /tmp/out', '8\n', { cwd: '/repo' })
    // `-L` measures what the link points at, which is that same file.
    gap(t, 'stat -L -c %s link > /tmp/out', 'metadata output overlap', 'stat: buffered output sharing a measured file is not supported\n')
  })

  it('realpath keeps a path it cannot resolve where -m asked for one that need not be there', () => {
    const t = terminal({ self: { type: 'link', target: 'self' }, 'a.txt': 'x\n' })
    check(t, 'realpath self', '', { stderr: 'realpath: self: Too many levels of symbolic links\n', exitCode: 1 })
    check(t, 'realpath -m self/deeper', '/self/deeper\n')
    check(t, 'realpath -m a.txt/under', '/a.txt/under\n')
    // A name that is not there is kept as it was spelled and the walk goes
    // on, so a `..` after it cancels it and a link past it is expanded.
    check(t, 'realpath -m nope/../a.txt', '/a.txt\n')
  })

  it('hands a wired command the links a directory holds, and the target each one carries', () => {
    const t = createTerminal(SOURCES, {
      commands: {
        probe: ({ fs, args }) => JSON.stringify({
          listing: fs.listDir(args[0]),
          link: fs.isLink(args[1]),
          target: fs.readLink(args[1]),
          walked: fs.walkFiles(args[0]),
        }) + '\n',
      },
    })
    check(t, 'probe node_modules/.bin node_modules/.bin/cli', JSON.stringify({
      listing: { dirs: [], files: [], links: ['cli', 'stale'] },
      link: true,
      target: '../pkg/bin/cli.js',
      walked: [],
    }) + '\n')
  })

  it('carries the links of the sources through a writable overlay, which holds none of its own', () => {
    const t = createTerminal(SOURCES, { mount: '/repo', writable: '/tmp/' })
    check(t, 'find / -type l', '/repo/node_modules/.bin/cli\n/repo/node_modules/.bin/stale\n/repo/pkg\n', { cwd: '/repo' })
    check(t, 'printf x > /tmp/f; find /tmp -type l', '', { cwd: '/repo' })
    check(t, 'cat pkg/index.js > /tmp/copy; cat /tmp/copy', 'module\n', { cwd: '/repo' })
  })
})
