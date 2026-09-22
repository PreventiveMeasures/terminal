import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// find measures a file in whole units and rounds what it measures up, so
// `-size 1k` is everything from one byte to a thousand and twenty-four. A
// directory is a block of its own and a link is as long as the path it holds,
// which is what `ls -l` and `du` report of them. `-depth` turns the walk
// inside out. Every answer below was recorded from GNU findutils 4.9 over the
// same tree on disk; this walk is sorted where a real one is not, so the
// order is this tree's own and the entries are findutils'.
const TREE = {
  'empty.txt': '',
  'one.txt': 'x',
  'half.txt': 'x'.repeat(511),
  'block.txt': 'x'.repeat(512),
  'over.txt': 'x'.repeat(513),
  'kilo.txt': 'x'.repeat(1024),
  'dir/sub/d.txt': 'deep\n',
  link: { type: 'link', target: 'one.txt' },
  away: { type: 'link', target: 'dir/sub' },
}
const out = async (command) => (await createTerminal(TREE).run(command)).stdout
const fails = async (command, stderr) => {
  assert.deepEqual(await createTerminal(TREE).run(command), {
    stdout: '', stderr, exitCode: 1, cwd: '/', notes: [], unsupported: [],
  }, command)
}

describe('find measures what it walks', () => {
  it('counts in half-kilobyte blocks when no unit is named', async () => {
    assert.equal(await out('find . -size 0'), './empty.txt\n')
    assert.equal(await out('find . -size -1'), './empty.txt\n')
    // One block is everything from a byte to five hundred and twelve, links
    // and all: a link is as long as the path it holds.
    assert.equal(await out('find . -size 1'), './away\n./block.txt\n./dir/sub/d.txt\n./half.txt\n./link\n./one.txt\n')
    assert.equal(await out('find . -size +1'), '.\n./dir\n./dir/sub\n./kilo.txt\n./over.txt\n')
  })

  it('counts in the unit it is given, bytes exactly among them', async () => {
    assert.equal(await out('find . -size 1c'), './one.txt\n')
    assert.equal(await out('find . -size 1w'), './one.txt\n')
    assert.equal(await out('find . -size -512c'), './away\n./dir/sub/d.txt\n./empty.txt\n./half.txt\n./link\n./one.txt\n')
    assert.equal(await out('find . -size +512c'), '.\n./dir\n./dir/sub\n./kilo.txt\n./over.txt\n')
    assert.equal(await out('find . -size 1k'), './away\n./block.txt\n./dir/sub/d.txt\n./half.txt\n./kilo.txt\n./link\n./one.txt\n./over.txt\n')
    assert.equal(await out('find . -size +1k'), '.\n./dir\n./dir/sub\n')
    // A directory is the one block `ls -l` and `du` give it.
    assert.equal(await out('find . -type d -size 8'), '.\n./dir\n./dir/sub\n')
  })

  it('says what findutils says of a size it cannot read', async () => {
    await fails('find . -size 1K', "find: invalid -size type `K'\n")
    await fails('find . -size abc', "find: Invalid argument `abc' to -size\n")
    await fails('find . -size +1.5k', "find: Invalid argument `+1.5k' to -size\n")
    await fails("find . -size ''", 'find: invalid null argument to -size\n')
    await fails('find . -size 99999999999999999999', "find: Invalid argument `99999999999999999999' to -size\n")
  })

  it('asks what a link holds rather than what it is called', async () => {
    assert.equal(await out("find . -lname 'one.txt'"), './link\n')
    assert.equal(await out("find . -ilname 'ONE*'"), './link\n')
    // A star crosses a slash here, the target being one string rather than a
    // path walked a name at a time.
    assert.equal(await out("find . -lname 'dir*'"), './away\n')
    assert.equal(await out("find . -lname '*sub'"), './away\n')
    // Nothing that is not a link holds anything.
    assert.equal(await out("find . -lname '*'"), './away\n./link\n')
  })

  it('reaches what a directory holds before the directory, and the root last', async () => {
    assert.equal(await out('find . -depth'),
      './away\n./block.txt\n./dir/sub/d.txt\n./dir/sub\n./dir\n./empty.txt\n./half.txt\n./kilo.txt\n./link\n./one.txt\n./over.txt\n.\n')
    assert.equal(await out('find . -d -type d'), './dir/sub\n./dir\n.\n')
    assert.equal(await out('find . -depth -maxdepth 1 -type d'), './dir\n.\n')
    assert.equal(await out('find . -depth -mindepth 1 -type d'), './dir/sub\n./dir\n')
    assert.equal(await out('find dir -depth'), 'dir/sub/d.txt\ndir/sub\ndir\n')
    // GNU says a prune has nothing left to prune once the walk is inside out.
    assert.equal(await out('find . -depth -name dir -prune -o -type d -print'), './dir/sub\n.\n')
  })
})
