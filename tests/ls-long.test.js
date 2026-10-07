import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { describe, it, mock } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { pack } from '@preventive/archive/tar.js'

const HIDDEN_NOTE = 'ls: omitted 1 hidden entry: "/.hidden". Hidden entries are included with -a.'
const FILES = { 'README.md': 'hello world\n', 'src/app.js': 'x\n', 'src/lib/util.js': 'y\n', '.hidden': 'h\n', big: '0'.repeat(1500), empty: '' }
const MADE = Date.UTC(2026, 8, 18, 5, 52)
const HOUR = 3_600_000

// Every terminal here is made, and every line run, under a stopped clock, so
// the dates a listing prints are known. TZ=UTC keeps them off the host zone.
async function at(now, fn) {
  mock.timers.enable({ apis: ['Date'], now })
  try { return await fn() } finally { mock.timers.reset() }
}
const made = (sources = FILES, opts = {}, now = MADE) => at(now, async () => {
  const t = createTerminal(sources, opts)
  await t.run('TZ=UTC')
  return t
})
const run = (t, line, now = MADE) => at(now, () => t.run(line))
const expected = (stdout, notes = [], extra = {}) => ({ stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [], notes, ...extra })
const lines = (...rows) => rows.join('\n') + '\n'

describe('ls -l lists what the filesystem does not keep as this terminal’s defaults', () => {
  it('lists a directory with its total and one row per entry', async () => {
    assert.deepEqual(await run(await made(), 'ls -la'), expected(lines(
      'total 24',
      'drwx------ 3 user user 4096 Sep 18 05:52 .',
      'drwx------ 3 user user 4096 Sep 18 05:52 ..',
      '-rw------- 1 user user    2 Sep 18 05:52 .hidden',
      '-rw------- 1 user user   12 Sep 18 05:52 README.md',
      '-rw------- 1 user user 1500 Sep 18 05:52 big',
      '-rw------- 1 user user    0 Sep 18 05:52 empty',
      'drwx------ 3 user user 4096 Sep 18 05:52 src',
    )))
  })

  it('a file operand is one row and no total', async () => {
    assert.deepEqual(await run(await made(), 'ls -l README.md'), expected('-rw------- 1 user user 12 Sep 18 05:52 README.md\n'))
  })

  it('-d lists a directory operand itself, with two links plus one per subdirectory', async () => {
    assert.deepEqual(await run(await made(), 'ls -ld src src/lib'), expected(lines(
      'drwx------ 3 user user 4096 Sep 18 05:52 src',
      'drwx------ 2 user user 4096 Sep 18 05:52 src/lib',
    )))
  })

  it('-F classifies and -r reverses within the long form', async () => {
    assert.deepEqual(await run(await made(), 'ls -lrF src'), expected(lines(
      'total 8',
      'drwx------ 2 user user 4096 Sep 18 05:52 lib/',
      '-rw------- 1 user user    2 Sep 18 05:52 app.js',
    )))
  })

  it('-R heads each directory and totals it on its own', async () => {
    assert.deepEqual(await run(await made(), 'ls -lR src'), expected(lines(
      'src:',
      'total 8',
      '-rw------- 1 user user    2 Sep 18 05:52 app.js',
      'drwx------ 2 user user 4096 Sep 18 05:52 lib',
      '',
      'src/lib:',
      'total 4',
      '-rw------- 1 user user 2 Sep 18 05:52 util.js',
    )))
  })

  // GNU measures every operand before it sets the directories aside, so the
  // file rows are as wide as a directory's would be.
  it('files come first, then each directory under its name, and a missing operand still fails', async () => {
    assert.deepEqual(await run(await made(), 'ls -l README.md src missing'), expected(lines(
      '-rw------- 1 user user   12 Sep 18 05:52 README.md',
      '',
      'src:',
      'total 8',
      '-rw------- 1 user user    2 Sep 18 05:52 app.js',
      'drwx------ 2 user user 4096 Sep 18 05:52 lib',
    ), [], { stderr: "ls: cannot access 'missing': No such file or directory\n", exitCode: 2 }))
  })

  it('-h rounds sizes and the total as du -h does', async () => {
    assert.deepEqual(await run(await made(), 'ls -lh'), expected(lines(
      'total 12K',
      '-rw------- 1 user user   12 Sep 18 05:52 README.md',
      '-rw------- 1 user user 1.5K Sep 18 05:52 big',
      '-rw------- 1 user user    0 Sep 18 05:52 empty',
      'drwx------ 3 user user 4.0K Sep 18 05:52 src',
    ), [HIDDEN_NOTE]))
  })

  it('-h without -l changes nothing', async () => {
    assert.deepEqual(await run(await made(), 'ls -h'), expected('README.md\nbig\nempty\nsrc\n', [HIDDEN_NOTE]))
  })

  it('an empty directory is a total of nothing', async () => {
    const t = await made({}, { mount: '/repo', writable: '/tmp/' })
    assert.deepEqual(await run(t, 'ls -l /tmp'), expected('total 0\n', [], { cwd: '/repo' }))
  })

  it('a block size from the environment is refused rather than applied', async () => {
    const message = 'ls: BLOCK_SIZE is not supported in a long listing'
    assert.deepEqual(await run(await made(), 'BLOCK_SIZE=1 ls -l'), expected('', [], {
      stderr: message + '\n', exitCode: 1, unsupported: [{ kind: 'feature', command: 'ls', detail: 'block size environment', message }],
    }))
  })

})

