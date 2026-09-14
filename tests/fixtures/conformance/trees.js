// Fixture trees for the conformance corpus. A corpus line selects one with
// `@tree <name>`; keeping them here is what lets the corpus files stay one
// line per case. Names are deliberately awkward — hidden files, glob
// metacharacters inside a name, mixed case, spaces, a nested directory —
// because that is where a matcher or a path walker goes wrong.

export const TREES = {
  // A handful of short records, the default for text-command cases.
  trees: { input: 'oak\nelm\nfir\n' },
  orchard: { input: 'oak\nelm\nfir\noak elm\n' },
  repeat: { input: 'oak oak\nelm\n' },
  nums: { input: '1\n2\n3\n4\n5\n' },
  pairs: { input: 'one\ntwo\nthree\n' },
  noeol: { input: 'oak\nelm' },
  scripted: { input: 'oak\nelm\nfir\n', prog: 's/oak/pine/\n' },
  patterns: { input: 'oak\nfir\n', pats: 'oak\nfir\n' },
  words: { input: 'oak\noakwood\nan oak\nstroak\n' },
  mixed: { input: 'oak\nOAK\nfir\n' },
  punct: { input: 'a/b/c\nfir\n' },
  leading: { input: '(oak)\nelm\n' },
  hex: { input: 'de:ad:be:ef:00:11 tail\n' },
  spaced: { input: 'oak  \nelm\n' },
  tabbed: { input: 'oak\telm\n' },
  slashed: { input: '/usr/bin\nlocal\n' },
  digits: { input: '9+8=17\n' },
  atsign: { input: '@oak@\n' },
  abc: { input: 'abc\n' },
  hello: { input: 'hello\n' },
  upper: { input: 'OAK\n' },
  cont: { input: 'oak \\\nelm\nfir\n' },

  // Subjects for the regex corpus: one line per shape a pattern might hit.
  regex: { input: 'BADRPT\n*a\na)\n{1\na{b\na]\naaa\nabbbd\nax\nabc\na-c\na]b\n' },

  // A directory tree for grep -r and find.
  grove: { 'grove/a.txt': 'oak\n', 'grove/b.txt': 'elm\n', 'grove/sub/c.txt': 'oak\n' },

  // The glob tree: every classic mistake has a name here.
  glob: {
    a: '1\n', ab: '2\n', abc: '3\n', 'a.txt': '4\n', 'ab.txt': '5\n',
    'b.txt': '6\n', 'A.txt': '7\n', B: '8\n', 1: 'one\n', 2: 'two\n', 10: 'ten\n',
    'a-b': 'dash\n', 'a]b': 'rbracket\n', 'a*b': 'star\n', 'a?b': 'question\n',
    'a b': 'space\n', 'a.b.c': 'dots\n', '.hidden': 'h\n', '.h2': 'h2\n',
    'dir/x.txt': 'x\n', 'dir/y': 'y\n', 'dir/sub/z.txt': 'z\n', '.dotdir/inside': 'i\n',
  },

  // A source tree the way ripgrep meets one: nested directories, dot-named
  // entries at two depths, a name that begins with two dots, and a sibling
  // sharing a directory's name.
  searched: {
    'a.txt': 'oak tree\nelm\nOAK\noak\n', 'README.md': 'no match here\n',
    'sub/b.js': 'const oak = 1\noak oak\n', 'sub/deep/c.md': '# oak\n',
    'sub/other.txt': 'elm only\n', 'd/x.txt': 'oak in d\n', 'd.txt': 'oak sibling\n',
    'words.txt': 'oak\noakland\nan-oak-tree\noak_bar\n', 'no-nl.txt': 'oak',
    'blank.txt': 'oak\n\n\noak\n', 'empty.txt': '',
    '.hidden': 'oak hidden\n', '.dot/e.txt': 'oak dotdir\n', 'sub/.h/f.txt': 'oak deep hidden\n',
    '..odd/g.txt': 'oak odd\n',
  },

  // ASCII files beside one accented and one CJK file. Literal matching crosses
  // scripts unchanged; case folding and the character classes do not, and the
  // refusal covers the whole run rather than the file that provoked it.
  scripts: {
    'a.txt': 'oak\nOAK\n', 'sub/b.js': 'oak here\n',
    'acc.txt': 'café\nCAFÉ\ncafe\n', 'cjk.txt': '日本語\n漢字\n',
  },

  // The same shapes plus non-ASCII names, where matching needs a locale.
  wide: {
    a: '1\n', ab: '2\n', 'a b': '3\n', 'a*b': '4\n', 'b.txt': '5\n',
    'μ': 'mu\n', 'aμb': 'amub\n', 'naïve': 'n\n',
  },


  // Pairs of files for the diff corpus: every shape a hunk can take, lines
  // that differ only in whitespace or case, a last line with no newline, a
  // NUL that makes a file binary, and names that need quoting in a header.
  pair: {
    ten: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n', ten2: 'a\nb\nX\nd\ne\nf\ng\nh\nY\nj\n', ten3: 'a\nb\nX\nd\ne\nf\ng\nh\ni\nY\n',
    ins: 'a\nb\nc\nNEW\nd\ne\nf\ng\nh\ni\nj\n', del: 'a\nb\nd\ne\nf\ng\nh\ni\nj\n', rep: 'a\nb\nP\nQ\nR\nd\ne\nf\ng\nh\ni\nj\n',
    app: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n', a1: 'a\n', a2: 'a', empty: '', x1: 'x\n',
    twelve: '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n', twelve2: '1\n2\nX\n4\n5\nY\n7\n8\n9\n10\n11\n12\n', twelve3: '1\n2\nX\n4\n5\n6\nY\n8\n9\n10\n11\n12\n',
    f1: 'int main() {\n  int a;\n  int b;\n  int c;\n  int d;\n  int e;\n  return 0;\n}\nvoid other() {\n  x;\n  y;\n  z;\n  w;\n  v;\n}\n',
    f2: 'int main() {\n  int a;\n  int b;\n  int c;\n  int d;\n  int E;\n  return 0;\n}\nvoid other() {\n  x;\n  y;\n  z;\n  W;\n  v;\n}\n',
    g1: 'function_with_a_very_long_name_indeed_exceeding_forty_chars(a, b) {\n  x\n  y\n  z\n  q\n}\n', g2: 'function_with_a_very_long_name_indeed_exceeding_forty_chars(a, b) {\n  x\n  y\n  z\n  Q\n}\n',
    h1: 'abc   \n1\n2\n3\n4\n5\n', h2: 'abc   \n1\n2\n3\n4\n5x\n',
    w1: ' a  b \n', w2: 'a b\n', w3: 'a b\n', w4: 'a  b\n', w5: 'a b  \n', w6: 'ab\n', wt: 'a\t b\n',
    i1: 'ABC\n', i2: 'abc\n', iu: 'É\n', il: 'é\n',
    cr1: 'a\r\nb\r\n', cr2: 'a\nc\n', cr3: 'a\nb\n',
    bin1: 'bin\0ary\n', bin2: 'bin\0aryx\n', bin3: 'bin\0ary\n', bn1: 'x\0', bn3: 'x\0\n',
    wc1: 'a  b\nc\nd\n', wc2: 'a b\nc\nD\n',
    'sp ace': 'q\n', 'sp ace2': 'r\n', 'ta\tb': 't\n', 'quo"te': 's\n', 'back\\slash': 'r\n', "apos'": 't\n',
    '-dash': 'd\n', dashed: 'e\n', blank1: 'a\n\n\nb\n', blank2: 'a\nb\n',
    big: '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n20\n21\n22\n23\n24\n25\n26\n27\n28\n29\n30\n',
    big2: '1\n2\n3\n4\nNEW1\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\ntwenty\n21\n22\n23\n24\n25\n26\n27\n28\n29\n30\n',
  },

  // Two directory trees for diff -r: a file only on one side, a directory
  // only on one side, a name that is a file here and a directory there,
  // hidden entries, a binary pair, a nested difference, and a space in a name.
  dirs: {
    'd1/same': 'same\n', 'd2/same': 'same\n', 'd1/diff': 'one\n', 'd2/diff': 'two\n', 'd1/only-in-1': 'x\n', 'd2/only-in-2': 'y\n',
    'd1/sub/f': 'a\n', 'd2/sub/f': 'b\n', 'd1/bin': 'bin\0ary\n', 'd2/bin': 'bin\0aryx\n', 'd1/fd': 'fileordir\n', 'd2/fd/inner': 'z\n',
    'd1/.hidden': '.h1\n', 'd2/.hidden': '.h2\n', 'd1/Zed': 'Z\n', 'd2/Zed': 'Z2\n', 'd1/sub/deep/x': 'deep1\n', 'd2/sub/deep/x': 'deep2\n',
    'd1/only1/inside': 'i\n', 'd2/only2/inside': 'j\n', 'd1/sub/only-sub-1': 's\n', 'd2/sub/only-sub-2': 't\n', 'd1/sp ace': 'u\n', 'd2/sp ace': 'v\n',
    'd1/same2': 'k\n', 'd2/same2': 'k\n', 'e1/x/f': 'a\n', 'e2/keep': '1\n', 'e1/keep': '1\n', 'f1/a': 'a\n', 'f2/a': 'b\n',
  },

  // Flat files for the patch corpus, which runs in the overlay: targets in
  // several states, and patches that were written by hand to be awkward.
  patchable: {
    ten: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n', ten2: 'a\nb\nX\nd\ne\nf\ng\nh\nY\nj\n', ten3: 'a\nb\nX\nd\ne\nf\ng\nh\ni\nY\n',
    ins: 'a\nb\nc\nNEW\nd\ne\nf\ng\nh\ni\nj\n', del: 'a\nb\nd\ne\nf\ng\nh\ni\nj\n',
    big: '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n20\n21\n22\n23\n24\n25\n26\n27\n28\n29\n30\n',
    big2: '1\n2\n3\n4\nNEW1\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\ntwenty\n21\n22\n23\n24\n25\n26\n27\n28\n29\n30\n',
    ne1: 'a\nb\nc', ne2: 'a\nb\nc\n', ne3: 'a\nb\nd', emp: '', wf: 'a\nb\n', wf3: 'a\nb\nc\n', wfz: 'z\na\nb\n', ws: 'a  b\nc\n',
    partial: 'x\ny\nz\n', blank: 'a\n\nc\n', ex: 'x\n', rv: 'a\nB\nc\n', rv0: 'a\nb\nc\n', rv2: 'a\nB\nc\nd\ne\n', rv3: 'x\na\nB\nc\n', rv4: 'a\nq\nc\n',
    mf1: 'x\n', goner: 'gone\n', oldn: '1\n2\n', newn: '1\n2\n', nn: 'a\nb',
    'create.patch': '--- /dev/null\n+++ b/newf\n@@ -0,0 +1,2 @@\n+one\n+two\n',
    'delete.patch': '--- a/goner\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n',
    'epoch.patch': '--- a/epochf\t1970-01-01 00:00:00.000000000 +0000\n+++ b/epochf\t2026-01-01 00:00:00.000000000 +0000\n@@ -0,0 +1 @@\n+hello\n',
    'git.patch': 'diff --git a/ten b/ten\nindex 1234567..89abcde 100644\n--- a/ten\n+++ b/ten\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n',
    'gnew.patch': 'diff --git a/gnew b/gnew\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/gnew\n@@ -0,0 +1 @@\n+hi\n',
    'gren.patch': 'diff --git a/ten b/renamed\nsimilarity index 90%\nrename from ten\nrename to renamed\n--- a/ten\n+++ b/renamed\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n',
    'gren2.patch': 'diff --git a/ten b/renamed2\nsimilarity index 100%\nrename from ten\nrename to renamed2\n',
    'ws.patch': '--- ws\n+++ ws\n@@ -1,2 +1,2 @@\n a b\n-c\n+C\n',
    'mf.patch': '--- mf1\n+++ mf1\n@@ -1 +1 @@\n-x\n+X\n--- mfnone\n+++ mfnone\n@@ -1 +1 @@\n-q\n+Q\n',
    'rv.patch': '--- rv\n+++ rv\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n',
    'rv2.patch': '--- rv2\n+++ rv2\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -5 +5 @@\n-e\n+E\n',
    'oldnew.patch': '--- oldn\n+++ newn\n@@ -1 +1 @@\n-1\n+ONE\n',
    'index.patch': 'Index: ten\n===================================================================\n--- ten\n+++ ten\n@@ -1 +1 @@\n-a\n+A\n',
    'short1.patch': '--- big\n+++ big\n@@ -1,3 +1,2 @@\n 1\n-2\n', 'short2.patch': '--- big\n+++ big\n@@ -1,3 +1,3 @@\n 1\n-2\n+TWO\n', 'short3.patch': '--- big\n+++ big\n@@ -1,4 +1,4 @@\n 1\n-2\n+TWO\n',
    'bad1.patch': '--- big\n+++ big\n@@ -1,3 +1,3 @@\n', 'bad2.patch': '--- big\n+++ big\n@@ -1,3 +1,3 @@\n 1\n', 'bad3.patch': '--- big\n+++ big\n@@ -1,2 +1,2 @@\n 1\n 2\n',
    'bad4.patch': '--- big\n+++ big\n@@ -1,3 +1,2 @@\n 1\n-2\n+TWO\n 3\n', 'bad5.patch': '--- big\n+++ big\n@@ -1,2 +1,3 @@\n 1\n-2\n+TWO\n 3\n', 'bad6.patch': '--- big\n+++ big\n@@ bogus @@\n 1\n',
    'extra.patch': '--- big\n+++ big\n@@ -1,2 +1,2 @@\n 1\n-2\n+TWO\n 3\n 4\n', 'noplus.patch': '--- big\n@@ -1 +1 @@\n-1\n+ONE\n',
    'blank.patch': '--- blank\n+++ blank\n@@ -1,3 +1,3 @@\n a\n\n-c\n+C\n', 'blankctx.patch': '--- ten\n+++ ten\n@@ -1,3 +1,3 @@\n\n-b\n+B\n c\n',
    'ctx1.patch': '*** big\n--- big\n***************\n*** 1,2 ****\n! 1\n  2\n--- 1,2 ----\n! ONE\n  2\n', 'ctx2.patch': '*** big\n--- big\n***************\n*** 1 ****\n! 1\n--- 1 ----\n! ONE\n',
    'ctxmiss1.patch': '*** big\n--- big\n***************\n*** 1,3 ****\n--- 1,4 ----\n  1\n  2\n+ NEW\n  3\n', 'ctxmiss2.patch': '*** big\n--- big\n***************\n*** 1,3 ****\n  1\n- 2\n  3\n--- 1,2 ----\n',
    'end1.patch': '--- big\n+++ big\n@@ -28,3 +28,3 @@\n 28\n-29\n+X\n 30\n', 'end2.patch': '--- big\n+++ big\n@@ -27,3 +27,3 @@\n 27\n-29\n+X\n 30\n',
    'start1.patch': '--- big\n+++ big\n@@ -1,3 +1,3 @@\n 0\n-2\n+X\n 3\n', 'start2.patch': '--- big\n+++ big\n@@ -2,3 +2,3 @@\n 1\n-3\n+X\n 4\n', 'start3.patch': '--- big\n+++ big\n@@ -1,2 +1,2 @@\n-1\n+X\n 2\n',
    'start4.patch': '--- big\n+++ big\n@@ -3,2 +3,2 @@\n-1\n+X\n 2\n', 'start5.patch': '--- big\n+++ big\n@@ -5,2 +5,2 @@\n-1\n+X\n 2\n',
    'emp1.patch': '--- emp\n+++ emp\n@@ -0,0 +1 @@\n+x\n', 'emp2.patch': '--- emp\n+++ emp\n@@ -1 +1 @@\n-q\n+x\n', 'emp3.patch': '--- /dev/null\n+++ emp\n@@ -0,0 +1 @@\n+x\n',
    'wf.patch': '--- wf\n+++ wf\n@@ -1,2 +1,2 @@\n-a\n-b\n+c\n+d\n', 'ex.patch': '--- /dev/null\n+++ ex\n@@ -0,0 +1 @@\n+x\n', 'pd.patch': '--- a/partial\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n',
    'nn.patch': '2c2\n< b\n\\ No newline at end of file\n---\n> B\n\\ No newline at end of file\n',
  },

  // One long name, for the patterns that used to make the matcher explode.
  long: { ['a'.repeat(30)]: 'x\n', ['dir/' + 'a'.repeat(30)]: 'y\n' },
}
