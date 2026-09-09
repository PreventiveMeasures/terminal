import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = {
  'src/a.ts': "q: marker\np: one\n  'two': 2\nroute('/three')\np: four\np: five\np: six\np: seven\n",
  'src/b.ts': "q: second\nother\n  'eight': 8\n",
  'src/c.ts': 'p: no marker\n',
  'src/ignored.js': 'q: ignored\np: ignored\n',
}
const FIRST = "2:p: one\n3:  'two': 2\n4:route('/three')\n5:p: four\n6:p: five\n7:p: six\n"
const SECOND = "3:  'eight': 8\n"

function check(command, stdout) {
  assert.deepEqual(createTerminal(FILES).run(command), {
    stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [],
  })
}

describe('source discovery loop from agent logs', () => {
  it('finds only matching TypeScript paths', () => {
    check('grep -rl "q:" src --include=*.ts', 'src/a.ts\nsrc/b.ts\n')
  })

  it('preserves BRE alternation, anchors, literal parentheses, and single quotes', () => {
    check(String.raw`grep -n "p:\|^  '\|('/" src/a.ts | head -6`, FIRST)
    check(String.raw`grep -n "p:\|^  '\|('/" src/b.ts | head -6`, SECOND)
  })

  it('runs the same loop body with an explicit file list', () => {
    check(String.raw`for f in src/a.ts src/b.ts; do echo "== $f"; grep -n "p:\|^  '\|('/" $f | head -6; done 2>/dev/null | head -120`,
      '== src/a.ts\n' + FIRST + '== src/b.ts\n' + SECOND)
  })

  it('runs the complete discovery and preview command', () => {
    check(String.raw`for f in $(grep -rl "q:" src --include=*.ts); do echo "== $f"; grep -n "p:\|^  '\|('/" $f | head -6; done 2>/dev/null | head -120`,
      '== src/a.ts\n' + FIRST + '== src/b.ts\n' + SECOND)
  })

  it('assigns grep counts and prints only matching files inside a conditional', () => {
    const terminal = createTerminal({
      'a/one.txt': 'apple\nnone\nbeta\n',
      'a/two.txt': 'none\n',
      'a/nested/three.txt': 'abc\ncat\n',
      'a/ignored.js': 'abc\n',
    }, { cwd: '/a' })
    assert.deepEqual(terminal.run(String.raw`cd / && for f in $(find a -name "*.txt"); do c=$(grep -c "a\|b\|c" $f); if [ "$c" != "0" ]; then echo "$f: $c"; fi; done`), {
      stdout: 'a/nested/three.txt: 2\na/one.txt: 2\n', stderr: '', exitCode: 0, cwd: '/', unsupported: [],
    })
  })
})
