import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Independent regression cases informed by BusyBox 1.37.0's testsuite/*.tests:
// https://github.com/vda-linux/busybox_mirror/tree/be7d1b7b1701d225379bc1665487ed0871b592a5/testsuite
// Reviewed grep.tests and sed.tests, the two the sibling audit in
// upstream-busybox.test.js does not cover. Upstream is GPLv2; no upstream
// test text is vendored, and the fixture data below is this project's own.
// Every expectation is what GNU grep 3.11 and GNU sed 4.9 printed for the
// same command line, not what this implementation used to do.

const ORCHARD = { input: 'oak\nelm\nfir\noak elm\n' }
const MIXED = { input: 'oak\nOAK\nfir\n' }
const PATTERNS = { input: 'oak\nfir\n', pats: 'oak\nfir\n' }
const WORDS = { input: 'oak\noakwood\nan oak\nstroak\n' }
const PUNCT = { input: 'a/b/c\nfir\n' }
const LEADING = { input: '(oak)\nelm\n' }
const HEX = { input: 'de:ad:be:ef:00:11 tail\n' }
const TREE = { 'grove/a.txt': 'oak\n', 'grove/b.txt': 'elm\n', 'grove/sub/c.txt': 'oak\n' }

// [name, files, command, stdout, exitCode]
const GREP = [
  ['no match exits 1', ORCHARD, 'grep pine input; echo $?', '1\n'],
  ['missing file exits 2', ORCHARD, 'grep oak nosuch 2>/dev/null; echo $?', '2\n'],
  ['-s hides the missing-file error', ORCHARD, 'grep -s oak nosuch; echo $?', '2\n'],
  ['-s still reports a match from another file', ORCHARD, 'grep -s oak nosuch input; echo $?', 'input:oak\ninput:oak elm\n2\n'],
  ['-q is silent on success', ORCHARD, 'grep -q oak input; echo $?', '0\n'],
  ['-q is silent on failure', ORCHARD, 'grep -q pine input; echo $?', '1\n'],
  ['-q wins over a missing file', ORCHARD, 'grep -q oak input nosuch 2>/dev/null; echo $?', '0\n'],
  ['reads standard input', ORCHARD, 'cat input | grep oak', 'oak\noak elm\n'],
  ['a bare dash names standard input', ORCHARD, 'cat input | grep oak -', 'oak\noak elm\n'],
  ['prefixes the name when several files are searched', ORCHARD, 'grep oak input input', 'input:oak\ninput:oak elm\ninput:oak\ninput:oak elm\n'],
  ['a dash and a file are both searched', ORCHARD, 'printf pine | grep -e oak -e pine - input', '(standard input):pine\ninput:oak\ninput:oak elm\n'],
  ['repeated -e patterns', ORCHARD, 'grep -e oak -e fir input', 'oak\nfir\noak elm\n'],
  ['-F takes patterns literally', PUNCT, 'grep -F a/b input', 'a/b/c\n'],
  ['-F leaves a metacharacter literal', PUNCT, 'grep -F a.b input; echo $?', '1\n'],
  ['-Fi folds case', MIXED, 'grep -Fi oak input', 'oak\nOAK\n'],
  ['-f reads patterns from a file', PATTERNS, 'grep -f pats input', 'oak\nfir\n'],
  ['-f reads patterns from standard input', PATTERNS, 'cat pats | grep -f - input', 'oak\nfir\n'],
  ['-v -f inverts a pattern file', PATTERNS, 'grep -v -f pats input; echo $?', '1\n'],
  ['-vxf inverts whole-line pattern matches', PATTERNS, 'grep -vxf pats input; echo $?', '1\n'],
  ['-x demands the whole line', ORCHARD, 'grep -x oak input', 'oak\n'],
  ['-x ignores a line that merely contains the pattern', ORCHARD, 'grep -x elm input; echo $?', 'elm\n0\n'],
  ['-xF combines with literal matching', ORCHARD, 'grep -xF "oak elm" input', 'oak elm\n'],
  ['-x -v -e selects the other lines', ORCHARD, 'grep -x -v -e oak -e fir input; echo $?', 'elm\noak elm\n0\n'],
  ['-w requires word boundaries', WORDS, 'grep -w oak input', 'oak\nan oak\n'],
  ['-Fw applies boundaries to a literal', WORDS, 'grep -Fw oak input', 'oak\nan oak\n'],
  ['-w with a leading anchor', WORDS, 'grep -w "^oak" input', 'oak\n'],
  ['-w with a bare anchor needs a non-word neighbour', WORDS, 'grep -w "^" input; echo $?', '1\n'],
  ['-w with a bare anchor matches a punctuation start', LEADING, 'grep -w "^" input; echo $?', '(oak)\n0\n'],
  ['-w rejects an interior match', WORDS, 'grep -w wood input; echo $?', '1\n'],
  ['-L lists files without a match', ORCHARD, 'grep -L pine input; echo $?', 'input\n1\n'],
  ['-L stays quiet when the file matches', ORCHARD, 'grep -L oak input; echo $?', '0\n'],
  ['-l lists files with a match', ORCHARD, 'grep -l oak input', 'input\n'],
  ['-c counts matching lines', ORCHARD, 'grep -c oak input', '2\n'],
  ['-E accepts unescaped repetition', ORCHARD, 'grep -E "o+ak" input', 'oak\noak elm\n'],
  ['egrep is the extended dialect', ORCHARD, 'egrep "o+ak" input', 'oak\noak elm\n'],
  ['egrep reports failure like grep', ORCHARD, 'egrep pine input; [ $? -ne 0 ] && echo absent', 'absent\n'],
  ['-oE extracts each match', ORCHARD, 'grep -oE "[a-z]+" input', 'oak\nelm\nfir\noak\nelm\n'],
  ['-o with a trailing-context pattern', PUNCT, 'grep -o "[^/]*$" input', 'c\nfir\n'],
  ['-oE with a bracketed interval', HEX, "grep -oE '([[:xdigit:]]{2}:){5}[[:xdigit:]]{2}' input", 'de:ad:be:ef:00:11\n'],
  ['-o on an empty pattern succeeds without printing', ORCHARD, 'grep -o "" input; echo $?', '0\n'],
  ['-r walks a directory', TREE, 'grep -r oak grove | sort', 'grove/a.txt:oak\ngrove/sub/c.txt:oak\n'],
  ['-r on a single file behaves like grep', TREE, 'grep -r oak grove/a.txt', 'oak\n'],
  ['-rl lists the matching files', TREE, 'grep -rl oak grove | sort', 'grove/a.txt\ngrove/sub/c.txt\n'],
]

