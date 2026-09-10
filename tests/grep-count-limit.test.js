import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = {
  'src/a.js': 'skip\nhit hit\nskip\nhit\ntrailing\n',
  'src/b.js': 'hit second\nhit third',
  'src/c.js': 'none\n',
  'src/d.txt': 'hit text\n',
  empty: '',
}

function check(command, stdout, exitCode = 0, stderr = '') {
  assert.deepEqual(createTerminal(FILES).run(command), {
    stdout, stderr, exitCode, cwd: '/', notes: [], unsupported: [],
  }, command)
}

describe('grep count and attached match limits', () => {
  const cases = [
    ['grep -c hit src/a.js', '2\n'],
    ['grep -cn hit src/a.js', '2\n'],
    ['grep -co hit src/a.js', '2\n'],
    ['grep -c -e hit -e hit src/a.js', '2\n'],
    ['grep -cv hit src/a.js', '3\n'],
    ['grep -c -A2 -B1 hit src/a.js', '2\n'],
    ['grep -c hit src/a.js src/c.js empty', 'src/a.js:2\nsrc/c.js:0\nempty:0\n'],
    ['grep -c hit src/c.js empty', 'src/c.js:0\nempty:0\n', 1],
    ['grep -ch hit src/a.js src/c.js', '2\n0\n'],
    ['grep -cH hit src/a.js', 'src/a.js:2\n'],
    ["grep -rc hit src --include='*.js'", 'src/a.js:2\nsrc/b.js:2\nsrc/c.js:0\n'],
    ['cat src/a.js | grep -c hit', '2\n'],
    ['grep -c hit < src/a.js', '2\n'],
    ['cat src/a.js | grep -cH hit', '(standard input):2\n'],
    ['grep -cq hit src/a.js', ''],
    ['grep -cq hit src/c.js', '', 1],
    ['grep -m1 hit src/a.js', 'hit hit\n'],
    ['grep -m 1 hit src/a.js', 'hit hit\n'],
    ['grep -nm1 hit src/a.js', '2:hit hit\n'],
    ['grep hit src/a.js -m1', 'hit hit\n'],
    ['grep -om1 hit src/a.js', 'hit\nhit\n'],
    ['grep -vm1 hit src/a.js', 'skip\n'],
    ['grep -cm1 hit src/a.js src/b.js src/c.js', 'src/a.js:1\nsrc/b.js:1\nsrc/c.js:0\n'],
    ['grep -m1 hit src/a.js src/b.js', 'src/a.js:hit hit\nsrc/b.js:hit second\n'],
    ["grep -rnm1 hit src --include='*.js'", 'src/a.js:2:hit hit\nsrc/b.js:1:hit second\n'],
    ['grep -nm1 -A2 hit src/a.js', '2:hit hit\n3-skip\n4-hit\n'],
    ['grep -nm1 -B1 hit src/a.js', '1-skip\n2:hit hit\n'],
    ['grep -m1 hit src/c.js', '', 1],
    ['cat src/a.js | grep -m1 hit', 'hit hit\n'],
    ['grep -lm1 hit src/a.js src/c.js', 'src/a.js\n'],
    ['grep -Lm1 hit src/a.js src/c.js', 'src/c.js\n'],
    ['grep -qm1 hit src/a.js missing', ''],
    ['{ grep -m1 hit /dev/stdin; cat; } < src/a.js', 'hit hit\n' + FILES['src/a.js']],
  ]

  for (const [command, stdout, exitCode] of cases) {
    it(command, () => check(command, stdout, exitCode))
  }

  it('keeps successful counts and capped matches when another operand cannot be read', () => {
    const stderr = 'grep: missing: no such file or directory\n'
    check('grep -c hit missing src/a.js', 'src/a.js:2\n', 2, stderr)
    check('grep -m1 hit missing src/a.js', 'src/a.js:hit hit\n', 2, stderr)
  })

  it('mirrors unsupported combinations and shared-file early reads even when stderr is hidden', () => {
    const earlyRead = 'grep: early termination on shared file input is not supported'
    const unsupportedCases = [
      ['grep -m1 hit < src/a.js', 'feature', 'partial stdin reads', earlyRead],
      ['grep -cm1 hit - < src/a.js', 'feature', 'partial stdin reads', earlyRead],
      ['grep -cl hit src/a.js', 'option', 'combined output modes', 'grep: -l / -c are mutually exclusive'],
      ['grep -cL hit src/a.js', 'option', 'combined output modes', 'grep: -L / -c are mutually exclusive'],
    ]
    for (const [command, kind, detail, message] of unsupportedCases) {
      const result = createTerminal(FILES).run(command + ' 2>/dev/null | cat')
      assert.deepEqual(result, {
        stdout: '', stderr: '', exitCode: 0, cwd: '/',
        notes: [], unsupported: [{ kind, command: 'grep', detail, message }],
      }, command)
    }
  })
})
