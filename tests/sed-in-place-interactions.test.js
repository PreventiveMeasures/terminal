import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU closedown renames the original to its backup, then installs the
// temporary output. Existing descriptors keep their original inode.
// https://github.com/mirror/sed/blob/v4.9/sed/execute.c
const result = (stdout = '', exitCode = 0, stderr = '', cwd = '/src') => ({ stdout, stderr, exitCode, cwd, notes: [], unsupported: [] })
const setup = async () => {
  const terminal = createTerminal({}, { mount: '/src/', writable: '/tmp/' })
  assert.deepEqual(await terminal.run('printf aa >/tmp/a; printf stale >/tmp/a.bak'), result())
  return terminal
}

describe('sed in-place backup aliases and open descriptors', () => {
  for (const suffix of ['./*', '../tmp/*']) {
    it(`allows backup spelling ${suffix} to resolve to the original path`, async () => {
      const terminal = await setup()
      assert.deepEqual(await terminal.run(`cd /tmp; sed --in-place='${suffix}' s/a/X/ a`), result('', 0, '', '/tmp'))
      assert.deepEqual(await terminal.run('cat a a.bak'), result('Xastale', 0, '', '/tmp'))
      assert.deepEqual(await terminal.run('ls -A'), result('a\na.bak\n', 0, '', '/tmp'))
    })
  }
  it('processes repeated input aliases again and backs up the intermediate content', async () => {
    const terminal = await setup()
    assert.deepEqual(await terminal.run('sed -i.bak s/a/X/ /tmp/a /tmp/./a'), result())
    assert.deepEqual(await terminal.run('cat /tmp/a /tmp/a.bak'), result('XXXa'))
  })
  it('opens a later backup operand after the earlier file has replaced it', async () => {
    const terminal = await setup()
    assert.deepEqual(await terminal.run('sed -i.bak s/a/X/ /tmp/a /tmp/a.bak'), result())
    assert.deepEqual(await terminal.run('cat /tmp/a /tmp/a.bak /tmp/a.bak.bak'), result('XaXaaa'))
  })
  for (const redirection of ['>', '>>']) {
    it(`keeps ${redirection} descriptors on a replaced backup inode`, async () => {
      const terminal = await setup()
      const command = `{ printf before; sed -i.bak s/a/X/ /tmp/a; printf after; } ${redirection}/tmp/a.bak`
      assert.deepEqual(await terminal.run(command), result())
      assert.deepEqual(await terminal.run('cat /tmp/a /tmp/a.bak'), result('Xaaa'))
    })
  }
  it('unlinking the edited file leaves the original descriptor and backup intact', async () => {
    const terminal = await setup()
    assert.deepEqual(await terminal.run('{ sed -i.bak s/a/X/ /tmp/a; rm /tmp/a; printf after; } >>/tmp/a'), result())
    assert.deepEqual(await terminal.run('test -f /tmp/a'), result('', 1))
    assert.deepEqual(await terminal.run('cat /tmp/a.bak'), result('aaafter'))
  })
  it('recreating a removed edited file cannot redirect writes through the old descriptor', async () => {
    const terminal = await setup()
    assert.deepEqual(await terminal.run('{ sed -i.bak s/a/X/ /tmp/a; rm /tmp/a; printf new >/tmp/a; printf after; } >>/tmp/a'), result())
    assert.deepEqual(await terminal.run('cat /tmp/a /tmp/a.bak'), result('newaaafter'))
  })
  it('validates a backup path component before resolving parent traversal', async () => {
    const terminal = await setup()
    const actual = await terminal.run('sed -i/../b s/a/X/ /tmp/a')
    assert.equal(actual.exitCode, 4)
    assert.match(actual.stderr, /Not a directory/u)
    assert.deepEqual(actual.unsupported, [])
    assert.deepEqual(await terminal.run('cat /tmp/a /tmp/a.bak'), result('aastale'))
  })
})

describe('sed in-place options coexist with positional and required arguments', () => {
  for (const command of [
    'sed s/a/X/ /tmp/a -i.bak', 'sed /tmp/a --expression=s/a/X/ --in-place=.bak',
    'sed -n -e s/a/X/p /tmp/a -i.bak', 'sed -e s/a/X/ --in-place=.bak -- /tmp/a',
  ]) {
    it(command, async () => {
      const terminal = await setup()
      assert.deepEqual(await terminal.run(command), result())
      assert.deepEqual(await terminal.run('cat /tmp/a /tmp/a.bak'), result('Xaaa'))
    })
  }
  it('does not consume an option-shaped script filename as an in-place flag', async () => {
    const terminal = await setup()
    assert.deepEqual(await terminal.run("cd /tmp; printf s/a/X/ >-i; sed -f -i -i.bak a"), result('', 0, '', '/tmp'))
    assert.deepEqual(await terminal.run('cat a a.bak ./-i'), result('Xaaas/a/X/', 0, '', '/tmp'))
  })
  it('keeps -i after the option terminator as a literal input operand', async () => {
    const terminal = await setup()
    assert.deepEqual(await terminal.run('cd /tmp; printf aa >-i; sed -i.bak -e s/a/X/ -- -i'), result('', 0, '', '/tmp'))
    assert.deepEqual(await terminal.run('cat ./-i ./-i.bak'), result('Xaaa', 0, '', '/tmp'))
  })
})