// What an entry extracted from an archive keeps of its own — the mode it was
// stored with, less what GNU tar takes off as anyone but root under umask
// 077, and the time — is what its row says, until a write dates it to now.
describe('ls -l lists an entry that keeps a mode and a time of its own with them', () => {
  const STORED = Date.UTC(2024, 0, 2, 3, 4) / 1000
  const owner = { uid: 1000, gid: 50, uname: 'dev', gname: 'staff' }
  const ARCHIVE = pack([
    { name: 'pkg/', type: 'directory', mode: 0o755, mtime: STORED, ...owner },
    { name: 'pkg/run.sh', mode: 0o4755, mtime: STORED + 60, data: Buffer.from('echo\n'), ...owner },
    { name: 'pkg/notes', mode: 0o666, mtime: STORED + 120, data: Buffer.from('n\n'), ...owner },
    { name: 'pkg/link', type: 'symlink', mode: 0o777, mtime: STORED + 180, linkname: 'notes', ...owner },
  ])
  const extracted = async () => {
    const t = await made({ 'pkg.tar': ARCHIVE }, { mount: '/repo', writable: '/tmp/' })
    await run(t, 'cd /tmp && tar -xf /repo/pkg.tar')
    return t
  }

  it('gives each extracted entry its mode and time', async () => {
    const t = await extracted()
    assert.deepEqual(await run(t, 'ls -la pkg'), expected(lines(
      'total 16',
      'drwx------ 2 user user 4096 Jan  2  2024 .',
      'drwx------ 3 user user 4096 Sep 18 05:52 ..',
      'lrwxrwxrwx 1 user user    5 Jan  2  2024 link -> notes',
      '-rw------- 1 user user    2 Jan  2  2024 notes',
      '-rwx------ 1 user user    5 Jan  2  2024 run.sh',
    ), [], { cwd: '/tmp' }))
    // -F marks what a mode makes executable, beside a link and after it.
    assert.deepEqual(await run(t, 'ls -F pkg && ls -lF pkg/link'), expected('link@\nnotes\nrun.sh*\nlrwxrwxrwx 1 user user 5 Jan  2  2024 pkg/link -> notes\n', [], { cwd: '/tmp' }))
  })

  it('dates a file written to, and a directory a name is made in, to now', async () => {
    const t = await extracted()
    assert.deepEqual(await run(t, 'echo more >> pkg/notes && ls -l pkg/notes'), expected('-rw------- 1 user user 7 Sep 18 05:52 pkg/notes\n', [], { cwd: '/tmp' }))
    assert.deepEqual(await run(t, 'touch pkg/new && ls -ld pkg'), expected('drwx------ 2 user user 4096 Sep 18 05:52 pkg\n', [], { cwd: '/tmp' }))
    // A copy is a new file, made in the mode of what it copies.
    assert.deepEqual(await run(t, 'cp pkg/run.sh copy && ls -l copy'), expected('-rwx------ 1 user user 5 Sep 18 05:52 copy\n', [], { cwd: '/tmp' }))
  })

  it('refuses what a kept mode keeps its owner from, and rm asks before it', async () => {
    const t = await made({
      'ro.tar': pack([
        { name: 'ro/', type: 'directory', mode: 0o555, mtime: STORED, ...owner },
        { name: 'ro/f', mode: 0o444, mtime: STORED, data: Buffer.from('f\n'), ...owner },
        { name: 'w', mode: 0o444, mtime: STORED, data: Buffer.from(''), ...owner },
        { name: 'hidden', mode: 0o200, mtime: STORED, data: Buffer.from('h\n'), ...owner },
      ]),
    }, { mount: '/repo', writable: '/tmp/' })
    await run(t, 'cd /tmp && tar -xf /repo/ro.tar')
    // GNU is told "Permission denied", each command in its own words.
    const refused = async (line, path, doing) => {
      const r = await run(t, line)
      assert.deepEqual(r.unsupported.map((u) => u.detail), ['permission denied'], line)
      assert.match(r.stderr, new RegExp(`${path}: ${doing} where its mode denies it is not supported \\(GNU says Permission denied\\)\n$`, 'u'), line)
      assert.notEqual(r.exitCode, 0, line)
    }
    await refused('echo x >> w', '/tmp/w', 'writing a file')
    await refused('touch ro/new', '/tmp/ro', 'changing the names in a directory')
    await refused('rm -f ro/f', '/tmp/ro', 'changing the names in a directory')
    await refused('cat hidden', '/tmp/hidden', 'reading a file')
    // rm asks first where stdin is the terminal, whose end answers no; it
    // asks nothing of a stdin that is not one, nor under -f.
    assert.deepEqual(await run(t, 'rm w ro; echo $?'), expected('1\n', [], { cwd: '/tmp', stderr: "rm: remove write-protected regular empty file 'w'? rm: cannot remove 'ro': Is a directory\n" }))
    assert.deepEqual(await run(t, 'rm -r ro; echo $?'), expected('0\n', [], { cwd: '/tmp', stderr: "rm: descend into write-protected directory 'ro'? " }))
    assert.deepEqual(await run(t, 'rm w < /dev/null && ls w'), expected('', [], { cwd: '/tmp', stderr: "ls: cannot access 'w': No such file or directory\n", exitCode: 2 }))
  })
})

