import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { TREES } from './fixtures/conformance/trees.js'

// The corpus holds what GNU patch prints; this holds what the corpus cannot:
// the feed, the overlay, and the round trip from diff to patch and back.

async function overlay(files = TREES.patchable) {
  const t = createTerminal(files, { mount: '/src', cwd: '/src', writable: '/tmp/' })
  for (const name of Object.keys(files)) assert.equal((await t.run(`cp '${name}' '/tmp/${name}'`)).exitCode, 0, name)
  await t.run('cd /tmp')
  return t
}
const feed = (r) => r.unsupported.map((u) => [u.kind, u.command, u.detail])

describe('patch refuses on the feed what it cannot do', () => {
  it('writing anywhere but the overlay', async () => {
    const t = createTerminal(TREES.patchable)
    const r = await t.run('diff -u ten ten2 > /dev/null; diff -u ten ten2 | patch ten')
    assert.deepEqual(feed(r), [['feature', 'patch', 'read-only target']])
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, 'patch: ten: file system is read-only\n')
    assert.equal(r.exitCode, 2)
    assert.equal((await t.run('cat ten')).stdout, TREES.patchable.ten, 'the file is untouched')
  })
  it('writing anywhere but the overlay, with an overlay elsewhere', async () => {
    const t = createTerminal(TREES.patchable, { mount: '/src', cwd: '/src', writable: '/tmp/' })
    const r = await t.run('diff -u ten ten2 | patch 2>/dev/null')
    assert.deepEqual(feed(r), [['feature', 'patch', 'read-only target']])
    assert.equal((await t.run('diff -u ten ten2 | patch -o /tmp/out; cat /tmp/out')).stdout, 'patching file /tmp/out (read from ten)\n' + TREES.patchable.ten2)
  })
  it('but checks and prints without writing anywhere', async () => {
    const t = createTerminal(TREES.patchable)
    assert.deepEqual((await t.run('diff -u ten ten2 | patch --dry-run')).stdout, 'checking file ten\n')
    const out = await t.run('diff -u ten ten2 | patch -o - ten')
    assert.deepEqual([out.stdout, out.stderr, out.exitCode, out.unsupported], [TREES.patchable.ten2, 'patching file - (read from ten)\n', 0, []])
  })
  for (const [line, detail] of [
    ["printf '3c\\nX\\n.\\n' | patch ten", 'ed script'], ["printf '3c\\nX\\n.\\n' | patch -e ten", '-e'],
    ["printf 'Prereq: 1.0\\n--- ten\\n+++ ten\\n@@ -1 +1 @@\\n-a\\n+A\\n' | patch --dry-run", 'Prereq'],
    ["printf 'diff --git a/x b/x\\nindex 1234567..89abcde 100644\\nGIT binary patch\\nliteral 5\\n' | patch -p1 --dry-run", 'git binary patch'],
    ["printf -- '--- ten\\r\\n+++ ten\\r\\n@@ -1 +1 @@\\r\\n-a\\r\\n+A\\r\\n' | patch --dry-run", 'CRLF patch'],
    ["printf -- ' --- ten\\n +++ ten\\n @@ -1 +1 @@\\n -a\\n +A\\n' | patch --dry-run", 'indented patch'],
    ['patch --verbose ten < ten2', '--verbose'], ['patch -T ten < ten2', '-T'], ['patch --merge ten < ten2', '--merge'], ['patch -B old/ ten < ten2', '-B'], ['patch --bogus < ten2', '--bogus'],
  ]) {
    it(line, async () => {
      const r = await createTerminal(TREES.patchable).run(line)
      assert.equal(r.unsupported.length, 1, line)
      assert.equal(r.unsupported[0].detail, detail, line)
      assert.equal(r.unsupported[0].command, 'patch', line)
      assert.ok(r.stderr.includes(r.unsupported[0].message), line)
      assert.equal(r.exitCode, 2, line)
      assert.deepEqual(feed(await createTerminal(TREES.patchable).run(line + ' 2>/dev/null | cat')), [['option', 'patch', detail]].map(([, c, d]) => [r.unsupported[0].kind, c, d]), line)
    })
  }
  it('keeps what it said before refusing', async () => {
    const t = await overlay()
    const r = await t.run("printf -- '--- ten\\n+++ ten\\n@@ -1 +1 @@\\n-a\\n+A\\n--- x\\n+++ x\\n@@ -1 +1 @@\\r\\n-a\\r\\n+A\\r\\n' | patch")
    assert.equal(r.stdout, 'patching file ten\n')
    assert.deepEqual(feed(r), [['feature', 'patch', 'CRLF patch']])
    assert.equal((await t.run('head -1 ten')).stdout, 'A\n', 'the first file was written before the refusal')
  })
})

