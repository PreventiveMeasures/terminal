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

  // The same shapes plus non-ASCII names, where matching needs a locale.
  wide: {
    a: '1\n', ab: '2\n', 'a b': '3\n', 'a*b': '4\n', 'b.txt': '5\n',
    'μ': 'mu\n', 'aμb': 'amub\n', 'naïve': 'n\n',
  },

  // One long name, for the patterns that used to make the matcher explode.
  long: { ['a'.repeat(30)]: 'x\n', ['dir/' + 'a'.repeat(30)]: 'y\n' },
}
