// Divergences from GNU found by replaying external conformance corpora
// against this implementation: the GNU and Spencer regex suites, busybox's
// grep tests, and the Oils shell spec, with real bash 5.2, GNU grep 3.11
// and gawk 5.2 answering as the oracle. Every expectation below is what
// those tools actually printed, not what this implementation used to do.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = { f: 'BADRPT\nxyz\naaa\nab\n' }
const run = (command) => createTerminal(FILES).run(command)

// POSIX stacks quantifiers: `a+?` is `(a+)?`, which is nullable and so
// matches every line, and `a+*` is `(a+)*`. ECMAScript instead reads `+?`
// as a lazy `+` and rejects `+*` outright. grep's boolean matcher took
// the JS reading while its `-o` extent matcher parsed real ERE, so the
// two disagreed with each other: `-c` counted 2 lines where `-o` found
// matches on 4. Only the boolean side is rewritten — the extent matcher
// already read these the way GNU does.
const STACKED = [
  ["grep -cE 'a+?' f", '4\n'],
  ["grep -cE 'a{1}?' f", '4\n'],
  ["grep -cE '(ab)+?' f", '4\n'],
  ["grep -cE 'a*?' f", '4\n'],
  ["grep -cE 'a{2,}?' f", '4\n'],
  ["grep -cE 'x+?y*' f", '4\n'],
  // `+*` and `++` are errors in ECMAScript; in POSIX they are ordinary
  // stacked quantifiers, and `a++` is `(a+)+` — still one-or-more.
  ["grep -cE 'a+*' f", '4\n'],
  ["grep -cE 'a++' f", '2\n'],
  // A third quantifier applies to the second.
  ["grep -cE 'a+?*' f", '4\n'],
  ["grep -E 'a+?' f", 'BADRPT\nxyz\naaa\nab\n'],
  // `-w` still constrains the rewritten pattern.
  ["grep -cwE 'a+?' f", '1\n'],
  // The extent matcher is unchanged: still leftmost-longest, and it
  // skips the empty matches a nullable pattern produces.
  ["grep -oE 'a+?' f", 'aaa\na\n'],
  ["grep -oE '(a|ab)' f", 'a\na\na\nab\n'],
  // awk shares neither path and always read these as POSIX does.
  ["awk '/a+?/ { n++ } END { print n }' f", '4\n'],
]

// GNU refuses these; we used to accept them and quietly match something
// else. `a[[:alpha,:]` matched a literal `a`, and an interval above
// RE_DUP_MAX simply never matched instead of being an error.
const REJECTED = [
  ["grep -E 'a[1-3-5]c' f", 'Invalid range end'],
  ["grep -e '[1-3-5]' f", 'Invalid range end'],
  ["grep -E '[a-c-e]' f", 'Invalid range end'],
  ["grep -E 'a[[:alpha,:]' f", 'Invalid character class name'],
  ["grep -e 'a[[:alpha,:]' f", 'Invalid character class name'],
  ["grep -E 'a[a[:b]' f", 'Unmatched [, [^, [:, [., or [='],
  ["grep -e 'a\\{32768\\}' f", 'Regular expression too big'],
  ["grep -E 'b{1000000000}' f", 'Regular expression too big'],
  ["grep -E 'a{40000,}' f", 'Regular expression too big'],
]

// The neighbouring forms that stay legal, so validating brackets and
// interval bounds does not start refusing what GNU accepts. A `-` is an
// ordinary member first or last, `]` is one in the first position, and
// RE_DUP_MAX itself is allowed.
const ACCEPTED = [
  ["grep -cE '[a-]' f", '2\n'],
  ["grep -cE '[-a]' f", '2\n'],
  ["grep -cE '[a-c-]' f", '2\n'],
  ["grep -cE '[]-a]' f", '2\n'],
  // Counting zero matches is still an unsuccessful status, as in GNU.
  ["grep -cE 'a{32767}' f", '0\n', 1],
  ["grep -ce '[[:alpha:]]' f", '4\n'],
  ["grep -coE 'a' f", '2\n'],
]

describe('GNU conformance — POSIX quantifier stacking', () => {
  for (const [command, stdout] of STACKED) {
    it(command, () => {
      const r = run(command)
      assert.deepEqual(r.unsupported, [], command + ': refusing the pattern does not count as matching it')
      assert.deepEqual({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }, { stdout, stderr: '', exitCode: 0 })
    })
  }
})

describe('GNU conformance — patterns GNU rejects', () => {
  for (const [command, message] of REJECTED) {
    it(command, () => {
      const r = run(command)
      assert.equal(r.exitCode, 2)
      assert.equal(r.stdout, '')
      assert.equal(r.stderr, `grep: ${message}\n`)
      // A malformed pattern is the caller's mistake, not a gap in this
      // implementation, so it stays off the diagnostic feed.
      assert.deepEqual(r.unsupported, [])
    })
  }
})

describe('GNU conformance — bracket and interval forms that stay legal', () => {
  for (const [command, stdout, exitCode = 0] of ACCEPTED) {
    it(command, () => {
      const r = run(command)
      assert.deepEqual({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }, { stdout, stderr: '', exitCode })
    })
  }
})

// A shell removes backslash-newline before it recognises tokens, so a
// reference split across lines is still one reference. The tokenizer read
// `$` from the raw line and found `\` after it, emitting a literal `$`
// and leaving `?` to be read as its own word.
describe('GNU conformance — line continuation inside a reference', () => {
  const CONTINUED = [
    ['echo $\\\n?', '0\n'],
    ['echo a; echo $\\\n?', 'a\n0\n'],
    ['echo $\\\n{HOME}', '/\n'],
    // Continuations elsewhere already worked; keep them that way.
    ['ec\\\nho hi', 'hi\n'],
    ['echo "a\\\nb"', 'ab\n'],
  ]
  for (const [command, stdout] of CONTINUED) {
    it(JSON.stringify(command), () => {
      const r = run(command)
      assert.deepEqual({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }, { stdout, stderr: '', exitCode: 0 })
    })
  }

  it('single quotes still keep a backslash-newline literal', () => {
    assert.equal(run("echo 'a\\\nb'").stdout, 'a\\\nb\n')
  })
})
