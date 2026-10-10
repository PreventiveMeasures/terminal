// Behaviors where awk here once differed from GNU Awk, each recorded from
// gawk 5.2.1 (stdout, stderr, exit status — run as `awk`) and expected to
// the byte, with nothing reported unsupported. The groups follow the
// findings of the audit against gawk.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { GRAMMAR } from '../src/awk/grammar.js'
import { buildTables } from '../src/awk/lalr.js'

const FILES = {
  'words.txt': 'the cat sat on the mat\nthe dog ate the cat\na b c d e f g h i j k l m n o p\n',
  'nums.txt': '3\n1\n10\n-2\n7\n100\n0\n',
  'a.txt': 'a\n',
  'ab.txt': 'x y\n',
  'prog.awk': 'BEGIN { print "from a file" }\n',
  'noeol.awk': 'BEGIN { x = 1',
  'open.awk': 'function f() {\n',
  'lib/x.awk': 'BEGIN { }\n',
}

const run = (line) => createTerminal(FILES).run(line)

// gawk keeps an array in one of three hash tables by the kind of its first
// subscript, and `for (k in a)` walks the table as it stands: small
// integers in blocks by size, other integers and strings by their hash
// chains. Word counts and group-bys print in this order.
describe("awk as gawk — for (k in a) walks an array in gawk's order", () => {
  for (const [line, stdout, stderr, exitCode] of [
    ["awk '{ for (i = 1; i <= NF; i++) n[$i]++ } END { for (w in n) print w, n[w] }' words.txt", 'h 1\nate 1\non 1\ni 1\nj 1\nk 1\nl 1\nmat 1\nm 1\nthe 4\nn 1\na 1\ncat 2\no 1\nb 1\np 1\nc 1\nsat 1\nd 1\ne 1\nf 1\ng 1\ndog 1\n', '', 0],
    ["awk '{ a[$1] = NR } END { for (k in a) print k, a[k] }' nums.txt", '-2 4\n0 7\n1 2\n3 1\n7 5\n10 3\n100 6\n', '', 0],
    ['awk \'BEGIN { for (i = 1; i <= 20; i++) a[i * 7 % 13]; for (k in a) printf "%s ", k; print "" }\'', '0 1 2 3 4 5 6 7 8 9 10 11 12 \n', '', 0],
    ['awk \'BEGIN { a[-1]; a[-5]; a[3]; a["x"]; a[2.5]; a["07"]; a[1e3]; for (k in a) printf "%s ", k; print "" }\'', 'x 2.5 07 -1 1000 3 -5 \n', '', 0],
    ['awk \'BEGIN { for (i = 0; i < 3000; i++) a[i]; for (i = 0; i < 2990; i++) delete a[i]; for (k in a) printf "%s ", k; print "" }\'', '2990 2991 2992 2993 2994 2995 2996 2997 2998 2999 \n', '', 0],
    ['awk \'BEGIN { for (i = 0; i < 40; i++) a["k" i]; n = 0; for (k in a) printf "%s%s", k, (++n % 10 ? " " : "\\n") }\'', 'k20 k21 k22 k23 k24 k25 k26 k27 k28 k29\nk10 k0 k11 k12 k1 k13 k2 k14 k3 k4\nk15 k5 k16 k30 k6 k17 k31 k7 k18 k32\nk8 k19 k9 k33 k34 k35 k36 k37 k38 k39\n', '', 0],
    ['awk \'BEGIN { a["__proto__"]; a["constructor"]; a["toString"]; a[""]; for (k in a) print "[" k "]" }\'', '[]\n[__proto__]\n[toString]\n[constructor]\n', '', 0],
  ]) {
    it(line, async () => {
      const r = await run(line)
      assert.deepEqual([r.stdout, r.stderr, r.exitCode, r.unsupported], [stdout, stderr, exitCode, []])
    })
  }
})

