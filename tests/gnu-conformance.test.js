// Divergences from GNU found by replaying external conformance corpora
// against this implementation: the GNU and Spencer regex suites, busybox's
// grep tests, and the Oils shell spec, with real bash 5.2, GNU grep 3.11
// and gawk 5.2 answering as the oracle. Every expectation below is what
// those tools actually printed, not what this implementation used to do.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hrtime } from 'node:process'
import { createTerminal } from '@preventive/terminal'
import { posixQuantifiers } from '../src/commands/grep-pattern.js'

const FILES = { f: 'BADRPT\nxyz\naaa\nab\n', g: 'aaa\nx{40000}\na(?\n' }
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
  ["grep -cE 'a{2,5}+' f", '1\n'],
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
  // A POSIX class names a set, so it cannot be either end of a range.
  ["grep -E '[[:alpha:]-z]' f", 'Invalid range end'],
  ["grep -E '[[:alpha:]-[:digit:]]' f", 'Invalid range end'],
  ["grep -E '[a-[:digit:]]' f", 'Invalid range end'],
  ["grep -e '[[:alpha:]-z]' f", 'Invalid range end'],
  // An equivalence class names a set too. A collating element names one
  // character and stays a legal endpoint, so it is left to the translator,
  // which refuses collation separately.
  ["grep -E '[[=a=]-z]' f", 'Invalid range end'],
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
  // A `-` beside a class is an ordinary member first or last, as elsewhere.
  ["grep -cE '[[:alpha:]-]' f", '4\n'],
  ["grep -cE '[-[:alpha:]]' f", '4\n'],
  ["grep -cE '[[:alpha:][:digit:]]' f", '4\n'],
]

// Everything between `[` and its closing `]` is a set of characters, so
// nothing in there is syntax: not the `]` that ends a POSIX class inside
// it, not a brace-shaped member, not a group-shaped one. Tracking the
// class by position rather than by the next `]` is what keeps the
// interval and ECMAScript-extension checks from firing on its contents.
const CLASS_MEMBERS = [
  ["grep -cE '[[:alpha:]{40000}]' g", '3\n'],
  ["grep -cE '[]{40000}]' g", '1\n'],
  ["grep -cE '[(?]' g", '1\n'],
  ["grep -cE '[{}]' g", '1\n'],
  ["grep -cE '[[:alpha:][:digit:]]' g", '3\n'],
  // The same checks still apply outside a class.
  ["grep -cE 'a[[:alpha:]]{1}?' g", '2\n'],
]