describe('what diff writes, patch applies, in every style', () => {
  const styles = ['', '-u', '-c', '-U0', '-U1', '-C1']
  const pairs = [['ten', 'ten2'], ['big', 'big2'], ['ne1', 'ne2'], ['ne1', 'ne3'], ['ne2', 'ne1'], ['emp', 'ten'], ['ten', 'emp'], ['wf', 'wfz'], ['blank', 'ten']]
  for (const style of styles) {
    for (const [from, to] of pairs) {
      it(`diff ${style} ${from} ${to} | patch, and back with -R`, async () => {
        const t = await overlay()
        const forward = await t.run(`diff ${style} ${from} ${to} > p; cp ${from} work; patch work < p`)
        assert.equal(forward.exitCode, 0, forward.stdout + forward.stderr)
        assert.equal((await t.run('cat work')).stdout, TREES.patchable[to])
        const back = await t.run('patch -R work < p')
        assert.equal(back.exitCode, 0, back.stdout + back.stderr)
        assert.equal((await t.run('cat work')).stdout, TREES.patchable[from])
        assert.equal((await t.run('test -e work.rej || test -e work.orig || echo neither')).stdout, 'neither\n', 'a clean application makes no backup and no reject')
      })
    }
  }
  it('finds hunks that moved, and says so', async () => {
    const t = await overlay()
    const r = await t.run("diff -u big big2 > p; printf 'top\\nnext\\n' > work; cat big >> work; patch work < p")
    assert.equal(r.stdout, 'patching file work\nHunk #1 succeeded at 4 (offset 2 lines).\nHunk #2 succeeded at 20 (offset 2 lines).\n')
    assert.equal((await t.run('cat work')).stdout, 'top\nnext\n' + TREES.patchable.big2)
    assert.equal((await t.run('ls work.orig')).stdout, 'work.orig\n', 'a mismatch keeps a backup')
  })
  it('applies a run of patches to one file in order', async () => {
    const t = await overlay()
    assert.equal((await t.run("diff -u ten ten2 > p1; sed 's/^d$/D/' ten2 > ten3; diff -u -L ten -L ten ten2 ten3 > p2; cat p1 p2 | patch; cat ten")).stdout, 'patching file ten\npatching file ten\na\nb\nX\nD\ne\nf\ng\nh\nY\nj\n')
  })
  it('appends rejects from a second patch to the same file', async () => {
    const t = await overlay()
    const r = await t.run("printf -- '--- ten\\n+++ ten\\n@@ -1 +1 @@\\n-q\\n+Q\\n--- ten\\n+++ ten\\n@@ -2 +2 @@\\n-r\\n+R\\n' | patch; cat ten.rej")
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'patching file ten\nHunk #1 FAILED at 1.\n1 out of 1 hunk FAILED -- saving rejects to file ten.rej\npatching file ten\nHunk #1 FAILED at 2.\n1 out of 1 hunk FAILED -- saving rejects to file ten.rej\n--- ten\n+++ ten\n@@ -1 +1 @@\n-q\n+Q\n--- ten\n+++ ten\n@@ -2 +2 @@\n-r\n+R\n')
  })
  it('-d applies inside another directory', async () => {
    const t = createTerminal({ 'sub/ten': TREES.patchable.ten, ten2: TREES.patchable.ten2, ten: TREES.patchable.ten }, { mount: '/src', cwd: '/src', writable: '/tmp/' })
    assert.equal((await t.run('cp ten /tmp/ten; diff -u ten ten2 > /tmp/p; cd /; patch -d /tmp < /tmp/p; cat /tmp/ten')).stdout, 'patching file ten\n' + TREES.patchable.ten2)
    assert.equal((await t.run('patch -d /nowhere < /tmp/p')).stderr, "patch: **** Can't change to directory /nowhere : No such file or directory\n")
  })
})
