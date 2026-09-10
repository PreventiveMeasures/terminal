import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = {
  binary: 'before\nhit\0tail\nmiss\nhit\0last',
  boundaries: 'q\0\nq\n\0\n',
  good: 'hit\nother\nhit again\n',
  empty: '',
  'dir/one.txt': 'hit\0one\n',
  'dir/two.js': 'hit\0two\n',
  'dir/nested/three.txt': 'hit\0three\n',
  unicode: 'é\0\n',
}

const BINARY_NOTES = ['grep: skipped 1 binary file: "/binary". Binary input is treated as text with -a.']
const FILTER_NOTES = [
  'glob: no paths matched "--include=*.txt"; the pattern was left literal.',
  'grep: excluded 1 entry by --include/--exclude/--exclude-dir rules: "/dir/two.js".',
]

function check(command, stdout, exitCode = 0, stderr = '', files = FILES, notes = []) {
  assert.deepEqual(createTerminal(files).run(command), {
    stdout, stderr, exitCode, cwd: '/', notes, unsupported: [],
  }, command)
}

describe('grep — force binary input to text', () => {
  const cases = [
    ['grep -a hit binary', 'hit\0tail\nhit\0last\n'],
    ['grep --text -n hit binary', '2:hit\0tail\n4:hit\0last\n'],
    ["grep -a '^q$' boundaries", 'q\n'],
    ["grep -a '^.$' boundaries", 'q\n\0\n'],
    ["grep -ao 'hit.*' binary", 'hit\0tail\nhit\0last\n'],
    ["grep -ao '^.$' boundaries", 'q\n\0\n'],
    ['grep -ac hit binary', '2\n'],
    ['grep -av hit binary', 'before\nmiss\n'],
    ['grep -al hit binary good', 'binary\ngood\n'],
    ['grep -aL hit binary empty', 'empty\n'],
    ['grep -aq hit binary', ''],
    ['grep -am1 hit binary', 'hit\0tail\n'],
    ['grep -acm1 hit binary', '1\n'],
    ['cat binary | grep --text hit', 'hit\0tail\nhit\0last\n'],
    ['grep -arhn hit dir --include=*.txt', '1:hit\0three\n1:hit\0one\n', FILTER_NOTES],
  ]
  for (const [command, stdout, notes] of cases) it(command, () => check(command, stdout, 0, '', FILES, notes))

  it('retains ordinary no-match status when binary input is treated as text', () => {
    check('grep -a absent binary', '', 1)
    check('grep -aq absent binary', '', 1)
  })

  it('processes NUL beyond the binary-detection buffer limit', () => {
    const files = { binary: 'hit\n' + 'x'.repeat(100000) + '\0\n' }
    check('grep -am1 hit binary', 'hit\n', 0, '', files)
    check('grep -ac . binary', '2\n', 0, '', files)
  })

  for (const options of ['-Ia', '-I -a', '-I --text', '-aIa', '--text -I -a']) {
    it(`the last text option wins: ${options}`, () => {
      check(`grep ${options} hit binary`, 'hit\0tail\nhit\0last\n')
      check(`grep ${options} -q hit binary`, '')
    })
  }

  for (const options of ['-aI', '-a -I', '--text -I', '-IaI']) {
    it(`the last binary exclusion wins: ${options}`, () => {
      check(`grep ${options} hit binary`, '', 1, '', FILES, BINARY_NOTES)
      check(`grep ${options} -q hit binary`, '', 1, '', FILES, BINARY_NOTES)
      check(`grep ${options} -c hit binary`, '0\n', 1, '', FILES, BINARY_NOTES)
      check(`grep ${options} -L hit binary`, 'binary\n', 1, '', FILES, BINARY_NOTES)
    })
  }
})

describe('grep — suppress input read errors', () => {
  const cases = [
    ['grep -s hit missing', '', 2],
    ['grep --no-messages hit missing', '', 2],
    ['grep -s hit missing good', 'good:hit\ngood:hit again\n', 2],
    ['grep -s hit good missing', 'good:hit\ngood:hit again\n', 2],
    ['grep -s hit missing empty', '', 2],
    ['grep -s hit dir', '', 2],
    ['grep -s hit good/../missing', '', 2],
    ['grep -sc hit missing good', 'good:2\n', 2],
    ['grep -sl hit missing good', 'good\n', 2],
    ['grep -sL hit missing empty', 'empty\n', 2],
    ['grep -sq hit missing good', '', 0],
    ['grep -sq hit good missing', '', 0],
    ['grep -sq hit missing empty', '', 2],
    ['grep -sq absent good', '', 1],
    ['grep -sm0 hit missing', '', 1],
    ['grep -srn hit missing dir --include=*.txt -a', 'dir/nested/three.txt:1:hit\0three\ndir/one.txt:1:hit\0one\n', 2, FILTER_NOTES],
    ['grep --no-messages -a hit missing binary', 'binary:hit\0tail\nbinary:hit\0last\n', 2],
  ]
  for (const [command, stdout, exitCode, notes] of cases) it(command, () => check(command, stdout, exitCode, '', FILES, notes))

  it('leaves read errors visible unless suppression was requested', () => {
    check('grep -a hit missing binary', 'binary:hit\0tail\nbinary:hit\0last\n', 2,
      'grep: missing: no such file or directory\n')
  })

  it('does not suppress invalid-pattern or invalid-option-argument errors', () => {
    for (const command of ["grep -s '[' good", 'grep -s -m-1 hit good', 'grep --no-messages --text=yes hit good']) {
      const result = createTerminal(FILES).run(command)
      assert.equal(result.stdout, '', command)
      assert.equal(result.exitCode, 2, command)
      assert.match(result.stderr, /^grep: .+\n$/u, command)
      assert.deepEqual(result.unsupported, [], command)
    }
  })

  it('does not suppress unsupported options, regex features, binary behavior, or locale diagnostics', () => {
    const gaps = [
      ['grep -s --unknown hit good', 'option', '--unknown'],
      [String.raw`grep -s '\d' good`, 'feature', 'regex escape'],
      ['grep -s hit binary', 'feature', 'binary input'],
      ['grep -as . unicode', 'feature', 'non-ASCII regex semantics'],
      ['grep --no-messages -aq . unicode', 'feature', 'non-ASCII regex semantics'],
      ['grep -sq hit missing binary', 'feature', 'binary input'],
    ]
    for (const [command, kind, detail] of gaps) {
      const result = createTerminal(FILES).run(command)
      assert.equal(result.stdout, '', command)
      assert.equal(result.exitCode, 2, command)
      assert.match(result.stderr, /^grep: .+\n$/u, command)
      assert.deepEqual(result.unsupported, [{ kind, command: 'grep', detail, message: result.stderr.trimEnd() }], command)
    }
  })

  it('keeps unsupported metadata through stderr redirection and a successful following stage', () => {
    const result = createTerminal(FILES).run('grep -as . unicode 2>/dev/null | true')
    const message = 'grep: locale-sensitive regular expression matching on non-ASCII input is not supported'
    assert.deepEqual(result, {
      stdout: '', stderr: '', exitCode: 0, cwd: '/',
      notes: [], unsupported: [{ kind: 'feature', command: 'grep', detail: 'non-ASCII regex semantics', message }],
    })
  })
})
