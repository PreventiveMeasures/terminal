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
  it('tree names the target beside the link and counts it among the files', () => {
    const t = terminal({ 'a/file': 'x\n', 'a/link': { type: 'link', target: 'file' } })
    check(t, 'tree', '.\n└── a\n    ├── file\n    └── link -> file\n\n2 directories, 2 files\n')
    gap(t, 'tree -F', '-F with a symbolic link', 'tree: -F over a symbolic link is not supported\n')
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
    check(t, 'cp -r a a', '', { stderr: "cp: cannot copy a directory, 'a', into itself, 'a/a'\n", exitCode: 1, cwd: '/repo' })
    check(t, 'cp -r a afile', '', { stderr: "cp: cannot overwrite non-directory 'afile' with directory 'a'\n", exitCode: 1, cwd: '/repo' })
    check(t, 'cp -r a /tmp/nodir/deep', '', { stderr: "cp: cannot create directory '/tmp/nodir/deep': No such file or directory\n", exitCode: 1, cwd: '/repo' })
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