// random(3) with gawk's 256-byte state and its two-draw doubles; srand()
// returns the seed before it, the first one being 1.
describe("awk as gawk — rand() and srand() are gawk's generator", () => {
  for (const [line, stdout, stderr, exitCode] of [
    ["awk 'BEGIN { print rand(), rand(), rand() }'", '0.924046 0.593909 0.306394\n', '', 0],
    ['awk \'BEGIN { srand(42); print rand(), rand(); printf "%.17g\\n", rand() }\'', '0.24632 0.396143\n0.95507481604080224\n', '', 0],
    ["awk 'BEGIN { print srand(5), srand(6), srand() }'", '1 5 6\n', '', 0],
    ['awk \'BEGIN { srand(-3); print rand(); srand(2.9); print rand(); srand("x"); print rand() }\'', '0.150357\n0.893104\n0.855566\n', '', 0],
    ["awk 'BEGIN { srand(1); a = rand(); srand(1); b = rand(); print (a == b), int(rand() * 100) }'", '1 59\n', '', 0],
  ]) {
    it(line, async () => {
      const r = await run(line)
      assert.deepEqual([r.stdout, r.stderr, r.exitCode, r.unsupported], [stdout, stderr, exitCode, []])
    })
  }
})

// The right side of an assignment is evaluated before the subscript or
// field on its left; a field past NF is unassigned (it compares equal to
// "" as well as to 0); `$0 = 30` keeps a number; NF keeps what it is set
// to; $0 is rebuilt when it is next read, with the CONVFMT of then.
describe("awk as gawk — assignment, fields and records behave as gawk's", () => {
  for (const [line, stdout, stderr, exitCode] of [
    ["awk 'BEGIN { i = 5; a[i++] = i; for (k in a) print k, a[k] }'", '5 5\n', '', 0],
    ["echo 'a b c' | awk '{ i = 1; $(i++) = i; print; print i }'", '1 b c\n2\n', '', 0],
    ['echo a | awk \'$2 == 0 { print "zero" } $2 == "" { print "empty" } { print typeof($2), length($2) }\'', 'empty\nunassigned 0\n', '', 0],
    ["awk 'BEGIN { $0 = 3 * 10; print ($0 > 9), typeof($0) }'", '1 number\n', '', 0],
    ["echo 'a b c' | awk '{ NF = 2.7; print NF; print }'", '2.7\na b\n', '', 0],
    ['echo \'a b\' | awk \'{ CONVFMT = "%.2g"; $1 = 3.14159; CONVFMT = "%.6g"; print }\'', '3.14159 b\n', '', 0],
    ["echo 'a b' | awk '{ $3 = 0.1; OFS = \"-\"; print; $1 = $1; print }'", 'a b 0.1\na-b-0.1\n', '', 0],
    ['echo a | awk \'{ sub(/x/, "y", $3); print NF "[" $0 "]" }\'', '3[a]\n', '', 0],
    ['awk \'BEGIN { CONVFMT = "%d"; a[12.7]; for (k in a) print k; x = 0.5; print (x "") }\'', '12\n0\n', '', 0],
    ['awk -v \'x=a\\\' \'BEGIN { print "[" x "]" }\'', '[a]\n', '', 0],
    ['awk \'BEGIN { print close("/dev/null"), close("nothing"); print "x" > "/dev/null"; print close("/dev/null") }\'', '-1 -1\n0\n', '', 0],
    ["awk 'BEGIN { print typeof(u), typeof(a[1]), typeof(a), typeof($0) }'", 'untyped untyped array unassigned\n', '', 0],
  ]) {
    it(line, async () => {
      const r = await run(line)
      assert.deepEqual([r.stdout, r.stderr, r.exitCode, r.unsupported], [stdout, stderr, exitCode, []])
    })
  }
})