describe('GNU conformance — bracket contents are members, not syntax', () => {
  for (const [command, stdout] of CLASS_MEMBERS) {
    it(command, () => {
      const r = run(command)
      assert.deepEqual(r.unsupported, [], command + ': refusing the pattern does not count as matching it')
      assert.deepEqual({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }, { stdout, stderr: '', exitCode: 0 })
    })
  }

  it("an interval outside the class is still bounded: grep -E 'a{40000}' g", () => {
    const r = run("grep -E 'a{40000}' g")
    assert.equal(r.exitCode, 2)
    assert.equal(r.stderr, 'grep: Regular expression too big\n')
  })
})

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
// Spelling `a+?` as the nested `(?:a+)?` is correct and catastrophic:
// ECMAScript backtracks exponentially through nested unbounded repetition
// on input that fails to match, where GNU's matcher does not backtrack at
// all. Stacked quantifiers are folded into one instead, so the rewrite
// introduces no nesting for the forms that can be written without it.
describe('GNU conformance — stacked quantifiers do not nest', () => {
  const FOLDED = [
    ['a+?', 'a*'], ['a+*', 'a*'], ['a++', 'a+'], ['a*?', 'a*'], ['a+?*', 'a*'],
    ['a{1}?', 'a?'], ['(ab)+?', '(ab)*'], ['[a-z]+?', '[a-z]*'], ['a{2,5}+', 'a{2,}'],
    ['x+?y*', 'x*y*'], ['^a+?$', '^a*$'], ['a|b+?', 'a|b*'],
    // These cannot be folded, but nest safely: the outer repeats at most
    // once, or each repetition consumes a fixed width.
    ['a{2,}?', '(?:a{2,})?'], ['a{3}{2,}', '(?:a{3}){2,}'],
    ['[a-z]{3}{2,}', '(?:[a-z]{3}){2,}'], ['\\w{3}{2,}', '(?:\\w{3}){2,}'],
  ]
  for (const [pattern, rewritten] of FOLDED) {
    it(`${pattern} → ${rewritten}`, () => {
      assert.equal(posixQuantifiers(pattern), rewritten)
    })
  }

  it('a pattern needing ambiguous nesting is refused, not shipped', () => {
    // `(a{2,5})*` has no single-quantifier equivalent, so it would have to
    // nest a variable-length body under an unbounded repeat.
    const r = run("grep -cE 'a{2,5}*' f")
    assert.equal(r.exitCode, 2)
    assert.deepEqual(r.unsupported.map((u) => u.detail), ['GNU regex syntax'])
  })

  it('a fixed repeat count is not a fixed width when the atom varies', () => {
    // `(a|aa){3}` covers 3 to 6 characters, so repeating it unboundedly is
    // ambiguous even though the count is exact. Refusing is what keeps
    // this from running for minutes: 36 characters took 1.2s when only
    // the count was checked, and each further one doubled it.
    const t = createTerminal({ long: 'a'.repeat(400) + 'c\n' })
    const started = hrtime.bigint()
    const r = t.run("grep -cE '(a|aa){3}{2,}b' long")
    const ms = Number(hrtime.bigint() - started) / 1e6
    assert.equal(r.exitCode, 2)
    assert.deepEqual(r.unsupported.map((u) => u.detail), ['GNU regex syntax'])
    assert.ok(ms < 1000, `took ${ms.toFixed(0)}ms`)
    // A single-character atom still nests, and stays linear.
    assert.equal(t.run("grep -cE 'a{3}{2,}b' long").stdout, '0\n')
  })

  it('a stacked quantifier over a long non-match stays linear', () => {
    // Exponential before the fold: 24 characters took ~220ms, and each
    // further character doubled it.
    const t = createTerminal({ long: 'a'.repeat(4000) + 'c\n' })
    const started = hrtime.bigint()
    assert.equal(t.run("grep -cE 'a+*b' long").stdout, '0\n')
    const ms = Number(hrtime.bigint() - started) / 1e6
    assert.ok(ms < 1000, `took ${ms.toFixed(0)}ms`)
  })
})

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

