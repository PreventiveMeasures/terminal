import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU grep 3.11 src/grep.c: grep() enables zap_nuls() in binary mode;
// skip_empty_lines is determined by executing the pattern on an empty record.
// https://git.savannah.gnu.org/cgit/grep.git/tree/src/grep.c?h=v3.11
const FILES = {
  zero: '\0',
  zeros: '\0\0\0',
  lines: '\n\0\n\0\0\n',
  text: 'hit\n\n',
  binary: '\0hit\n',
  'dir/zero.txt': '\0\0\n',
  'dir/text.txt': 'hit\n',
}

function check(command, stdout = '', exitCode = 1, stderr = '', files = FILES) {
  assert.deepEqual(createTerminal(files).run(command), {
    stdout, stderr, exitCode, cwd: '/', unsupported: [],
  }, command)
}

describe('grep binary inputs containing only empty records', () => {
  const cases = [
    ['grep . zero'],
    ['grep . zeros'],
    ['grep . lines'],
    ["grep -E '.+' zero"],
    ["grep -P '.' zero"],
    ["grep '[a-z]' zero"],
    ["grep '^.$' zero"],
    ['grep -F absent zero'],
    ['grep -x . zero'],
    ['grep -n . zero'],
    ['grep -o . zero'],
    ['grep -m1 . zero'],
    ['grep -q . zero'],
    ['grep -l . zero'],
    ['grep -L . zero', 'zero\n'],
    ['grep -c . zero', '0\n'],
    ['grep -Hc . zero', 'zero:0\n'],
    ['grep -cm1 . zero', '0\n'],
    ['grep -e . -e absent zero'],
    ["grep -v '^$' zero"],
    ["grep -v '' zero"],
    ["grep -vc '^$' lines", '0\n'],
    ["grep -vL '^$' lines", 'lines\n'],
    ['cat zero | grep .'],
    ['cat zero | grep -q .'],
    ['grep . < zero'],
    ['grep . zero text', 'text:hit\n', 0],
    ['grep -c . zero text', 'zero:0\ntext:1\n', 0],
    ['grep -L . zero text', 'zero\n', 0],
    ['grep -q . zero text', '', 0],
    ['grep -r . dir', 'dir/text.txt:hit\n', 0],
    ['grep -r . dir --include=zero.txt'],
  ]
  for (const [command, stdout, exitCode] of cases) {
    it(command, () => check(command, stdout, exitCode))
  }

  it('does not depend on where an all-empty binary input first contains NUL', () => {
    const files = { zero: '\0'.repeat(200000), late: '\n'.repeat(100000) + '\0' }
    check('grep . zero', '', 1, '', files)
    check('grep -c . late', '0\n', 1, '', files)
  })

  it('preserves ordinary read failures alongside binary non-matches', () => {
    check('grep . missing zero', '', 2, 'grep: missing: no such file or directory\n')
    check('grep -c . zero missing', 'zero:0\n', 2, 'grep: missing: no such file or directory\n')
    check('grep -s . missing zero', '', 2)
    check('grep -sq . missing zero', '', 2)
  })

  it('treats NUL as text only when the last binary option selects text mode', () => {
    check('grep -a . zero', '\0\n', 0)
    check('grep --text . zeros', '\0\0\0\n', 0)
    check('grep -ao . zeros', '\0\n\0\n\0\n', 0)
    check('grep -Ia . zero', '\0\n', 0)
    check('grep -aI . zero')
    check('grep -Iv . zero')
  })

  for (const command of [
    'grep . binary',
    "grep '' zero",
    "grep '^$' zero",
    'grep -v . zero',
    "grep -e . -e '^$' zero",
  ]) {
    it(`retains binary diagnostics when a record can be selected: ${command}`, () => {
      const result = createTerminal(FILES).run(command)
      assert.equal(result.stdout, '')
      assert.equal(result.exitCode, 2)
      assert.deepEqual(result.unsupported.map(({ command: name, detail }) => [name, detail]), [['grep', 'binary input']])
    })
  }
})
