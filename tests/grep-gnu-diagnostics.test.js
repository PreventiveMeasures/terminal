import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Each row was run through GNU grep 3.11 (C.UTF-8) over the same files on
// disk, and is what it printed: stdout, stderr and the exit status. A walk is
// piped through sort, since GNU walks in directory order.
const FILES = {
  f: 'Ab\nx{\n\\x\nab\n a:b\n',
  p: 'a\n[\n',
  p2: 'x\n(\na\\{1\n',
  g: 'a\0\nax\n',
  'd/a.txt': 'x a\n',
  'd/b.c': 'x b\n',
  'a.txt': 'x c\n',
  'd/e/c.txt': 'x d\n',
}

async function check(command, stdout, stderr, exitCode) {
  const r = await createTerminal(FILES).run(command)
  const actual = { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, unsupported: r.unsupported }
  assert.deepEqual(actual, { stdout, stderr, exitCode, unsupported: [] }, command)
}

const CASES = {
  'a POSIX class name written outside a bracket is an error': [
    [String.raw`grep '[:space:]' f`, '', 'grep: character class syntax is [[:space:]], not [:space:]\n', 2],
    [String.raw`grep -E '[:alpha:]' f`, '', 'grep: character class syntax is [[:space:]], not [:space:]\n', 2],
    [String.raw`grep -c '[[:space:]]' f`, '1\n', '', 0],
    [String.raw`grep '[:a]' f`, 'ab\n a:b\n', '', 0],
    [String.raw`grep 'x[:alpha:]' f`, '', 'grep: character class syntax is [[:space:]], not [:space:]\n', 2],
    [String.raw`grep -F '[:space:]' f`, '', '', 1],
  ],
  'a backslash inside a bracket is a member of it, not an escape': [
    [String.raw`grep -c '[a\]' f`, '3\n', '', 0],
    [String.raw`grep '[\x]' f`, 'x{\n\\x\n', '', 0],
    [String.raw`grep -E '[\{]' f`, 'x{\n\\x\n', '', 0],
    [String.raw`grep -c '[^\]' f`, '5\n', '', 0],
    [String.raw`grep '[\]' f`, '\\x\n', '', 0],
  ],
  'a BRE interval with nothing before it is literal': [
    [String.raw`grep '\{' f`, 'x{\n', '', 0],
    [String.raw`grep 'x\{' f`, '', 'grep: Unmatched \\{\n', 2],
    [String.raw`grep '^\{1\}' f`, '', '', 1],
    [String.raw`grep '\(\{1\}a\)' f`, '', '', 1],
  ],
  'a bad pattern is reported in glibc\'s words, line by line, with warnings': [
    [String.raw`grep 'a\{1' f`, '', 'grep: Unmatched \\{\n', 2],
    [String.raw`grep 'a\{1,0\}' f`, '', 'grep: Invalid content of \\{\\}\n', 2],
    [String.raw`grep '[b-a]' f`, '', 'grep: Invalid range end\n', 2],
    [String.raw`grep -E '(' f`, '', 'grep: Unmatched ( or \\(\n', 2],
    [String.raw`grep -E 'a{1,0}' f`, '', 'grep: Invalid content of \\{\\}\n', 2],
    [String.raw`grep '[' f`, '', 'grep: Invalid regular expression\n', 2],
    [String.raw`grep '[a' f`, '', 'grep: Unmatched [, [^, [:, [., or [=\n', 2],
    [String.raw`grep '[[:foo:]]' f`, '', 'grep: Invalid character class name\n', 2],
    [String.raw`grep 'a\' f`, '', 'grep: Trailing backslash\n', 2],
    [String.raw`grep '\(a\)\2' f`, '', 'grep: Invalid back reference\n', 2],
    [String.raw`grep -E 'a{99999}' f`, '', 'grep: Regular expression too big\n', 2],
    [String.raw`grep -f p f`, '', 'grep: p:2: Invalid regular expression\n', 2],
    [String.raw`grep -f p2 f`, '', 'grep: p2:3: Unmatched \\{\n', 2],
    [String.raw`grep -E -e '(' -e '[' f`, '', 'grep: Unmatched ( or \\(\ngrep: Invalid regular expression\n', 2],
    [String.raw`grep -e a -f p f`, '', 'grep: p:2: Invalid regular expression\n', 2],
    [String.raw`grep -E '*A' f`, 'Ab\n', 'grep: warning: * at start of expression\n', 0],
    [String.raw`grep -E '+A' f`, 'Ab\n', 'grep: warning: + at start of expression\n', 0],
    [String.raw`grep -E 'A|?b' f`, 'Ab\nab\n a:b\n', 'grep: warning: ? at start of expression\n', 0],
    [String.raw`grep -c '[[:alpha:]-z]' f`, '', 'grep: Invalid range end\n', 2],
  ],
  '--include and --exclude match a named file by any trailing part of its name': [
    [String.raw`grep -H x --exclude=a.txt d/a.txt a.txt`, '', '', 1],
    [String.raw`grep --exclude='d/*' x d/a.txt a.txt`, 'a.txt:x c\n', '', 0],
    [String.raw`grep --exclude='*/a.txt' x d/a.txt a.txt`, 'a.txt:x c\n', '', 0],
    [String.raw`grep --exclude=d x d/a.txt a.txt`, 'd/a.txt:x a\na.txt:x c\n', '', 0],
    [String.raw`grep --include='*.c' x d/a.txt d/b.c`, 'd/b.c:x b\n', '', 0],
    [String.raw`grep --exclude='*a.txt' x ./a.txt d/b.c`, 'd/b.c:x b\n', '', 0],
  ],
  '--exclude-dir drops trailing slashes and applies to named directories': [
    [String.raw`grep -r --exclude-dir=d/ x . | sort`, './a.txt:x c\n./f:\\x\n./f:x{\n./p2:x\n', 'grep: ./g: binary file matches\n', 0],
    [String.raw`grep -r --exclude-dir=e x d | sort`, 'd/a.txt:x a\nd/b.c:x b\n', '', 0],
    [String.raw`grep -r --exclude-dir=d x d`, '', '', 1],
    [String.raw`grep -r --exclude-dir=. -l x | sort`, 'a.txt\nd/a.txt\nd/b.c\nd/e/c.txt\nf\ng\np2\n', '', 0],
    [String.raw`grep -r --exclude-dir=d/e -l x . | sort`, './a.txt\n./d/a.txt\n./d/b.c\n./d/e/c.txt\n./f\n./g\n./p2\n', '', 0],
    [String.raw`grep -r --exclude-dir=e/ -l x d | sort`, 'd/a.txt\nd/b.c\n', '', 0],
    [String.raw`grep -r --exclude-dir=e -c x d/e`, '', '', 1],
  ],
  'context and max counts are checked as GNU checks them': [
    [String.raw`grep -A1x x f`, '', 'grep: 1x: invalid context length argument\n', 2],
    [String.raw`grep -B 1x x f`, '', 'grep: 1x: invalid context length argument\n', 2],
    [String.raw`grep -C -1 x f`, '', 'grep: -1: invalid context length argument\n', 2],
    [String.raw`grep -m 1x x f`, '', 'grep: invalid max count\n', 2],
    [String.raw`grep -m -1 x f`, 'x{\n\\x\n', '', 0],
    [String.raw`grep -m1x -A 1 x f`, '', 'grep: invalid max count\n', 2],
    [String.raw`grep -A 1 -m1x x f`, '', 'grep: invalid max count\n', 2],
    [String.raw`grep -A1x -m1x x f`, '', 'grep: 1x: invalid context length argument\n', 2],
    [String.raw`grep --context=x x f`, '', 'grep: x: invalid context length argument\n', 2],
    [String.raw`grep --max-count=y x f`, '', 'grep: invalid max count\n', 2],
  ],
  'option errors, usage and -P errors are GNU grep\'s own': [
    [String.raw`grep`, '', "Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n", 2],
    [String.raw`grep -EF x f`, '', 'grep: conflicting matchers specified\n', 2],
    [String.raw`grep -FP x f`, '', 'grep: conflicting matchers specified\n', 2],
    [String.raw`grep -E -E x f`, 'x{\n\\x\n', '', 0],
    [String.raw`grep -e`, '', "grep: option requires an argument -- 'e'\nUsage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n", 2],
    [String.raw`grep --file`, '', "grep: option '--file' requires an argument\nUsage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n", 2],
    [String.raw`grep --regexp`, '', "grep: option '--regexp' requires an argument\nUsage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n", 2],
    [String.raw`grep --count=3 x f`, '', "grep: option '--count' doesn't allow an argument\nUsage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n", 2],
    [String.raw`grep -E -e`, '', "grep: option requires an argument -- 'e'\nUsage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n", 2],
    [String.raw`grep -P -e a -e b f`, '', 'grep: the -P option only supports a single pattern\n', 2],
    [String.raw`grep -P '(' f`, '', 'grep: missing closing parenthesis\n', 2],
    [String.raw`grep -P 'a)' f`, '', 'grep: unmatched closing parenthesis\n', 2],
    [String.raw`grep -P 'a{2,1}' f`, '', 'grep: numbers out of order in {} quantifier\n', 2],
    [String.raw`grep -P '[a' f`, '', 'grep: missing terminating ] for character class\n', 2],
    [String.raw`grep -P 'a\' f`, '', 'grep: \\ at end of pattern\n', 2],
    [String.raw`grep -P '*' f`, '', 'grep: quantifier does not follow a repeatable item\n', 2],
    [String.raw`grep -P 'a{70000}' f`, '', 'grep: number too big in {} quantifier\n', 2],
    [String.raw`grep -P '[z-a]' f`, '', 'grep: range out of order in character class\n', 2],
    [String.raw`grep -P '(?<n>a)(?<n>b)' f`, '', 'grep: two named subpatterns have the same name (PCRE2_DUPNAMES not set)\n', 2],
    [String.raw`grep -P '\x{110000}' f`, '', 'grep: character code point value in \\x{} or \\o{} is too large\n', 2],
    [String.raw`grep -wP 'a)' f`, '', 'grep: unmatched closing parenthesis\n', 2],
  ],
  '-P reads a \\x with no digits as NUL, as PCRE2 does': [
    [String.raw`grep -cP 'a\x' f`, '0\n', '', 1],
    [String.raw`grep -caP 'a\x' g`, '1\n', '', 0],
    [String.raw`grep -P '\x41' f`, 'Ab\n', '', 0],
    [String.raw`grep -P '\x{62}' f`, 'Ab\nab\n a:b\n', '', 0],
  ],
  'long options, and competing flags settled by the last one': [
    [String.raw`grep --count x f`, '2\n', '', 0],
    [String.raw`grep --ignore-case ab f`, 'Ab\nab\n', '', 0],
    [String.raw`grep --files-with-matches x f a.txt`, 'f\na.txt\n', '', 0],
    [String.raw`grep --files-without-match zzz f`, 'f\n', '', 1],
    [String.raw`grep --line-number --with-filename b f`, 'f:1:Ab\nf:4:ab\nf:5: a:b\n', '', 0],
    [String.raw`grep --no-filename x f a.txt`, 'x{\n\\x\nx c\n', '', 0],
    [String.raw`grep --invert-match --count x f`, '3\n', '', 0],
    [String.raw`grep --word-regexp b f`, ' a:b\n', '', 0],
    [String.raw`grep --line-regexp ab f`, 'ab\n', '', 0],
    [String.raw`grep --only-matching --extended-regexp 'a.' f`, 'ab\na:\n', '', 0],
    [String.raw`grep --fixed-strings '[' f`, '', '', 1],
    [String.raw`grep --basic-regexp 'a\|x' f`, 'x{\n\\x\nab\n a:b\n', '', 0],
    [String.raw`grep --quiet x f`, '', '', 0],
    [String.raw`grep --regexp=Ab --regexp=x f`, 'Ab\nx{\n\\x\n', '', 0],
    [String.raw`grep --after-context=1 Ab f`, 'Ab\nx{\n', '', 0],
    [String.raw`grep --max-count=1 x f`, 'x{\n', '', 0],
    [String.raw`grep -y AB f`, 'Ab\nab\n', '', 0],
    [String.raw`grep -hH x f a.txt`, 'f:x{\nf:\\x\na.txt:x c\n', '', 0],
    [String.raw`grep -Hh x f a.txt`, 'x{\n\\x\nx c\n', '', 0],
    [String.raw`grep -lL x f g`, '', '', 0],
    [String.raw`grep -Ll x f g`, 'f\ng\n', '', 0],
    [String.raw`grep -cl x f`, 'f\n', '', 0],
    [String.raw`grep -lc x f`, 'f\n', '', 0],
    [String.raw`grep -Lc zzz f`, 'f\n', '', 1],
  ],
}

describe('grep answers as GNU grep 3.11 does', () => {
  for (const [title, cases] of Object.entries(CASES)) {
    describe(title, () => {
      for (const [command, stdout, stderr, exitCode] of cases) it(command, () => check(command, stdout, stderr, exitCode))
    })
  }
})

describe("grep refuses where GNU's two matchers read a pattern apart", () => {
  // GNU's dfa drops a leading interval, and glibc's regex, which answers -o
  // and a search with a backreference, reads past its `{`; which one answers
  // depends on the search, so neither is guessed at.
  for (const command of [String.raw`grep -E '{1}A' f`, String.raw`grep -E '^*' f`, String.raw`grep -E 'a|{1}b' f`]) {
    it(command, async () => {
      const r = await createTerminal(FILES).run(command)
      assert.deepEqual(r.unsupported.map((u) => u.detail), ['GNU regex syntax'])
      assert.equal(r.exitCode, 2)
    })
  }
})