describe('GNU conformance — what a reader says it could not read', () => {
  // Two divergences, found the same way. Every reader lowercased the reason
  // the filesystem gave back, where coreutils 9.4, grep 3.11 and sed 4.9 all
  // print strerror() as it comes: capitalized. And each of them wraps that
  // reason in wording of its own — `ls` cannot access, `head` cannot open for
  // reading, `sort` cannot read, `sed` can't read — where this said only
  // `<command>: <operand>: <reason>` for all of them. Both are fixed here,
  // and every line below is what the real tool printed in the C locale.
  const files = { f: 'hi\n', 'd/x': 'x\n' }
  const diagnose = (command) => createTerminal(files).run(command)

  const EXACT = [
    ['cat missing', 'cat: missing: No such file or directory\n', 1],
    ['cat d', 'cat: d: Is a directory\n', 1],
    ['cat f/x', 'cat: f/x: Not a directory\n', 1],
    ['wc missing', 'wc: missing: No such file or directory\n', 1],
    ['wc d', 'wc: d: Is a directory\n', 1],
    ['wc f/x', 'wc: f/x: Not a directory\n', 1],
    ['cut -c1 missing', 'cut: missing: No such file or directory\n', 1],
    ['cut -c1 d', 'cut: d: Is a directory\n', 1],
    ['grep hi missing', 'grep: missing: No such file or directory\n', 2],
    ['grep hi d', 'grep: d: Is a directory\n', 2],
    ['grep hi f/x', 'grep: f/x: Not a directory\n', 2],
    ['base64 missing', 'base64: missing: No such file or directory\n', 1],
    ['base64 d', 'base64: read error: Is a directory\n', 1],
    ['od missing', 'od: missing: No such file or directory\n', 1],
    ['od d', 'od: d: Is a directory\n', 1],
    ['nl missing', 'nl: missing: No such file or directory\n', 1],
    ['nl d', 'nl: d: Is a directory\n', 1],
    ['uniq missing', 'uniq: missing: No such file or directory\n', 1],
    ['uniq d', "uniq: error reading 'd': Is a directory\n", 1],
    ['realpath -e missing', 'realpath: missing: No such file or directory\n', 1],
    ['realpath f/x', 'realpath: f/x: Not a directory\n', 1],
    ['cp missing x', "cp: cannot stat 'missing': No such file or directory\n", 1],
    ['rm missing', "rm: cannot remove 'missing': No such file or directory\n", 1],
    ['ls missing', "ls: cannot access 'missing': No such file or directory\n", 2],
    ['ls f/x', "ls: cannot access 'f/x': Not a directory\n", 2],
    ['head missing', "head: cannot open 'missing' for reading: No such file or directory\n", 1],
    ['head d', "head: error reading 'd': Is a directory\n", 1],
    ['head f/x', "head: cannot open 'f/x' for reading: Not a directory\n", 1],
    ['tail missing', "tail: cannot open 'missing' for reading: No such file or directory\n", 1],
    ['tail d', "tail: error reading 'd': Is a directory\n", 1],
    ['sort missing', 'sort: cannot read: missing: No such file or directory\n', 2],
    ['sort d', 'sort: read failed: d: Is a directory\n', 2],
    ['sort f/x', 'sort: cannot read: f/x: Not a directory\n', 2],
    ['tac missing', "tac: failed to open 'missing' for reading: No such file or directory\n", 1],
    ['tac f/x', "tac: failed to open 'f/x' for reading: Not a directory\n", 1],
    // Reading a directory is the one failure coreutils does not name by its
    // reason: tac maps the whole file in one go, and that is what fails.
    ['tac d', 'tac: d: read error: Invalid argument\n', 1],
    ['find missing', "find: 'missing': No such file or directory\n", 1],
    ['find f/x', "find: 'f/x': Not a directory\n", 1],
    ['sed -n p missing', "sed: can't read missing: No such file or directory\n", 2],
    ['sed -n p f/x', "sed: can't read f/x: Not a directory\n", 2],
    ['sed -i s/a/b/ missing', "sed: can't read missing: No such file or directory\n", 2],
    // A directory is the one read sed gives a status of its own to.
    ['sed -n p d', 'sed: read error on d: Is a directory\n', 4],
  ]
  for (const [command, stderr, exitCode] of EXACT) {
    it(JSON.stringify(command), () => {
      const r = diagnose(command)
      assert.deepEqual({ stderr: r.stderr, exitCode: r.exitCode }, { stderr, exitCode })
    })
  }

  // A directory is also where sed stops: it opens no operand after one, where
  // a missing file only costs its own read.
  it('stops sed where GNU stops it, and reads on where GNU reads on', () => {
    assert.deepEqual(diagnose('sed -n p d f'), { ...diagnose('sed -n p d f'), stdout: '', stderr: 'sed: read error on d: Is a directory\n', exitCode: 4 })
    assert.equal(diagnose('sed -n p f d f').stdout, 'hi\n')
    assert.equal(diagnose('sed -n p missing f').stdout, 'hi\n')
    assert.equal(diagnose('sed -n p missing f').exitCode, 2)
    assert.equal(diagnose('sed -n p missing d').stderr, "sed: can't read missing: No such file or directory\nsed: read error on d: Is a directory\n")
    assert.equal(diagnose('sed -n p d missing').stderr, 'sed: read error on d: Is a directory\n')
  })

  // A directory costs only its own read everywhere else, and the operands
  // after it are still opened.
  it('reads past a directory wherever GNU does', () => {
    assert.equal(diagnose('cat d f').stdout, 'hi\n')
    assert.equal(diagnose('nl d f').stdout, '     1\thi\n')
    assert.equal(diagnose('head -n 1 d f').stdout, '==> d <==\n\n==> f <==\nhi\n')
  })

  // gawk's own warning is a sentence, not strerror, and stays lowercase.
  it('a directory operand keeps awk\u2019s lowercase warning', () => {
    assert.equal(diagnose('awk 1 d').stderr, "awk: warning: command line argument `d' is a directory: skipped\n")
  })

  // A custom command reaching a non-directory through the exposed fs fails
  // in the shape a built-in would, so it capitalizes the same way.
  it('a custom command reads the same reason back', () => {
    const t = createTerminal(files, { commands: { probe: (io) => io.fs.listDir(io.args[0]) && '' } })
    assert.equal(t.run('probe missing').stderr, 'probe: missing: No such file or directory\n')
    assert.equal(t.run('probe f').stderr, 'probe: f: Not a directory\n')
  })
})

