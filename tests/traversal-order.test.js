import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// This filesystem has no creation order to reproduce, so a recursive walk picks
// a stable one. Sorting is only safe where it happens: inside the walk, once per
// directory, the way fts(3) consumes readdir. Sorting the finished list of paths
// instead is the tempting shortcut, and ascending order hides the difference —
// until a directory has a sibling sharing its name, because '.' (0x2E) sorts
// before '/' (0x2F). Verified against GNU find 4.9, du 9.4 and ls 9.4 on an
// ext2 image built with `mke2fs -O ^dir_index`, whose linear directories hand
// readdir the order entries were created in, and against tree 2.1.1, whose
// continuation prefix really is U+2502 and two U+00A0 before a plain space.
const FILES = { 'd/x': 'x\n', 'd.txt': 'sib\n' }
const run = (command) => createTerminal(FILES).run(command)

describe('a recursive walk sorts each directory, not the paths it produced', () => {
  for (const [command, stdout] of [
    // Descends into d before moving to the sibling d.txt. A sorted flat list
    // would put "./d.txt" second and "./d/x" last, which find cannot print:
    // it is pre-order, so a directory always precedes its own contents.
    ['find .', '.\n./d\n./d/x\n./d.txt\n'],
    ['find . -type f', './d/x\n./d.txt\n'],
    // du is post-order, so d follows its contents while d.txt stays after both.
    ['du -b -a .', '2\t./d/x\n2\t./d\n4\t./d.txt\n6\t.\n'],
    ['du -b .', '2\t./d\n6\t.\n'],
    ['ls -R', '.:\nd\nd.txt\n\n./d:\nx\n'],
  ]) {
    it(command, async () => {
      const result = await run(command)
      assert.equal(result.stdout, stdout)
      assert.equal(result.stderr, '')
      assert.deepEqual(result.unsupported, [])
    })
  }

  it('renders the same nesting as a tree', async () => {
    assert.equal((await run('tree')).stdout, '.\n\u251C\u2500\u2500 d\n\u2502\u00A0\u00A0 \u2514\u2500\u2500 x\n\u2514\u2500\u2500 d.txt\n\n2 directories, 2 files\n')
  })

  // Reversing within each directory stays reproducible — entries created in the
  // opposite order give exactly that. Reversing the finished list does not: it
  // puts a directory below its contents and the root last.
  it('keeps every directory above its own contents', async () => {
    const paths = (await run('find .')).stdout.trimEnd().split('\n')
    assert.ok(paths.indexOf('./d') < paths.indexOf('./d/x'), 'a directory precedes its contents')
    assert.equal(paths[0], '.', 'the starting point comes first')
  })
})
