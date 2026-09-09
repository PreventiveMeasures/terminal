import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Replaying the GNU and Spencer regex corpora leaves one family of
// divergences, and it is not a missing regex feature: these are expressions
// POSIX leaves undefined, which GNU grep 3.11 accepts by reinterpreting the
// stray operator as a literal — printing "warning: * at start of expression"
// for some of them as it does so. Guessing which literal GNU would have
// picked is how an implementation returns a confidently wrong answer, so
// each one is refused with a diagnostic instead. The last two columns are
// what GNU did with the same command — how many of the twelve input lines it
// printed, and its exit status — recorded so the cost of the choice stays
// visible, and so a future implementation has the target to aim at.

const INPUT = 'BADRPT\n*a\na)\n{1\na{b\na]\naaa\nabbbd\nax\nabc\na-c\na]b\n'
const FILES = { input: INPUT }
const run = (command) => createTerminal(FILES).run(command)
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`
const command = (ere, pattern) => `grep ${ere ? '-E ' : ''}-e ${quote(pattern)} input`

// [extended, pattern, diagnostic detail, lines GNU printed, GNU exit]
const A_QUANTIFIER_WITH_NOTHING_TO_REPEAT = [
  [true, '*', 'GNU regex syntax', 12, 0],
  [true, '+', 'GNU regex syntax', 12, 0],
  [true, '?', 'GNU regex syntax', 12, 0],
  [true, '{1}', 'GNU regex syntax', 12, 0],
  [true, '*a', 'GNU regex syntax', 10, 0],
  [true, '**a', 'GNU regex syntax', 10, 0],
  [true, '***a', 'GNU regex syntax', 10, 0],
  [true, '^*', 'GNU regex syntax', 12, 0],
  [true, '^+', 'GNU regex syntax', 12, 0],
  [true, '^?', 'GNU regex syntax', 12, 0],
  [true, '^{1}', 'GNU regex syntax', 12, 0],
  [true, '$*', 'GNU regex syntax', 12, 0],
  [true, '(*a)', 'GNU regex syntax', 10, 0],
  [true, '(+a)', 'GNU regex syntax', 10, 0],
  [true, '(?a)', 'regex extension', 10, 0],
  [true, '({1}a)', 'GNU regex syntax', 10, 0],
  [true, '(a|*b)', 'GNU regex syntax', 10, 0],
  [true, '(a|+b)', 'GNU regex syntax', 10, 0],
  [true, '(a|?b)', 'GNU regex syntax', 10, 0],
  [true, '(a|{1}b)', 'GNU regex syntax', 10, 0],
  [false, '\\(\\{1\\}a\\)', 'GNU regex syntax', 0, 1],
  [false, '^\\{1\\}', 'GNU regex syntax', 0, 1],
]

const AN_UNMATCHED_GROUP_CLOSE = [
  [true, ')', 'GNU regex syntax', 1, 0],
  [true, 'a)', 'GNU regex syntax', 1, 0],
  [true, 'abc)', 'GNU regex syntax', 0, 1],
]

const AN_INTERVAL_THAT_DOES_NOT_PARSE = [
  [true, '{', 'GNU regex syntax', 2, 0],
  [true, '{abc', 'GNU regex syntax', 0, 1],
  [true, '{1', 'GNU regex syntax', 1, 0],
  [true, 'a{b', 'GNU regex syntax', 1, 0],
  [true, 'a{1', 'GNU regex syntax', 0, 1],
  [true, 'a{1a', 'GNU regex syntax', 0, 1],
  [true, 'a{1a}', 'GNU regex syntax', 0, 1],
  [true, 'a{1,x', 'GNU regex syntax', 0, 1],
  [true, 'a{1,x}', 'GNU regex syntax', 0, 1],
  [true, 'a{1,*}', 'GNU regex syntax', 0, 1],
  [true, 'a*{b}', 'GNU regex syntax', 0, 1],
]

const AN_UNMATCHED_BRACKET_CLOSE = [
  [true, 'a]', 'GNU regex syntax', 2, 0],
]

const A_BRACKET_FEATURE_GNU_IMPLEMENTS = [
  [true, 'a[[.x.]]', 'regex collating or equivalence class', 1, 0],
  [true, 'a[[=b=]]c', 'regex collating or equivalence class', 1, 0],
  [true, 'a[[.].]]b', 'regex collating or equivalence class', 1, 0],
  [true, 'a[[.-.]--]c', 'regex collating or equivalence class', 1, 0],
]

const A_BACKREFERENCE_TO_A_REPEATABLE_EMPTY_CAPTURE = [
  [false, 'a\\(\\(b\\)*\\2\\)*d', 'conditional backreference', 1, 0],
]

const AN_ESCAPE_WITH_NO_GNU_MEANING = [
  [true, 'a\\x', 'regex escape', 1, 0],
]

const TOLERATED = [
  ['a quantifier with nothing to repeat', A_QUANTIFIER_WITH_NOTHING_TO_REPEAT],
  ['an unmatched group close', AN_UNMATCHED_GROUP_CLOSE],
  ['an interval that does not parse', AN_INTERVAL_THAT_DOES_NOT_PARSE],
  ['an unmatched bracket close', AN_UNMATCHED_BRACKET_CLOSE],
  ['a bracket feature GNU implements', A_BRACKET_FEATURE_GNU_IMPLEMENTS],
  ['a backreference to a repeatable empty capture', A_BACKREFERENCE_TO_A_REPEATABLE_EMPTY_CAPTURE],
  ['an escape with no GNU meaning', AN_ESCAPE_WITH_NO_GNU_MEANING],
]

// The same operators where POSIX does define them: still answered exactly.
// [extended, pattern, GNU stdout, GNU exit]
const WELL_FORMED = [
  [true, 'a*', 'BADRPT\n*a\na)\n{1\na{b\na]\naaa\nabbbd\nax\nabc\na-c\na]b\n'],
  [true, 'a+', '*a\na)\na{b\na]\naaa\nabbbd\nax\nabc\na-c\na]b\n'],
  [true, 'a?', 'BADRPT\n*a\na)\n{1\na{b\na]\naaa\nabbbd\nax\nabc\na-c\na]b\n'],
  [true, 'a{1}', '*a\na)\na{b\na]\naaa\nabbbd\nax\nabc\na-c\na]b\n'],
  [true, 'a{1,2}', '*a\na)\na{b\na]\naaa\nabbbd\nax\nabc\na-c\na]b\n'],
  [true, '(a|b)', '*a\na)\na{b\na]\naaa\nabbbd\nax\nabc\na-c\na]b\n'],
  [true, '(a)+', '*a\na)\na{b\na]\naaa\nabbbd\nax\nabc\na-c\na]b\n'],
  [true, '^a', 'a)\na{b\na]\naaa\nabbbd\nax\nabc\na-c\na]b\n'],
  [true, 'a$', '*a\naaa\n'],
  [true, '[a-z]', '*a\na)\na{b\na]\naaa\nabbbd\nax\nabc\na-c\na]b\n'],
  [true, '[]a]', '*a\na)\na{b\na]\naaa\nabbbd\nax\nabc\na-c\na]b\n'],
  [true, '[^a]', 'BADRPT\n*a\na)\n{1\na{b\na]\nabbbd\nax\nabc\na-c\na]b\n'],
  [true, 'a[.]b', '', 1],
  [true, 'a\\)', 'a)\n'],
  [true, 'a\\{1', '', 1],
  [true, '[{]', '{1\na{b\n'],
  [true, '[[:alpha:]]', 'BADRPT\n*a\na)\na{b\na]\naaa\nabbbd\nax\nabc\na-c\na]b\n'],
  [false, 'a*', 'BADRPT\n*a\na)\n{1\na{b\na]\naaa\nabbbd\nax\nabc\na-c\na]b\n'],
  [false, 'a\\{1\\}', '*a\na)\na{b\na]\naaa\nabbbd\nax\nabc\na-c\na]b\n'],
  [false, '\\(a\\)\\1', 'aaa\n'],
  [false, '\\(a\\|b\\)', '*a\na)\na{b\na]\naaa\nabbbd\nax\nabc\na-c\na]b\n'],
  [false, 'a\\]', 'a]\na]b\n'],
]

describe('GNU tolerance — malformed expressions are refused, never guessed', () => {
  for (const [title, rows] of TOLERATED) {
    describe(title, () => {
      for (const [ere, pattern, detail, gnuLines, gnuExit] of rows) {
        it(`${ere ? 'ERE' : 'BRE'} ${pattern}`, () => {
          const result = run(command(ere, pattern))
          assert.equal(result.stdout, '', 'a refusal must not also print matches')
          assert.equal(result.exitCode, 2)
          assert.equal(result.unsupported.length, 1, 'the refusal must reach the diagnostic feed')
          assert.equal(result.unsupported[0].detail, detail)
          assert.equal(result.stderr, result.unsupported[0].message + '\n')
          // GNU answered rather than erred, and that answer is the one we
          // decline to guess at. Exit 2 here would make this a shared refusal.
          assert.notEqual(gnuExit, 2, 'GNU treated this as a usable expression')
          assert.notEqual(result.exitCode, gnuExit,
            `GNU printed ${gnuLines} line(s) and exited ${gnuExit}; we refuse instead`)
        })
      }
    })
  }
})

describe('GNU tolerance — the well-formed neighbours still match GNU', () => {
  for (const [ere, pattern, stdout, exitCode = 0] of WELL_FORMED) {
    it(`${ere ? 'ERE' : 'BRE'} ${pattern}`, () => {
      assert.deepEqual(run(command(ere, pattern)),
        { stdout, stderr: '', exitCode, cwd: '/', unsupported: [] })
    })
  }
})
