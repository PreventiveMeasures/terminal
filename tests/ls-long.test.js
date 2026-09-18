import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const NOTE = "ls: permissions, ownership and times in a long listing are this terminal's defaults: every entry is the session user's alone, and dated to when the terminal was created."
const HIDDEN_NOTE = 'ls: omitted 1 hidden entry: "/.hidden". Hidden entries are included with -a.'
const FILES = { 'README.md': 'hello world\n', 'src/app.js': 'x\n', 'src/lib/util.js': 'y\n', '.hidden': 'h\n', big: '0'.repeat(1500), empty: '' }
const MADE = Date.UTC(2026, 8, 18, 5, 52)
const HOUR = 3_600_000

// Every terminal here is made, and every line run, under a stopped clock, so
// the dates a listing prints are known. TZ=UTC keeps them off the host zone.
function at(now, fn) {
  mock.timers.enable({ apis: ['Date'], now })
  try { return fn() } finally { mock.timers.reset() }
}
const made = (sources = FILES, opts = {}, now = MADE) => at(now, () => {
  const t = createTerminal(sources, opts)
  t.run('TZ=UTC')
  return t
})
const run = (t, line, now = MADE) => at(now, () => t.run(line))
const expected = (stdout, notes = [NOTE], extra = {}) => ({ stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [], notes, ...extra })
const lines = (...rows) => rows.join('\n') + '\n'

describe('ls -l lists what the filesystem does not keep as this terminal’s defaults', () => {
  it('lists a directory with its total, one row per entry, and says the fields are defaults', () => {
    assert.deepEqual(run(made(), 'ls -la'), expected(lines(
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

  it('a file operand is one row and no total', () => {
    assert.deepEqual(run(made(), 'ls -l README.md'), expected('-rw------- 1 user user 12 Sep 18 05:52 README.md\n'))
  })

  it('-d lists a directory operand itself, with two links plus one per subdirectory', () => {
    assert.deepEqual(run(made(), 'ls -ld src src/lib'), expected(lines(
      'drwx------ 3 user user 4096 Sep 18 05:52 src',
      'drwx------ 2 user user 4096 Sep 18 05:52 src/lib',
    )))
  })

  it('-F classifies and -r reverses within the long form', () => {
    assert.deepEqual(run(made(), 'ls -lrF src'), expected(lines(
      'total 8',
      'drwx------ 2 user user 4096 Sep 18 05:52 lib/',
      '-rw------- 1 user user    2 Sep 18 05:52 app.js',
    )))
  })

  it('-R heads each directory and totals it on its own', () => {
    assert.deepEqual(run(made(), 'ls -lR src'), expected(lines(
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

  it('files come first, then each directory under its name, and a missing operand still fails', () => {
    assert.deepEqual(run(made(), 'ls -l README.md src missing'), expected(lines(
      '-rw------- 1 user user 12 Sep 18 05:52 README.md',
      '',
      'src:',
      'total 8',
      '-rw------- 1 user user    2 Sep 18 05:52 app.js',
      'drwx------ 2 user user 4096 Sep 18 05:52 lib',
    ), [NOTE], { stderr: "ls: cannot access 'missing': No such file or directory\n", exitCode: 2 }))
  })

  it('-h rounds sizes and the total as du -h does', () => {
    assert.deepEqual(run(made(), 'ls -lh'), expected(lines(
      'total 12K',
      '-rw------- 1 user user   12 Sep 18 05:52 README.md',
      '-rw------- 1 user user 1.5K Sep 18 05:52 big',
      '-rw------- 1 user user    0 Sep 18 05:52 empty',
      'drwx------ 3 user user 4.0K Sep 18 05:52 src',
    ), [HIDDEN_NOTE, NOTE]))
  })

  it('-h without -l changes nothing', () => {
    assert.deepEqual(run(made(), 'ls -h'), expected('README.md\nbig\nempty\nsrc\n', [HIDDEN_NOTE]))
  })

  it('an empty directory is a total of nothing', () => {
    const t = made({}, { mount: '/repo', writable: '/tmp/' })
    assert.deepEqual(run(t, 'ls -l /tmp'), expected('total 0\n', [NOTE], { cwd: '/repo' }))
  })

  it('a block size from the environment is refused rather than applied', () => {
    const message = 'ls: BLOCK_SIZE is not supported in a long listing'
    assert.deepEqual(run(made(), 'BLOCK_SIZE=1 ls -l'), expected('', [], {
      stderr: message + '\n', exitCode: 1, unsupported: [{ kind: 'feature', command: 'ls', detail: 'block size environment', message }],
    }))
  })

  it('a listing that printed nothing carries no note', () => {
    assert.deepEqual(run(made(), 'ls -l missing'), expected('', [], { stderr: "ls: cannot access 'missing': No such file or directory\n", exitCode: 2 }))
  })
})

describe('ls -l ownership and time', () => {
  it('the owner and the group are the session user', () => {
    assert.equal(run(made(FILES, { user: 'ann' }), 'ls -l README.md').stdout, '-rw------- 1 ann ann 12 Sep 18 05:52 README.md\n')
  })

  it('a fork under another name owns what it lists', () => {
    const child = made(FILES, { user: 'ann' }).fork({ inherit: false, user: 'ada' })
    run(child, 'TZ=UTC')
    assert.equal(run(child, 'ls -l README.md').stdout, '-rw------- 1 ada ada 12 Sep 18 05:52 README.md\n')
  })

  it('dates every entry to when the terminal was created, however much later it lists', () => {
    const t = made()
    assert.equal(run(t, 'ls -l README.md', MADE + 5 * HOUR).stdout, '-rw------- 1 user user 12 Sep 18 05:52 README.md\n')
    assert.equal(run(made(FILES, {}, MADE + 5 * HOUR), 'ls -l README.md', MADE + 5 * HOUR).stdout, '-rw------- 1 user user 12 Sep 18 10:52 README.md\n')
  })

  it('a fork keeps the creation time of the terminal it came from', () => {
    const parent = made()
    const later = MADE + 3 * HOUR
    const child = at(later, () => parent.fork())
    assert.equal(run(child, 'ls -l README.md', later).stdout, '-rw------- 1 user user 12 Sep 18 05:52 README.md\n')
    const grandchild = at(later + HOUR, () => child.fork({ inherit: false }))
    run(grandchild, 'TZ=UTC')
    assert.equal(run(grandchild, 'ls -l README.md', later + HOUR).stdout, '-rw------- 1 user user 12 Sep 18 05:52 README.md\n')
  })

  it('a listing more than six months on gives the year in place of the time, as ls does', () => {
    const t = made()
    assert.equal(run(t, 'ls -l README.md', MADE + 180 * 24 * HOUR).stdout, '-rw------- 1 user user 12 Sep 18 05:52 README.md\n')
    assert.equal(run(t, 'ls -l README.md', MADE + 190 * 24 * HOUR).stdout, '-rw------- 1 user user 12 Sep 18  2026 README.md\n')
  })

  it('reads the clock the way date does: host time unless TZ is set', () => {
    at(MADE, () => {
      const t = createTerminal(FILES)
      const stamp = t.run("date '+%b %e %H:%M'").stdout.trim()
      assert.equal(t.run('ls -l README.md').stdout, `-rw------- 1 user user 12 ${stamp} README.md\n`)
      assert.equal(t.run("TZ=UTC; ls -l README.md").stdout, '-rw------- 1 user user 12 Sep 18 05:52 README.md\n')
    })
  })
})