// Read with gawk's own grammar: an assignment may be the right operand of
// `&&`, `||`, `~` and a comparison; `getline` may be concatenated; a regex
// may start a statement after `if (...)`; parameters may take the names of
// gawk's extensions.
describe('awk as gawk — what gawk accepts, it runs', () => {
  for (const [line, stdout, stderr, exitCode] of [
    ['awk \'BEGIN { n = split("a1b22c", p, /[0-9]+/, s); print n, p[1], p[3], s[1], s[2] }\'', '3 a c 1 22\n', '', 0],
    ['awk \'function f(a) { print "f", a } BEGIN { f(1, 2) }\'', 'f 1\n', "awk: cmd. line:1: warning: function `f' called with more arguments than declared\n", 0],
    ['echo \'BEGIN { print "stdin program" }\' | awk -f -', 'stdin program\n', '', 0],
    ['echo \'BEGIN { print "dev stdin" }\' | awk -f /dev/stdin -f prog.awk', 'dev stdin\nfrom a file\n', '', 0],
    ["awk 'BEGIN { a = 1; b = 0; x = a && b = 5; print x, b; y = 0 || z = 2; print y, z; print 1 < w = 2, w }'", '1 5\n1 2\n1 2\n', '', 0],
    ["awk 'BEGIN { if (1) /x/ ? n++ : m++; print n + 0, m + 0 }'", '0 1\n', '', 0],
    // An exit in BEGINFILE ends the reading: no later operand is opened.
    ['awk \'BEGINFILE { print FILENAME; if (FILENAME == "a.txt") exit 3; print "AFTER" } END { print "end" }\' a.txt ab.txt', 'a.txt\nend\n', '', 3],
    ["echo 'foo bar' | awk '{ print $1 getline, $0 }'", 'foo0 foo bar\n', '', 0],
    ["awk 'BEGIN { $-x++; print x }'", '1\n', '', 0],
    ["awk 'BEGIN { x = 1 ; while (x < 3) x++; print x }'", '3\n', '', 0],
    ["awk 'BEGIN { print length() length }'", '00\n', '', 0],
    ["awk 'function g(switch) { return switch * 2 } BEGIN { print g(21) }'", '42\n', '', 0],
    ['awk \'BEGIN { printf "%s\\n", 1.1 ^ 2 }\'', '1.21\n', '', 0],
  ]) {
    it(line, async () => {
      const r = await run(line)
      assert.deepEqual([r.stdout, r.stderr, r.exitCode, r.unsupported], [stdout, stderr, exitCode, []])
    })
  }
})