const TREES = { input: 'oak\nelm\nfir\n' }
const SCRIPTED = { input: 'oak\nelm\nfir\n', prog: 's/oak/pine/\n' }
const NOEOL = { input: 'oak\nelm' }
const NUMS = { input: '1\n2\n3\n4\n5\n' }
const REPEAT = { input: 'oak oak\nelm\n' }
const UPPER = { input: 'OAK\n' }
const ABC = { input: 'abc\n' }
const HELLO = { input: 'hello\n' }
const ATSIGN = { input: '@oak@\n' }
const DIGITS = { input: '9+8=17\n' }
const SLASHED = { input: '/usr/bin\nlocal\n' }
const TABBED = { input: 'oak\telm\n' }
const SPACED = { input: 'oak  \nelm\n' }
const PAIRS = { input: 'one\ntwo\nthree\n' }
const CONT = { input: 'oak \\\nelm\nfir\n' }

const SED = [
  ['an empty script copies input', TREES, "sed '' input", 'oak\nelm\nfir\n'],
  ['an empty script copies standard input', TREES, "cat input | sed ''", 'oak\nelm\nfir\n'],
  ['a script file drives the edit', SCRIPTED, 'sed -f prog input', 'pine\nelm\nfir\n'],
  ['a script file read from standard input', SCRIPTED, 'cat prog | sed -f - input', 'pine\nelm\nfir\n'],
  ['several -e fragments run in order', TREES, 'sed -e s/oak/elm/ -e s/elm/fir/ input', 'fir\nfir\nfir\n'],
  ['independent -e fragments', TREES, 'sed -e s/oak/pine/ -e s/nothing/x/ input', 'pine\nelm\nfir\n'],
  ['a newline separates commands', TREES, "sed 's/oak/elm/\ns/elm/fir/' input", 'fir\nfir\nfir\n'],
  ['a semicolon separates commands', TREES, "sed 's/oak/elm/;s/elm/fir/' input", 'fir\nfir\nfir\n'],
  ['a missing final newline is preserved', NOEOL, "sed 's/elm/fir/' input", 'oak\nfir'],
  ['-n suppresses the automatic print', TREES, 'sed -n s/oak/pine/p input', 'pine\n'],
  ['two files are one stream', TREES, "sed -n '$=' input input", '6\n'],
  ['a file and standard input are one stream', TREES, "cat input | sed -n '$p' input -", 'fir\n'],
  ['a line number selects one record', TREES, "sed -e '1 d' input", 'elm\nfir\n'],
  ['the last-line address', TREES, "sed -n '$p' input", 'fir\n'],
  ['a regular expression address', TREES, 'sed -n /elm/p input', 'elm\n'],
  ['a two-line range', NUMS, "sed -n '2,4p' input", '2\n3\n4\n'],
  ['a range ending at a pattern', NUMS, "sed -n '1,/3/p' input", '1\n2\n3\n'],
  ['a range whose end precedes its start', NUMS, "sed -n '2d;2,1p' input", ''],
  ['a deleted start still opens the range', NUMS, "sed -n '1d;1,3p' input", '2\n3\n'],
  ['a relative range end', NUMS, "sed '/^2/,+2{d}' input", '1\n5\n'],
  ['a relative range of zero lines', NUMS, "sed '/^2/,+0{d}' input", '1\n3\n4\n5\n'],
  ['a relative range without a block', NUMS, "sed '/^2/,+0d' input", '1\n3\n4\n5\n'],
  ['a relative range with -n', NUMS, "sed -n '/2/,+1 p' input", '2\n3\n'],
  ['an empty regular expression reuses the last', TREES, "sed -n '/elm/{//p}' input", 'elm\n'],
  ['a negated address', TREES, "sed -n '2!p' input", 'oak\nfir\n'],
  ['a plain substitution', TREES, 'sed s/oak/pine/ input', 'pine\nelm\nfir\n'],
  ['the global flag', REPEAT, 'sed s/oak/pine/g input', 'pine pine\nelm\n'],
  ['an occurrence number', REPEAT, "sed 's/oak/pine/2' input", 'oak pine\nelm\n'],
  ['an occurrence number then a global', REPEAT, "sed -e 's/oak/pine/2; s/oak/fir/g' input", 'fir pine\nelm\n'],
  ['the print flag with -n', TREES, 'sed -n s/oak/pine/p input', 'pine\n'],
  ['the print flag without -n', TREES, 'sed s/oak/pine/p input', 'pine\npine\nelm\nfir\n'],
  ['the ignore-case flag', UPPER, "sed 's/oak/pine/I' input", 'pine\n'],
  ['an empty match repeats across the line', ABC, "sed 's/z*/-/g' input", '-a-b-c-\n'],
  ['a star that matches nothing', HELLO, "sed 's/l*/@/g' input", '@h@e@o@\n'],
  ['a space delimiter', TREES, "sed 's oak pine ' input", 'pine\nelm\nfir\n'],
  ['an at-sign delimiter', ATSIGN, "sed 's@[@]@-@' input", '-oak@\n'],
  ['a plus delimiter escapes itself', DIGITS, "sed 's+9\\++X+' input", 'X8=17\n'],
  ['an ampersand delimiter', DIGITS, "sed 's&9&X\\&&' input", 'X&+8=17\n'],
  ['a digit delimiter keeps backreferences', DIGITS, "sed 's1\\(9\\)1X\\11' input", 'X1+8=17\n'],
  ['a comma delimiter with an alternation', SLASHED, "sed 's,\\(^/\\|\\)[^/][^/]*,>\\0<,g' input", '>/usr</>bin<\n>local<\n'],
  ['the whole match in the replacement', TREES, "sed 's/oak/[&]/' input", '[oak]\nelm\nfir\n'],
  ['escape zero is the whole match', TREES, "sed -n '/elm/s//[\\0]/p' input", '[elm]\n'],
  ['a capture in the replacement', TREES, "sed 's/\\(o\\)\\(ak\\)/\\2\\1/' input", 'ako\nelm\nfir\n'],
  ['a BRE alternation anchored on one branch', TREES, "sed 's/^o\\|m//g' input", 'ak\nel\nfir\n'],
  ['a tab in the pattern', TABBED, "sed 's/\\t/ /' input", 'oak elm\n'],
  ['a newline in the replacement', TREES, "sed 's/oak/a\\nb/' input", 'a\nb\nelm\nfir\n'],
  ['a carriage return in the replacement', TREES, "sed 's/oak/a\\rb/' input | cat -v", 'a^Mb\nelm\nfir\n'],
  ['a bracket expression with a class', SPACED, "sed 's/[[:space:]]*/,/g' input", ',o,a,k,\n,e,l,m,\n'],
  ['trailing blanks', SPACED, "sed 's/ *$/_/g' input", 'oak_\nelm_\n'],
  ['a bracketed negation with a space delimiter', TREES, "sed 's [^ .]* x g' input", 'x\nx\nx\n'],
  ['an unbalanced bracket in the replacement', TREES, "sed 's/oak/[/' input", '[\nelm\nfir\n'],
  ['append after a match', TREES, "sed '/elm/a pine' input", 'oak\nelm\npine\nfir\n'],
  ['insert before a match', TREES, "sed '/elm/i pine' input", 'oak\npine\nelm\nfir\n'],
  ['change a matched line', TREES, "sed '/elm/c pine' input", 'oak\npine\nfir\n'],
  ['change every line', TREES, 'sed crepl input', 'repl\nrepl\nrepl\n'],
  ['append with a backslash continuation', TREES, "sed -e '/elm/a\\' -e pine input", 'oak\nelm\npine\nfir\n'],
  ['insert and append in one script', PAIRS, "sed -e '/one/a 111' -e '/two/i 222' -e p input", 'one\none\n111\n222\ntwo\ntwo\nthree\nthree\n'],
  ['append text keeps its escapes', PAIRS, "sed '/one/a\\tzero' input | cat -v", 'one\ntzero\ntwo\nthree\n'],
  ['insert text keeps its escapes', PAIRS, "sed '/one/i\\tzero' input | cat -v", 'tzero\none\ntwo\nthree\n'],
  ['transliteration', TREES, "sed 'y/oak/OAK/' input", 'OAK\nelm\nfir\n'],
  ['n prints and refills', PAIRS, "sed -n 'n;p' input", 'two\n'],
  ['N appends the next line', PAIRS, "sed 'N;s/\\n/ /' input", 'one two\nthree\n'],
  ['P prints the first embedded line', PAIRS, "sed -n 'N;P;p' input", 'one\none\ntwo\n'],
  ['N past the last line', NUMS, "sed -n '1{N;N;d};1p;2,3p;3p;4p' input", '4\n'],
  ['a loop that joins every line', PAIRS, "sed ':a;N;s/\\n/ /;ta' input", 'one two three\n'],
  ['an address matching across the join', PAIRS, "sed '/one/N;/one\\ntwo/i joined' input", 'joined\none\ntwo\nthree\n'],
  ['G appends the hold space', TREES, 'sed G input', 'oak\n\nelm\n\nfir\n\n'],
  ['h and G reverse the file', TREES, "sed -n '1!G;h;$p' input", 'fir\nelm\noak\n'],
  ['x exchanges the spaces', TREES, "sed -n 'x;$p' input", 'elm\n'],
  ['H accumulates and x recovers', TREES, "sed -n 'H;${x;s/\\n/,/g;p}' input", ',oak,elm,fir\n'],
  ['D restarts on the remainder', PAIRS, "sed -n 'N;P;D' input", 'one\ntwo\n'],
  ['b jumps to a label', TREES, "sed -e 'b one;p;: one' input", 'oak\nelm\nfir\n'],
  ['a bare b starts the next cycle', TREES, "sed -e 'b;p' input", 'oak\nelm\nfir\n'],
  ['t branches after a substitution', TREES, "sed -e 's/oak/pine/;t one;p;: one;p' input", 'pine\npine\nelm\nelm\nelm\nfir\nfir\nfir\n'],
  ['T branches when none happened', TREES, "sed -e 's/oak/pine/;T none;p;: none;p' input", 'pine\npine\npine\nelm\nelm\nfir\nfir\n'],
  ['a block runs under one address', TREES, "sed -n '/elm/{p;/l/{s/l/L/};p;q}' input", 'elm\neLm\n'],
  ['q stops the stream', TREES, "sed '2q' input", 'oak\nelm\n'],
  ['a label loop over continuations', CONT, "sed ': more; /\\\\$/{ =; N; b more }' input", '1\noak \\\nelm\nfir\n'],
  ['d ends the cycle early', TREES, "sed -e '/elm/d;s/elm/x/p;i here' input", 'here\noak\nhere\nfir\n'],
  ['an unknown label is an error', TREES, "sed -e 'b nowhere' input 2>/dev/null; echo $?", '4\n'],
]

function check(files, command, stdout, exitCode) {
  const terminal = createTerminal(files)
  assert.deepEqual(terminal.run(command), { stdout, stderr: '', exitCode, cwd: '/', unsupported: [] })
}

describe('upstream BusyBox audit — grep', () => {
  for (const [name, files, command, stdout, exitCode = 0] of GREP) {
    it(name, () => check(files, command, stdout, exitCode))
  }
})

describe('upstream BusyBox audit — sed', () => {
  for (const [name, files, command, stdout, exitCode = 0] of SED) {
    it(name, () => check(files, command, stdout, exitCode))
  }
})
