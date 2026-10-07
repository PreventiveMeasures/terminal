import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { TREES } from './fixtures/conformance/trees.js'

// What the corpus cannot say: that the diagnostic feed carries every
// refusal, and that the shell around diff -- redirection, standard input,
// exit status, xargs and find -- carries it the way it carries any command.
//
// That GNU's change set renders to GNU's bytes is @preventive/diff's own
// claim, checked there against these very recordings; the corpus in
// fixtures/conformance/diff.tests is what checks the command end to end.

const run = (line, files = TREES.pair, opts = {}) => createTerminal(files, opts).run(line)

describe('diff refuses what it does not do, on the feed', () => {
  for (const [line, detail] of [
    ['diff -y ten ten2', '-y'], ['diff --side-by-side ten ten2', '--side-by-side'], ['diff -e ten ten2', '-e'], ['diff -n ten ten2', '-n'],
    ['diff -B ten ten2', '-B'], ['diff -I x ten ten2', '-I'], ['diff -D SYM ten ten2', '-D'], ['diff -t ten ten2', '-t'], ['diff -T ten ten2', '-T'],
    ['diff -W 80 ten ten2', '-W'], ['diff --color=never ten ten2', '--color'], ['diff --color ten ten2', '--color'], ['diff -F ^int ten ten2', '-F'],
    ['diff --from-file=ten ten2', '--from-file'], ['diff -X list ten ten2', '-X'], ['diff -S start ten ten2', '-S'], ['diff -v', '-v'], ['diff --help', '--help'],
    ['diff --bogus ten ten2', '--bogus'], ['diff -Q ten ten2', '-Q'], ['diff --ignore-blank-lines ten ten2', '--ignore-blank-lines'], ['diff -P ten ten2', '-P'],
  ]) {
    it(line, async () => {
      const r = await run(line + ' 2>/dev/null || true')
      assert.deepEqual(r.unsupported.map((u) => [u.kind, u.command, u.detail]), [['option', 'diff', detail]], line)
      assert.equal((await run(line)).exitCode, 2, line)
      assert.notEqual((await run(line)).stderr, '', line)
    })
  }
  it('says nothing on the feed for ordinary trouble', async () => {
    const r = await run('diff nope ten')
    assert.deepEqual(r.unsupported, [])
    assert.equal(r.exitCode, 2)
    assert.equal(r.stderr, 'diff: nope: No such file or directory\n')
  })
  it('notes a relative operand that exists elsewhere', async () => {
    const t = createTerminal({ 'a/x': '1\n', x: '2\n' }, { cwd: '/a' })
    const r = await t.run('diff x ../x')
    assert.equal(r.exitCode, 1)
    const missing = await t.run('diff y x')
    assert.deepEqual(missing.notes, [])
    assert.deepEqual((await createTerminal({ 'a/x': '1\n', y: '2\n' }, { cwd: '/a' }).run('diff y x')).notes, ['diff: relative path "y" was not found from cwd "/a". A file exists at "/y".'])
  })
})

describe('diff through the shell', () => {
  it('reads standard input for - and consumes it', async () => {
    assert.deepEqual((await run("printf 'x\\n' | { diff - a1; cat; }")).stdout, '1c1\n< x\n---\n> a\n')
    assert.equal((await run("printf 'x\\n' | diff -u a1 - | head -2 | cut -f1")).stdout, '--- a1\n+++ -\n')
  })
  it('exit status gates a chain and is noted when it cancels one', async () => {
    const r = await run('diff ten ten2 > /dev/null && echo same')
    assert.equal(r.stdout, '')
    assert.deepEqual(r.notes, ['diff: exited 1, so the command after && did not run.'])
    assert.equal((await run('diff ten ten && echo same')).stdout, 'same\n')
  })
  it('dispatches through xargs and find with the usual status', async () => {
    assert.equal((await run('echo ten ten2 | xargs diff')).exitCode, 123)
    assert.equal((await run('echo ten ten2 | xargs diff')).stdout, '3c3\n< c\n---\n> X\n9c9\n< i\n---\n> Y\n')
    assert.equal((await run("find . -name ten -exec diff {} ten2 ';'")).stdout, '3c3\n< c\n---\n> X\n9c9\n< i\n---\n> Y\n')
  })
  it('a directory pair given twice is nothing to compare', async () => {
    assert.deepEqual((await run('diff -rs d1 d1; echo $?', TREES.dirs)).stdout, '0\n')
    assert.deepEqual((await run('diff -rs d1/sub ./d1/sub; echo $?', TREES.dirs)).stdout, '0\n')
  })
  it('quotes a name in a header only when it needs it', async () => {
    const t = createTerminal({ 'ünï': 'v\n', a1: 'a\n' })
    assert.equal((await t.run('diff -u ünï a1 | head -1 | cut -f1')).stdout, '--- ünï\n')
    // The C locale, where the name would be octal, is refused before diff runs.
    const refused = await t.run('LC_ALL=C diff -u ünï a1 | head -1')
    assert.deepEqual([refused.stdout, refused.unsupported.map((u) => u.detail)], ['', ['LC_ALL']])
    assert.equal((await t.run("diff -u 'sp ace' a1 2>&1 | head -1", TREES.pair)).stdout, 'diff: sp ace: No such file or directory\n')
  })
})