// Syntax errors show the line and a caret where gawk's parser stopped, with
// whatever gawk said on the way there; errors gawk reads on past are
// listed, and the program does not run (exit 1).
describe("awk as gawk — what gawk rejects, it rejects with gawk's words", () => {
  for (const [line, stdout, stderr, exitCode] of [
    ['awk \'BEGIN { print index("abc", /b/) }\'', '', 'awk: cmd. line:1: fatal: index: regexp constant as second argument is not allowed\n', 2],
    ["awk 'function f(NR) { } BEGIN { }'", '', "awk: cmd. line:1: error: function `f': cannot use special variable `NR' as a function parameter\n", 1],
    ["awk 'function f() { } BEGIN { f = 1 }'", '', "awk: cmd. line:1: error: function `f' called with space between name and `(',\nor used as a variable or an array\n", 1],
    ["awk 'BEGIN { x = length(y); y[1] = 1 }'", '', "awk: cmd. line:1: fatal: attempt to use scalar `y' as an array\n", 2],
    ['awk \'BEGIN { getline x < ""; print "after" }\'', '', "awk: cmd. line:1: fatal: expression for `<' redirection has null string value\n", 2],
    ["awk 'BEGIN { (a) = 2 }'", '', 'awk: cmd. line:1: BEGIN { (a) = 2 }\nawk: cmd. line:1:             ^ syntax error\n', 1],
    ["awk 'BEGIN { $x++ = 2 }'", '', 'awk: cmd. line:1: BEGIN { $x++ = 2 }\nawk: cmd. line:1:                  ^ cannot assign a value to the result of a field post-increment expression\n', 1],
    ["awk 'BEGIN { x = 3 a /= 2; print x }'", '', 'awk: cmd. line:1: BEGIN { x = 3 a /= 2; print x }\nawk: cmd. line:1:                  ^ unterminated regexp\n', 1],
    ["awk 'BEGIN { print $ $ getline 2 }'", '', 'awk: cmd. line:1: BEGIN { print $ $ getline 2 }\nawk: cmd. line:1:                   ^ syntax error\n', 1],
    ["awk 'BEGIN continue { print 1 }'", '', "awk: cmd. line:1: error: `continue' is not allowed outside a loop\nawk: cmd. line:1: BEGIN continue { print 1 }\nawk: cmd. line:1:       ^ syntax error\n", 1],
    ["awk 'BEGIN { while (x) { i++ } break }'", '', "awk: cmd. line:1: error: `break' is not allowed outside a loop or switch\n", 1],
    ["awk 'BEGIN { while (i < 3 #c\n) i++ }'", '', 'awk: cmd. line:2: BEGIN { while (i < 3 #c\nawk: cmd. line:2:                      ^ syntax error\n', 1],
    ["awk 'BEGIN }'", '', 'awk: cmd. line:1: BEGIN blocks must have an action part\nawk: cmd. line:1: BEGIN }\nawk: cmd. line:1:       ^ syntax error\n', 1],
    ["awk 'BEGIN { x = 1 } BEGIN { next; print 1 }'", '', "awk: cmd. line:1: error: `next' used in BEGIN action\n", 1],
    ['awk \'BEGIN { sub(/a/, "b", (x)) }\'', '', 'awk: cmd. line:1: BEGIN { sub(/a/, "b", (x)) }\nawk: cmd. line:1:                          ^ sub third parameter is not a changeable object\n', 1],
    ["awk 'BEGIN { printf() }'", '', 'awk: cmd. line:1: BEGIN { printf() }\nawk: cmd. line:1:                ^ syntax error\n', 1],
    ["awk 'BEGIN { print /re/ ~ $0 }' a.txt", '1\n', "awk: cmd. line:1: warning: regular expression on left of `~' or `!~' operator\n", 0],
    ["awk 'function f(a) { } BEGIN { f(/x/) }'", '', 'awk: cmd. line:1: warning: regexp constant for parameter #1 yields boolean value\n', 0],
    ["awk '\nBEGIN { x = \"abc'", '', 'awk: cmd. line:2: \nBEGIN { x = "abc\nawk: cmd. line:2:              ^ unterminated string\n', 1],
    ['awk -f noeol.awk', '', 'awk: noeol.awk:1: (END OF FILE)\nawk: noeol.awk:1:             ^ source files / command-line arguments must contain complete functions or rules\n', 1],
    ['awk -f open.awk', '', 'awk: open.awk:1: (END OF FILE)\nawk: open.awk:1: ^ source files / command-line arguments must contain complete functions or rules\n', 1],
    ['awk -f lib', '', "awk: lib:1: error: cannot read source file `lib': Is a directory\n", 1],
    ["awk -v 1x=3 'BEGIN { }'", '', "awk: fatal: `1x' is not a legal variable name\n", 2],
    ["awk 'BEGIN { printf; }'", '', 'awk: cmd. line:1: fatal: printf: no arguments\n', 2],
    ['awk', '', "Usage: awk [POSIX or GNU style options] -f progfile [--] file ...\nUsage: awk [POSIX or GNU style options] [--] 'program' file ...\nPOSIX options:\t\tGNU long options: (standard)\n\t-f progfile\t\t--file=progfile\n\t-F fs\t\t\t--field-separator=fs\n\t-v var=val\t\t--assign=var=val\nShort options:\t\tGNU long options: (extensions)\n\t-b\t\t\t--characters-as-bytes\n\t-c\t\t\t--traditional\n\t-C\t\t\t--copyright\n\t-d[file]\t\t--dump-variables[=file]\n\t-D[file]\t\t--debug[=file]\n\t-e 'program-text'\t--source='program-text'\n\t-E file\t\t\t--exec=file\n\t-g\t\t\t--gen-pot\n\t-h\t\t\t--help\n\t-i includefile\t\t--include=includefile\n\t-I\t\t\t--trace\n\t-l library\t\t--load=library\n\t-L[fatal|invalid|no-ext]\t--lint[=fatal|invalid|no-ext]\n\t-M\t\t\t--bignum\n\t-N\t\t\t--use-lc-numeric\n\t-n\t\t\t--non-decimal-data\n\t-o[file]\t\t--pretty-print[=file]\n\t-O\t\t\t--optimize\n\t-p[file]\t\t--profile[=file]\n\t-P\t\t\t--posix\n\t-r\t\t\t--re-interval\n\t-s\t\t\t--no-optimize\n\t-S\t\t\t--sandbox\n\t-t\t\t\t--lint-old\n\t-V\t\t\t--version\n\nTo report bugs, use the `gawkbug' program.\nFor full instructions, see the node `Bugs' in `gawk.info'\nwhich is section `Reporting Problems and Bugs' in the\nprinted version.  This same information may be found at\nhttps://www.gnu.org/software/gawk/manual/html_node/Bugs.html.\nPLEASE do NOT try to report bugs by posting in comp.lang.awk,\nor by using a web forum such as Stack Overflow.\n\ngawk is a pattern scanning and processing language.\nBy default it reads standard input and writes standard output.\n\nExamples:\n\tawk '{ sum += $1 }; END { print sum }' file\n\tawk -F: '{ print $1 }' /etc/passwd\n", 1],
  ]) {
    it(line, async () => {
      const r = await run(line)
      assert.deepEqual([r.stdout, r.stderr, r.exitCode, r.unsupported], [stdout, stderr, exitCode, []])
    })
  }
})