describe('GNU conformance — what a tool says it could not read on the command line', () => {
  // `sort` reads a key as START[,END], each FIELD[.OFFSET][MODIFIERS], and
  // names the first thing wrong with it — six ways, in two shapes, all of
  // them exit 2. This said `invalid key specification: <spec>` for most of
  // them and exited 1, and rejected two specs GNU accepts: a field count is
  // read the way strtoul reads one, so a leading blank or `+` belongs to the
  // number. Every line below is what coreutils 9.4 printed in the C locale.
  const rows = { pairs: 'b 2\na 1\n' }
  const key = (spec) => createTerminal(rows).run(`sort -k'${spec}' pairs`)

  const SPECS = [
    ['0', "sort: field number is zero: invalid field specification '0'\n"],
    ['0,1', "sort: field number is zero: invalid field specification '0,1'\n"],
    ['1,0', "sort: field number is zero: invalid field specification '1,0'\n"],
    ['0,0', "sort: field number is zero: invalid field specification '0,0'\n"],
    ['+0', "sort: field number is zero: invalid field specification '+0'\n"],
    [' 0', "sort: field number is zero: invalid field specification ' 0'\n"],
    // A zero is read before a letter that has no business being there.
    ['0q', "sort: field number is zero: invalid field specification '0q'\n"],
    ['0.1', "sort: field number is zero: invalid field specification '0.1'\n"],
    ['1,0q', "sort: field number is zero: invalid field specification '1,0q'\n"],
    ['1.0', "sort: character offset is zero: invalid field specification '1.0'\n"],
    ['1.0q', "sort: character offset is zero: invalid field specification '1.0q'\n"],
    ['1.0,2', "sort: character offset is zero: invalid field specification '1.0,2'\n"],
    ['x', "sort: invalid number at field start: invalid count at start of 'x'\n"],
    ['.1', "sort: invalid number at field start: invalid count at start of '.1'\n"],
    [',1', "sort: invalid number at field start: invalid count at start of ',1'\n"],
    ['-1', "sort: invalid number at field start: invalid count at start of '-1'\n"],
    ['1,x', "sort: invalid number after ',': invalid count at start of 'x'\n"],
    ['1,', "sort: invalid number after ',': invalid count at start of ''\n"],
    ['1.x', "sort: invalid number after '.': invalid count at start of 'x'\n"],
    ['1.-1', "sort: invalid number after '.': invalid count at start of '-1'\n"],
    ['1.', "sort: invalid number after '.': invalid count at start of ''\n"],
    ['1x', "sort: stray character in field spec: invalid field specification '1x'\n"],
    ['1z', "sort: stray character in field spec: invalid field specification '1z'\n"],
    ['1q', "sort: stray character in field spec: invalid field specification '1q'\n"],
    ['1,2q', "sort: stray character in field spec: invalid field specification '1,2q'\n"],
    ['1 ', "sort: stray character in field spec: invalid field specification '1 '\n"],
    ['1,2,3', "sort: stray character in field spec: invalid field specification '1,2,3'\n"],
    ['1.1.1', "sort: stray character in field spec: invalid field specification '1.1.1'\n"],
  ]
  for (const [spec, stderr] of SPECS) {
    it(`sort -k${JSON.stringify(spec)}`, () => {
      const r = key(spec)
      assert.deepEqual({ stderr: r.stderr, exitCode: r.exitCode }, { stderr, exitCode: 2 })
      assert.deepEqual(r.unsupported, [])
    })
  }

  it('reads a field count the way strtoul reads one', () => {
    // A leading blank and a `+` both belong to the number, and an end offset
    // of zero ends the key where a key with no end offset ends.
    const sorted = 'a 1\nb 2\n'
    for (const spec of [' 1', '+1', '+1b', ' 1n', '1,2.0', '1n,2r', '2,1']) {
      const r = key(spec)
      assert.deepEqual({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }, { stdout: sorted, stderr: '', exitCode: 0 }, spec)
    }
  })

  it('separates a key GNU has from a key nobody has, and exits alike on both', () => {
    // A modifier GNU knows and a character offset are both things this
    // cannot sort by; a letter GNU does not know is the stray character it
    // calls it. Only what the caller is told differs — sort exits 2 either way.
    for (const [gap, detail] of [['1g', '-k1g'], ['1.2', '-k1.2'], ['1.2b', '-k1.2b']]) {
      const r = key(gap)
      assert.deepEqual(r.unsupported.map((u) => u.detail), [detail], gap)
      assert.equal(r.exitCode, 2, gap)
    }
    assert.equal(key('1z').exitCode, 2)
    assert.equal(createTerminal(rows).run("sort -t'ab' pairs").stderr, "sort: multi-character tab 'ab'\n")
    assert.equal(createTerminal(rows).run("sort -t'ab' pairs").exitCode, 2)
  })

  // coreutils exits 1 when it cannot read the command line at all. `grep`
  // exits 2, and so does awk. This exited 2 for every one of them.
  it('exits the way the tool does when the command line will not read', () => {
    const files = { f: 'hi\n', pairs: 'a 1\n' }
    for (const [command, exitCode] of [
      ['seq', 1], ['cut pairs', 1], ['cut -c1 -f1 pairs', 1], ['tr a', 1], ['which', 1],
      ['basename', 1], ['dirname', 1], ['printf', 1], ['cp f', 1], ['rm', 1], ['realpath', 1],
      ['grep', 2], ['awk', 2],
    ]) {
      const r = createTerminal(files).run(command)
      assert.equal(r.exitCode, exitCode, command)
      assert.notEqual(r.stderr, '', command)
    }
    // The synopsis stands in for GNU's `Try '<tool> --help'`, which this
    // terminal has no --help to offer.
    assert.match(createTerminal(files).run('seq').stderr, /^usage: seq /u)
  })
})