describe('ls -l ownership and time', () => {
  it('the owner and the group are the session user', async () => {
    assert.equal((await run(await made(FILES, { user: 'ann' }), 'ls -l README.md')).stdout, '-rw------- 1 ann ann 12 Sep 18 05:52 README.md\n')
  })

  it('a fork under another name owns what it lists', async () => {
    const child = (await made(FILES, { user: 'ann' })).fork({ inherit: false, user: 'ada' })
    await run(child, 'TZ=UTC')
    assert.equal((await run(child, 'ls -l README.md')).stdout, '-rw------- 1 ada ada 12 Sep 18 05:52 README.md\n')
  })

  it('dates every entry to when the terminal was created, however much later it lists', async () => {
    const t = await made()
    assert.equal((await run(t, 'ls -l README.md', MADE + 5 * HOUR)).stdout, '-rw------- 1 user user 12 Sep 18 05:52 README.md\n')
    assert.equal((await run(await made(FILES, {}, MADE + 5 * HOUR), 'ls -l README.md', MADE + 5 * HOUR)).stdout, '-rw------- 1 user user 12 Sep 18 10:52 README.md\n')
  })

  it('a fork keeps the creation time of the terminal it came from', async () => {
    const parent = await made()
    const later = MADE + 3 * HOUR
    const child = await at(later, () => parent.fork())
    assert.equal((await run(child, 'ls -l README.md', later)).stdout, '-rw------- 1 user user 12 Sep 18 05:52 README.md\n')
    const grandchild = await at(later + HOUR, () => child.fork({ inherit: false }))
    await run(grandchild, 'TZ=UTC')
    assert.equal((await run(grandchild, 'ls -l README.md', later + HOUR)).stdout, '-rw------- 1 user user 12 Sep 18 05:52 README.md\n')
  })

  it('a listing more than six months on gives the year in place of the time, as ls does', async () => {
    const t = await made()
    assert.equal((await run(t, 'ls -l README.md', MADE + 180 * 24 * HOUR)).stdout, '-rw------- 1 user user 12 Sep 18 05:52 README.md\n')
    assert.equal((await run(t, 'ls -l README.md', MADE + 190 * 24 * HOUR)).stdout, '-rw------- 1 user user 12 Sep 18  2026 README.md\n')
  })

  it('reads the clock the way date does: host time unless TZ is set', () => {
    at(MADE, async () => {
      const t = createTerminal(FILES)
      const stamp = (await t.run("date '+%b %e %H:%M'")).stdout.trim()
      assert.equal((await t.run('ls -l README.md')).stdout, `-rw------- 1 user user 12 ${stamp} README.md\n`)
      assert.equal((await t.run("TZ=UTC; ls -l README.md")).stdout, '-rw------- 1 user user 12 Sep 18 05:52 README.md\n')
    })
  })
})