// A fatal error names the program line and, once input has been read,
// (FILENAME=... FNR=...).
describe("awk as gawk — diagnostics carry gawk's place in the input", () => {
  for (const [line, stdout, stderr, exitCode] of [
    ["awk '{ print 1 / $1 }' ab.txt", '', 'awk: cmd. line:1: (FILENAME=ab.txt FNR=1) fatal: division by zero attempted\n', 2],
    ["echo 0 | awk '{ print 1 / $1 }'", '', 'awk: cmd. line:1: (FILENAME=- FNR=1) fatal: division by zero attempted\n', 2],
    ["awk 'END { print 1 / x }' ab.txt", '', 'awk: cmd. line:1: (FILENAME=ab.txt FNR=1) fatal: division by zero attempted\n', 2],
    ["awk '{ x = sqrt(-1) }' ab.txt", '', 'awk: cmd. line:1: (FILENAME=ab.txt FNR=1) warning: sqrt: received negative argument -1\n', 0],
    ['awk \'{ print substr("abc", 2) }\n{ print 1 / 0 }\' ab.txt', '', 'awk: cmd. line:2: error: division by zero attempted\n', 1],
  ]) {
    it(line, async () => {
      const r = await run(line)
      assert.deepEqual([r.stdout, r.stderr, r.exitCode, r.unsupported], [stdout, stderr, exitCode, []])
    })
  }
})

// toupper() maps what has a single-character upper case (ß has none);
// a regex warning is given once a run, in every run.
describe('awk as gawk — case-mapping and regex warnings', () => {
  for (const [line, stdout, stderr, exitCode] of [
    ['awk \'BEGIN { print toupper("straße"), tolower("ÀÉÎ") }\'', 'STRAßE àéî\n', '', 0],
    ['awk \'BEGIN { print ("q" ~ /\\q/) }\'', '1\n', "awk: cmd. line:1: warning: regexp escape sequence `\\q' is not a known regexp operator\n", 0],
    ['awk \'BEGIN { print ("q" ~ /\\q/), ("q" ~ "\\\\q") }\'', '1 1\n', "awk: cmd. line:1: warning: regexp escape sequence `\\q' is not a known regexp operator\n", 0],
  ]) {
    it(line, async () => {
      const r = await run(line)
      assert.deepEqual([r.stdout, r.stderr, r.exitCode, r.unsupported], [stdout, stderr, exitCode, []])
    })
  }
})

describe('awk as gawk — the parser', () => {
  // The tables gawk 5.2.1's Bison built from its grammar have 356 states;
  // these are built the same way from the same grammar.
  it('builds the tables Bison builds for gawk', () => {
    const tables = buildTables(GRAMMAR)
    assert.equal(tables.actions.length, 356)
    assert.equal(tables.rules.length, 209)
  })

  // A regex warning is gawk's once a run: a second run, in this terminal or
  // another, gives it again.
  it('warns about a regex in every run that compiles it', async () => {
    const line = "awk 'BEGIN { print (\"q\" ~ /\\q/) }'"
    const stderr = "awk: cmd. line:1: warning: regexp escape sequence `\\q' is not a known regexp operator\n"
    const t = createTerminal({})
    for (const r of [await t.run(line), await t.run(line), await createTerminal({}).run(line)]) assert.deepEqual([r.stdout, r.stderr], ['1\n', stderr])
  })
})