describe('GNU conformance — printf reads its operands the way GNU does', () => {
  // Every diagnostic named the operand bare where GNU names it the way it
  // would have to be written to be handed back — single-quoted, with a quote
  // or a backslash spelled out — and said `invalid number` where GNU says
  // `expected a numeric value`. An operand with nothing in it is zero to
  // strtoimax and was an error here; a binary literal is a number to it and
  // was not; and what follows a character constant is a warning GNU gives and
  // this passed over in silence. Recorded from coreutils 9.4 in the C locale.
  const OPERANDS = [
    ["printf '%d' x", '0', "printf: 'x': expected a numeric value\n", 1],
    ["printf '%d' 3.7", '3', "printf: '3.7': value not completely converted\n", 1],
    ["printf '%d' ''", '0', '', 0],
    ["printf '%f' ''", '0.000000', '', 0],
    ["printf '%d' '   '", '0', "printf: '   ': expected a numeric value\n", 1],
    ["printf '%d' 0b1", '1', '', 0],
    ["printf '%d' 0B11", '3', '', 0],
    ["printf '%d' 0b", '0', "printf: '0b': value not completely converted\n", 1],
    ["printf '%d' 0b12", '1', "printf: '0b12': value not completely converted\n", 1],
    // A binary literal is an integer to strtoimax and nothing to strtod.
    ["printf '%f' 0b1", '0.000000', "printf: '0b1': value not completely converted\n", 1],
    ["printf '%d' 99999999999999999999999", '9223372036854775807', "printf: '99999999999999999999999': Numerical result out of range\n", 1],
    ["printf '%d' \"'ab\"", '97', 'printf: warning: b: character(s) following character constant have been ignored\n', 0],
    ["printf '%d' \"'\"", '0', "printf: '\\'': expected a numeric value\n", 1],
    ["printf '%d' '\"'", '0', 'printf: \'"\': expected a numeric value\n', 1],
    ["printf '%d' \"a'b\"", '0', "printf: 'a\\'b': expected a numeric value\n", 1],
  ]
  for (const [command, stdout, stderr, exitCode] of OPERANDS) {
    it(JSON.stringify(command), () => {
      assert.deepEqual(createTerminal({}).run(command), { stdout, stderr, exitCode, cwd: '/', notes: [], unsupported: [] })
    })
  }

  // `\x` takes up to two hexadecimal digits, `\u` exactly four and `\U`
  // exactly eight. Short of that GNU writes nothing for the escape and stops
  // where it stands, keeping what it had already written — this wrote the
  // text back out and carried on.
  const ESCAPES = [
    ['a\\x41b', 'aAb', '', 0],
    ['a\\x4g', 'a\u0004g', '', 0],
    ['a\\u0041b', 'aAb', '', 0],
    ['a\\U00000041b', 'aAb', '', 0],
    ['a\\z', 'a\\z', '', 0],
    ['a\\', 'a\\', '', 0],
    ['a\\xg', 'a', 'printf: missing hexadecimal number in escape\n', 1],
    ['a\\x', 'a', 'printf: missing hexadecimal number in escape\n', 1],
    ['a\\ug', 'a', 'printf: missing hexadecimal number in escape\n', 1],
    ['a\\u12', 'a', 'printf: missing hexadecimal number in escape\n', 1],
    ['a\\U0000', 'a', 'printf: missing hexadecimal number in escape\n', 1],
    ['a\\xgZZZ', 'a', 'printf: missing hexadecimal number in escape\n', 1],
    ['b\\u0041\\ugX', 'bA', 'printf: missing hexadecimal number in escape\n', 1],
  ]
  for (const [format, stdout, stderr, exitCode] of ESCAPES) {
    it(`printf ${JSON.stringify(format)}`, () => {
      const r = createTerminal({}).run(`printf ${JSON.stringify(format)}`)
      assert.deepEqual({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }, { stdout, stderr, exitCode })
    })
  }
})

