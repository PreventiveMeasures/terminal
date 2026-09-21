import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Checked against GNU coreutils 9.4: depth first, a directory announced as a
// directory, and the two names it refuses outright. The overlay's own root is
// this filesystem's answer of its own — a mount point is not the tree below it.
const SOURCES = { 'd/one': '1\n', 'd/sub/two': '2\n', file: 'f\n' }

async function terminal(options = {}) {
  const t = createTerminal(SOURCES, { mount: '/repo', cwd: '/repo', writable: '/tmp/', ...options })
  if ((await t.run('cp -r d /tmp/d')).exitCode === 0) await t.run('printf f >/tmp/file')
  return t
}

async function check(t, command, stdout = '', stderr = '', exitCode = 0, cwd = '/repo') {
  assert.deepEqual(await t.run(command), { stdout, stderr, exitCode, cwd, notes: [], unsupported: [] }, command)
}

describe('rm -r removes a tree', () => {
  for (const option of ['-r', '-R', '--recursive']) {
    it(`${option} removes the files and the directories below the name`, async () => {
      const t = await terminal()
      await check(t, `rm ${option} /tmp/d`)
      await check(t, 'find /tmp', '/tmp\n/tmp/file\n')
    })
  }

  it('empties a directory before removing it, and says which is which', async () => {
    const t = await terminal()
    await check(t, 'rm -rv /tmp/d', "removed '/tmp/d/one'\nremoved '/tmp/d/sub/two'\nremoved directory '/tmp/d/sub'\nremoved directory '/tmp/d'\n")
  })

  it('removes a file, as rm does without -r', async () => {
    const t = await terminal()
    await check(t, 'rm -rv /tmp/file', "removed '/tmp/file'\n")
    await check(t, 'find /tmp -type f', '/tmp/d/one\n/tmp/d/sub/two\n')
  })

  it('removes an empty directory', async () => {
    const t = await terminal()
    await check(t, 'mkdir -p /tmp/empty/inner')
    await check(t, 'rm -rv /tmp/empty', "removed directory '/tmp/empty/inner'\nremoved directory '/tmp/empty'\n")
    await check(t, 'test -e /tmp/empty', '', '', 1)
  })

  it('removes a subtree and leaves the rest of it', async () => {
    const t = await terminal()
    await check(t, 'rm -r /tmp/d/sub')
    await check(t, 'find /tmp/d', '/tmp/d\n/tmp/d/one\n')
  })

  it('removes a name that can then be made again', async () => {
    const t = await terminal()
    await check(t, 'rm -r /tmp/d')
    await check(t, 'mkdir /tmp/d; touch /tmp/d/new; find /tmp/d', '/tmp/d\n/tmp/d/new\n')
  })

  it('removes what it was pointed at from where it stands', async () => {
    const t = await terminal()
    await check(t, 'cd /tmp; rm -rv d/sub', "removed 'd/sub/two'\nremoved directory 'd/sub'\n", '', 0, '/tmp')
  })

  it('reports an operand whose own name the walk took away, and keeps going', async () => {
    const t = await terminal()
    // `sub` is removed before `d` is reached, and `d`'s name goes through it,
    // so the name no longer resolves — which is where GNU fails too. The
    // operand after it still runs.
    const result = await t.run('rm -rv /tmp/d/sub/../../d /tmp/file')
    assert.equal(result.stdout, "removed '/tmp/d/sub/../../d/one'\nremoved '/tmp/d/sub/../../d/sub/two'\nremoved directory '/tmp/d/sub/../../d/sub'\nremoved '/tmp/file'\n")
    assert.equal(result.stderr, "rm: cannot remove '/tmp/d/sub/../../d': No such file or directory\n")
    assert.equal(result.exitCode, 1)
    await check(t, 'find /tmp', '/tmp\n/tmp/d\n')
  })

  it('passes over what is not there under -f', async () => {
    const t = await terminal()
    await check(t, 'rm -rf /tmp/missing')
    await check(t, 'rm -r /tmp/missing', '', "rm: cannot remove '/tmp/missing': No such file or directory\n", 1)
  })
})

describe('rm -r refuses the overlay root and the names that are not one', () => {
  it('will not remove /tmp itself, or empty it in the attempt', async () => {
    const t = await terminal()
    await check(t, 'rm -r /tmp', '', "rm: cannot remove '/tmp': Device or resource busy\n", 1)
    await check(t, 'rm -rf /tmp', '', "rm: cannot remove '/tmp': Device or resource busy\n", 1)
    await check(t, 'cd /tmp; rm -r .', '', "rm: refusing to remove '.' or '..' directory: skipping '.'\n", 1, '/tmp')
    await check(t, 'find /tmp', '/tmp\n/tmp/d\n/tmp/d/one\n/tmp/d/sub\n/tmp/d/sub/two\n/tmp/file\n', '', 0, '/tmp')
  })

  it("will not remove '.' or '..' by those names", async () => {
    const t = await terminal()
    await check(t, 'cd /tmp/d; rm -r .', '', "rm: refusing to remove '.' or '..' directory: skipping '.'\n", 1, '/tmp/d')
    await check(t, 'rm -r ..', '', "rm: refusing to remove '.' or '..' directory: skipping '..'\n", 1, '/tmp/d')
    await check(t, 'rm -r sub/..', '', "rm: refusing to remove '.' or '..' directory: skipping 'sub/..'\n", 1, '/tmp/d')
    await check(t, 'find . -type f', './one\n./sub/two\n', '', 0, '/tmp/d')
  })

  it('will not remove a read-only tree, or walk into one', async () => {
    const t = await terminal()
    await check(t, 'rm -r /repo/d', '', "rm: cannot remove '/repo/d': Read-only file system\n", 1)
    await check(t, 'find /repo/d -type f', '/repo/d/one\n/repo/d/sub/two\n')
  })

  it('still refuses a directory without -r', async () => {
    const t = await terminal()
    await check(t, 'rm /tmp/d', '', "rm: cannot remove '/tmp/d': Is a directory\n", 1)
    await check(t, 'rm -f /tmp/d', '', "rm: cannot remove '/tmp/d': Is a directory\n", 1)
  })

  it('has no /tmp to remove without an overlay', async () => {
    const t = await terminal({ writable: false })
    await check(t, 'rm -r /tmp', '', "rm: cannot remove '/tmp': No such file or directory\n", 1)
  })
})
