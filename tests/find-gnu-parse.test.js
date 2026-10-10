import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Each line was run by findutils 4.9 over the same tree, and the answer here is
// the one it gave: the predicates it has, the ones it does not, the messages it
// reads a malformed expression with, and the operators it builds them into.
const SOURCES = { 'a.txt': 'hello\n', 'dir/g.js': 'g\n', 'dir/sub/f.js': 'f\n' }
const CASES = [
  ["find . --name a.txt", "", "find: unknown predicate `--name'\n", 1],
  ["find . --print -maxdepth 0", "", "find: unknown predicate `--print'\n", 1],
  ["find a.txt --and -print", "", "find: unknown predicate `--and'\n", 1],
  ["find a.txt --type f", "", "find: unknown predicate `--type'\n", 1],
  ["find a.txt --exec echo {} \\;", "", "find: unknown predicate `--exec'\n", 1],
  ["find a.txt -foo", "", "find: unknown predicate `-foo'\n", 1],
  ["find a.txt ---noop", "", "find: unknown predicate `---noop'\n", 1],
  ["find a.txt -name", "", "find: missing argument to `-name'\n", 1],
  ["find a.txt -name a -o", "", "find: expected an expression after '-o'\n", 1],
  ["find a.txt -o -name a", "", "find: invalid expression; you have used a binary operator '-o' with nothing before it.\n", 1],
  ["find a.txt !", "", "find: expected an expression after '!'\n", 1],
  ["find a.txt -not", "", "find: expected an expression after '-not'\n", 1],
  ["find a.txt -name a.txt -not", "", "find: expected an expression after '-not'\n", 1],
  ["find a.txt -name a.txt -a", "", "find: expected an expression after '-a'\n", 1],
  ["find a.txt \\( -name a.txt", "", "find: invalid expression; I was expecting to find a ')' somewhere but did not see one.\n", 1],
  ["find a.txt \\( \\)", "", "find: invalid expression; empty parentheses are not allowed.\n", 1],
  ["find a.txt \\( -name a.txt \\) \\)", "", "find: you have too many ')'\n", 1],
  ["find a.txt -name a.txt \\)", "", "find: you have too many ')'\n", 1],
  ["find a.txt \\( ! \\)", "", "find: expected an expression between '!' and ')'\n", 1],
  ["find a.txt \\( -name a -o \\)", "", "find: expected an expression between '-o' and ')'\n", 1],
  ["find a.txt -print -o", "", "find: invalid expression\n", 1],
  ["find a.txt -print -a", "", "find: invalid expression\n", 1],
  ["find a.txt -print \\)", "", "find: you have too many ')'\n", 1],
  ["find a.txt -print \\( \\)", "", "find: invalid expression; empty parentheses are not allowed.\n", 1],
  ["find a.txt -print !", "", "find: invalid expression\n", 1],
  ["find a.txt \\( -print", "", "find: invalid expression; I was expecting to find a ')' somewhere but did not see one.\n", 1],
  ["find a.txt -type", "", "find: missing argument to `-type'\n", 1],
  ["find a.txt -type x", "", "find: Unknown argument to -type: x\n", 1],
  ["find a.txt -type ''", "", "find: Arguments to -type should contain at least one letter\n", 1],
  ["find a.txt -type f,", "", "find: Last file type in list argument to -type is missing, i.e., list is ending on: ','\n", 1],
  ["find a.txt -type f,f", "", "find: Duplicate file type 'f' in the argument list to -type.\n", 1],
  ["find a.txt -type fd", "", "find: Must separate multiple arguments to -type using: ','\n", 1],
  ["find a.txt -type D", "", "find: -type D is not supported because Solaris doors are not supported on the platform find was compiled on.\n", 1],
  ["find a.txt -type f,x", "", "find: Unknown argument to -type: x\n", 1],
  ["find a.txt -maxdepth", "", "find: missing argument to `-maxdepth'\n", 1],
  ["find a.txt -maxdepth -1", "", "find: Expected a positive decimal integer argument to -maxdepth, but got ‘-1’\n", 1],
  ["find a.txt -maxdepth x", "", "find: Expected a positive decimal integer argument to -maxdepth, but got ‘x’\n", 1],
  ["find a.txt -maxdepth 99999999999", "", "find: 99999999999: Numerical result out of range\n", 1],
  ["find a.txt -maxdepth 2147483648", "", "find: 2147483648: Numerical result out of range\n", 1],
  ["find a.txt -mindepth +1", "", "find: Expected a positive decimal integer argument to -mindepth, but got ‘+1’\n", 1],
  ["find a.txt -maxdepth 01 -print", "a.txt\n", "", 0],
  ["find a.txt -size", "", "find: missing argument to `-size'\n", 1],
  ["find a.txt -size ''", "", "find: invalid null argument to -size\n", 1],
  ["find a.txt -size x", "", "find: invalid -size type `x'\n", 1],
  ["find a.txt -size 1x", "", "find: invalid -size type `x'\n", 1],
  ["find a.txt -size k", "", "find: Invalid argument `k' to -size\n", 1],
  ["find a.txt -size +k", "", "find: Invalid argument `+k' to -size\n", 1],
  ["find a.txt -size ++1", "", "", 0],
  ["find a.txt -size +-1", "", "find: Invalid argument `+-1' to -size\n", 1],
  ["find a.txt -size ' 1'", "a.txt\n", "", 0],
  ["find a.txt -size 99999999999999999999", "", "find: Invalid argument `99999999999999999999' to -size\n", 1],
  ["find a.txt -size 18446744073709551615c", "", "", 0],
  ["find a.txt -size 1a1", "", "find: Invalid argument `1a1' to -size\n", 1],
  ["find a.txt -exec", "", "find: missing argument to `-exec'\n", 1],
  ["find a.txt -exec echo", "", "find: missing argument to `-exec'\n", 1],
  ["find a.txt -exec \\;", "", "find: invalid argument `;' to `-exec'\n", 1],
  ["find a.txt -exec +", "", "find: missing argument to `-exec'\n", 1],
  ["find a.txt -exec echo {} {} +", "", "find: Only one instance of {} is supported with -exec ... +\n", 1],
  ["find a.txt -exec echo a{}b +", "", "find: In ‘-exec ... {} +’ the ‘{}’ must appear by itself, but you specified ‘a{}b’\n", 1],
  ["find a.txt -exec echo {}x {} +", "", "find: Only one instance of {} is supported with -exec ... +\n", 1],
  ["find a.txt -exec echo + \\;", "+\n", "", 0],
  ["find a.txt -exec echo {} + -print", "a.txt\na.txt\n", "", 0],
  ["find a.txt -name a foo", "", "find: paths must precede expression: `foo'\n", 1],
  ["find . -name a.txt dir", "", "find: paths must precede expression: `dir'\nfind: possible unquoted pattern after predicate `-name'?\n", 1],
  ["find . -name a.txt dir nope", "", "find: paths must precede expression: `dir'\nfind: possible unquoted pattern after predicate `-name'?\n", 1],
  ["find a.txt , -print", "a.txt\n", "find: ‘,’: No such file or directory\n", 1],
  ["find a.txt -print , -print", "a.txt\na.txt\n", "", 0],
  ["find a.txt -false , -print", "a.txt\n", "", 0],
  ["find a.txt -true -print", "a.txt\n", "", 0],
  ["find a.txt -false -o -print", "a.txt\n", "", 0],
  ["find a.txt ! -false", "a.txt\n", "", 0],
  ["find a.txt -not -not -print", "a.txt\n", "", 0],
  ["find a.txt -wholename a.txt", "a.txt\n", "", 0],
  ["find a.txt -iwholename A.TXT", "a.txt\n", "", 0],
  ["find -P a.txt", "a.txt\n", "", 0],
  ["find -P -P a.txt -print", "a.txt\n", "", 0],
  ["find -- a.txt", "a.txt\n", "", 0],
  ["find -- -P", "", "find: unknown predicate `-P'\n", 1],
  ["find a.txt -depth -print", "a.txt\n", "", 0],
  ["find a.txt -d -print", "a.txt\n", "", 0],
  ["find a.txt -maxdepth 0 -o -print", "", "", 0],
  ["find a.txt -mindepth 0 -mindepth 1", "", "", 0],
  ["find dir -mindepth 1 -maxdepth 1 -name 'g*' -o -name sub", "dir/g.js\ndir/sub\n", "", 0],
  ["find dir -name sub -prune , -print", "dir\ndir/g.js\ndir/sub\n", "", 0],
  ["find dir \\( -name sub -o -name g.js \\) -print", "dir/g.js\ndir/sub\n", "", 0],
  ["find dir ! \\( -name sub -o -name g.js \\)", "dir\ndir/sub/f.js\n", "", 0],
  ["find dir -name sub -a -print -o -print0", "dir\u0000dir/g.js\u0000dir/sub\ndir/sub/f.js\u0000", "", 0],
  ["find a.txt -", "a.txt\n", "find: ‘-’: No such file or directory\n", 1],
  ["find a.txt !x", "a.txt\n", "find: ‘!x’: No such file or directory\n", 1],
  ["find a.txt -name a.txt -name", "", "find: missing argument to `-name'\n", 1],
  ["find a.txt -exec echo {} \\; -name", "", "find: missing argument to `-name'\n", 1],
  ["find nope -name", "", "find: missing argument to `-name'\n", 1],
]

describe('find reads its command line as findutils 4.9 does', () => {
  for (const [command, stdout, stderr, exitCode] of CASES) {
    it(command, async () => {
      const result = await createTerminal(SOURCES).run(command)
      assert.deepEqual([result.stdout, result.stderr, result.exitCode, result.unsupported], [stdout, stderr, exitCode, []])
    })
  }

  // GNU has these and this find does not, which is a gap rather than a typo.
  for (const [command, detail] of [['find a.txt -mtime 1', '-mtime'], ['find a.txt -type b,c,p,s', '-type b,c,p,s'], ['find -L a.txt', '-L']]) {
    it(command + ' is refused as a gap', async () => {
      const result = await createTerminal(SOURCES).run(command)
      assert.equal(result.exitCode, 1)
      assert.deepEqual(result.unsupported.map((u) => u.detail), [detail])
    })
  }
})