// Headers are dated the way GNU dates them, by a time the model keeps: the
// moment the terminal was made, for every file it holds. The clock is
// stopped so the time is known, and TZ=UTC keeps it off the host zone.
const MADE = Date.UTC(2026, 8, 18, 5, 52, 0, 250)
async function at(now, fn) {
  mock.timers.enable({ apis: ['Date'], now })
  try { return await fn() } finally { mock.timers.reset() }
}
const dated = (line, files = TREES.pair) => at(MADE, async () => {
  const t = createTerminal(files)
  await t.run('TZ=UTC')
  return t.run(line)
})

describe('diff dates its headers', () => {
  const stamp = '2026-09-18 05:52:00.250000000 +0000'
  it('by the time the terminal was made, to the nanosecond GNU prints', async () => {
    assert.equal((await dated('diff -u a1 x1 | head -2')).stdout, `--- a1\t${stamp}\n+++ x1\t${stamp}\n`)
    assert.equal((await dated('diff -c a1 x1 | head -2')).stdout, `*** a1\t${stamp}\n--- x1\t${stamp}\n`)
  })
  it('the ctime way in a context diff only where LC_TIME is C', async () => {
    assert.equal((await dated('LC_TIME=C diff -c a1 x1 | head -1')).stdout, '*** a1\tFri Sep 18 05:52:00 2026\n')
    assert.equal((await dated('LC_TIME=C diff -u a1 x1 | head -1')).stdout, `--- a1\t${stamp}\n`)
  })
  it('standard input by the time it is read, and a missing file by the epoch', async () => {
    assert.equal((await dated("printf 'x\\n' | diff -u - a1 | head -1")).stdout, `--- -\t${stamp}\n`)
    assert.equal((await dated('diff -Nc nope a1 | head -1')).stdout, '*** nope\t1970-01-01 00:00:00.000000000 +0000\n')
  })
})

describe('diff reads /dev/null as the empty file it is', () => {
  it('in the formats that print no header', async () => {
    assert.deepEqual([(await run('diff /dev/null x1')).stdout, (await run('diff /dev/null x1')).exitCode], ['0a1\n> x\n', 1])
    assert.equal((await run('diff -u -L a -L b x1 /dev/null')).stdout, '--- a\n+++ b\n@@ -1 +0,0 @@\n-x\n')
  })
  it('and refuses, on the feed, a header that would print its time', async () => {
    const r = await run('diff -u /dev/null x1')
    assert.deepEqual([r.stdout, r.exitCode, r.unsupported.map((u) => u.detail)], ['', 2, ['header time']])
    assert.match(r.stderr, /^diff: \/dev\/null: a header dated by the modification time of \/dev\/null is not supported/u)
  })
})

describe('diff looks for a NUL where GNU does', () => {
  it('in the first 4096 bytes, and nowhere past them', async () => {
    const files = { n1: 'x'.repeat(4100) + '\0a\n', n2: 'x'.repeat(4100) + '\0b\n', n3: 'x'.repeat(4000) + '\0b\n' }
    assert.equal((await run('diff n1 n2 | wc -l', files)).stdout, '4\n')
    assert.equal((await run('diff n1 n3', files)).stdout, 'Binary files n1 and n3 differ\n')
  })
})