describe('GNU conformance — what cut and tr say about a list they cannot read', () => {
  // `cut` names a bad list by what the list is of — fields, or bytes and
  // characters — and by what it could not read in it. This said one thing for
  // all of them, in wording of its own. `tr` named a reversed range its own
  // way too. Recorded from coreutils 9.4 in the C locale; GNU adds a
  // `Try 'cut --help'` line, which this terminal has no --help to back.
  const rows = { pairs: 'a 1\n' }
  const list = (option, spec) => createTerminal(rows).run(`cut -${option} '${spec}' pairs`)

  const LISTS = [
    ['5-2', 'cut: invalid decreasing range', 'cut: invalid decreasing range'],
    ['-0', 'cut: invalid decreasing range', 'cut: invalid decreasing range'],
    ['0', 'cut: byte/character positions are numbered from 1', 'cut: fields are numbered from 1'],
    ['0-2', 'cut: byte/character positions are numbered from 1', 'cut: fields are numbered from 1'],
    ['', 'cut: byte/character positions are numbered from 1', 'cut: fields are numbered from 1'],
    ['1,,', 'cut: byte/character positions are numbered from 1', 'cut: fields are numbered from 1'],
    ['a', "cut: invalid byte/character position 'a'", "cut: invalid field value 'a'"],
    ['a-b', "cut: invalid byte/character position 'a-b'", "cut: invalid field value 'a-b'"],
    // A number that will not read is named from the first character of it
    // that would not, so `1x` is `x`.
    ['1x', "cut: invalid byte/character position 'x'", "cut: invalid field value 'x'"],
    ['1-2-3', 'cut: invalid byte or character range', 'cut: invalid field range'],
    ['-1-2', 'cut: invalid byte or character range', 'cut: invalid field range'],
    ['99999999999999999999', "cut: byte/character offset '99999999999999999999' is too large", "cut: field number '99999999999999999999' is too large"],
    ['1-99999999999999999999', "cut: byte/character offset '99999999999999999999' is too large", "cut: field number '99999999999999999999' is too large"],
  ]
  for (const [spec, positions, fields] of LISTS) {
    it(`cut ${JSON.stringify(spec)}`, () => {
      assert.deepEqual([list('c', spec).stderr, list('c', spec).exitCode], [positions + '\n', 1], spec)
      assert.deepEqual([list('f', spec).stderr, list('f', spec).exitCode], [fields + '\n', 1], spec)
    })
  }

  it('reads the lists GNU reads', () => {
    for (const [spec, stdout] of [['1', 'a\n'], ['2-3', ' 1\n'], ['1-', 'a 1\n'], ['1,3', 'a1\n'], ['3,1', 'a1\n']]) {
      assert.deepEqual([list('c', spec).stdout, list('c', spec).exitCode], [stdout, 0], spec)
    }
  })

  it('names a reversed range and an empty set the way tr names them', () => {
    const run = (command) => createTerminal({}).run(`printf 'abc\\n' | ${command}`)
    assert.equal(run("tr 'c-a' x").stderr, "tr: range-endpoints of 'c-a' are in reverse collating sequence order\n")
    assert.equal(run("tr 'a' ''").stderr, 'tr: when not truncating set1, string2 must be non-empty\n')
    assert.equal(run("tr '' 'a'").stdout, 'abc\n')
    assert.equal(run("tr 'abc' 'x'").stdout, 'xxx\n')
    assert.equal(run("tr 'a-' x").stdout, 'xbc\n')
  })
})
