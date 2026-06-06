import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createTerminal } from '@preventive/terminal'

const SOURCES = {
  'src/foo.js': 'const x = 1\n// TODO: fix\nconst y = 2\n',
  'src/bar.js': 'export function bar() {}\n// TODO: doc this\n',
  'src/util/log.js': 'export function log(s) { console.log(s) }\n',
  'README.md': '# Hello\n\nA project.\n',
  '.hidden': 'secret\n',
}

describe('createTerminal — basics', () => {
  it('starts at /', () => {
    const t = createTerminal(SOURCES)
    assert.equal(t.cwd(), '/')
    assert.equal(t.run('pwd').stdout, '/\n')
  })

  it('opts.cwd is normalized: relative, trailing-slash, and "." all resolve to absolute', () => {
    assert.equal(createTerminal(SOURCES, { cwd: 'src' }).cwd(), '/src')
    assert.equal(createTerminal(SOURCES, { cwd: '/src/' }).cwd(), '/src')
    assert.equal(createTerminal(SOURCES, { cwd: '/src/util/..' }).cwd(), '/src')
    assert.throws(() => createTerminal(SOURCES, { cwd: '/nope' }), /not a directory/u)
  })

  it('cd updates cwd; cd to a missing dir errors', () => {
    const t = createTerminal(SOURCES)
    assert.equal(t.run('cd src').exitCode, 0)
    assert.equal(t.cwd(), '/src')
    assert.equal(t.run('cd nope').exitCode, 1)
    assert.match(t.run('cd nope').stderr, /not a directory/u)
  })

  it('cd .. and cd / behave', () => {
    const t = createTerminal(SOURCES)
    t.run('cd src/util')
    assert.equal(t.cwd(), '/src/util')
    t.run('cd ..')
    assert.equal(t.cwd(), '/src')
    t.run('cd /')
    assert.equal(t.cwd(), '/')
  })

  it('ls shows dirs first with trailing slash; -a includes dotfiles', () => {
    const t = createTerminal(SOURCES)
    const plain = t.run('ls').stdout
    assert.match(plain, /^src\/\nREADME\.md\n$/u)
    const all = t.run('ls -a').stdout
    assert.ok(all.includes('.hidden'))
  })

  it('ls -1 is accepted and produces the same one-per-line output as bare ls', () => {
    // No TTY notion in this virtual terminal, so ls is always
    // one-per-line. `-1` exists for script-compat: tools that
    // defensively prefix `-1` shouldn't trip "unknown option".
    const t = createTerminal(SOURCES)
    assert.equal(t.run('ls -1').stdout, t.run('ls').stdout)
    // Composes with the existing -a / -l flags via bundling, both
    // when `1` leads the bundle and when it trails.
    assert.equal(t.run('ls -1a').stdout, t.run('ls -a').stdout)
    assert.equal(t.run('ls -1l').stdout, t.run('ls -l').stdout)
    assert.equal(t.run('ls -a1').stdout, t.run('ls -a').stdout)
    assert.equal(t.run('ls -la1').stdout, t.run('ls -la').stdout)
  })

  it('ls is one-per-line whenever its output reaches a pipe (direct, subshell, or group)', () => {
    // Pin pipe-target behavior NOW so a future "table output when
    // interactive" ls has to deliberately preserve pipe semantics.
    // All three forms should produce the same bytes as the explicit
    // `ls -1 | cat`, regardless of how the output route is shaped.
    const t = createTerminal(SOURCES)
    const baseline = t.run('ls -1 | cat').stdout
    assert.equal(t.run('ls | cat').stdout, baseline, 'direct pipe')
    assert.equal(t.run('(ls) | cat').stdout, baseline, 'subshell pipe')
    // Two ls'es inside the subshell — exercises that group stdout
    // concatenates through the pipe (each ls produces the baseline,
    // so the cat downstream sees baseline + baseline). Catches a
    // future regression where group stdout would, say, get a
    // terminator inserted between steps or columns get rebuilt.
    assert.equal(t.run('(ls; ls) | cat').stdout, baseline + baseline, 'subshell+sequence pipe')
  })

  it('ls -- -1 treats `-1` as a literal filename (terminator honored)', () => {
    // The pre-parseArgs `-1` strip would otherwise silently drop a
    // literal `-1` filename — leaking abstraction. After `--`,
    // every following token must reach parseArgs/lsTarget as-is.
    const t = createTerminal(SOURCES)
    const r = t.run('ls -- -1')
    assert.equal(r.exitCode, 1)
    assert.match(r.stderr, /-1: no such file/u)
  })

  it('ls -10 / -123 (pure-digit shorts) stay positional, matching head -5 shorthand', () => {
    // Mixed bundles like `-1a` get their `1` stripped because the
    // intent is clearly "POSIX -1 + other flags". Pure-digit tokens
    // are NOT bundle-shaped — parseArgs's `^-\d` guard already
    // classifies them as positional. ls then tries to read them as
    // filenames and reports "no such file" rather than mangling
    // them into a malformed flag set.
    const t = createTerminal(SOURCES)
    assert.match(t.run('ls -10').stderr, /-10: no such file/u)
    assert.match(t.run('ls -123').stderr, /-123: no such file/u)
  })

  it('ls -1 -1 is idempotent (multiple -1 flags collapse to a no-op)', () => {
    const t = createTerminal(SOURCES)
    assert.equal(t.run('ls -1 -1').stdout, t.run('ls').stdout)
  })

  it('ls routes per-target "no such file" to stderr (not stdout) on partial failure', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('ls src nope')
    assert.equal(r.exitCode, 1)
    assert.match(r.stderr, /nope: no such file/u)
    // The successful target's listing must stay clean — no error
    // text leaks into stdout, so downstream pipes get clean data.
    assert.doesNotMatch(r.stdout, /no such file/u)
    assert.match(r.stdout, /foo\.js/u)
  })

  it('ls -R walks a tree in DFS pre-order with per-directory headers', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('ls -R src')
    assert.equal(r.exitCode, 0)
    // GNU's order: list a dir, then descend before moving to siblings.
    // src has util/ (only subdir), so the expected blocks are
    //   src:        util/ bar.js foo.js
    //   src/util:   log.js
    assert.equal(r.stdout, 'src:\nutil/\nbar.js\nfoo.js\n\nsrc/util:\nlog.js\n')
  })

  it('ls -R defaults to . and shows the root header even with no subdirs', () => {
    // Single-target case where the dir HAS subdirs (.) still labels
    // the root explicitly — GNU's -R always identifies each dir.
    const t = createTerminal(SOURCES)
    const r = t.run('ls -R')
    assert.equal(r.exitCode, 0)
    assert.match(r.stdout, /^\.:\n/u)
    assert.match(r.stdout, /^\.\/src:\n/mu)
    assert.match(r.stdout, /^\.\/src\/util:\n/mu)
  })

  it('ls -R skips hidden dirs by default; -Ra descends into them', () => {
    // Build a fixture with a hidden directory so we can confirm
    // recursion respects the same dotfile rule as the flat listing.
    const sources = {
      'a.txt': 'a\n',
      '.secret/b.txt': 'b\n',
    }
    const t = createTerminal(sources)
    const r = t.run('ls -R')
    assert.doesNotMatch(r.stdout, /secret/u)
    const ra = t.run('ls -Ra')
    assert.match(ra.stdout, /^\.\/\.secret:$/mu)
    assert.match(ra.stdout, /b\.txt/u)
  })

  it('ls -R on a single file target passes the file through (no header, no recursion)', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('ls -R README.md')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'README.md\n')
  })

  it('ls -R composes with -l (long format applies to every listed dir)', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('ls -lR src')
    assert.equal(r.exitCode, 0)
    // Headers still appear; rows in each block carry the long-format prefix.
    assert.match(r.stdout, /^src:$/mu)
    assert.match(r.stdout, /^src\/util:$/mu)
    assert.match(r.stdout, /^d\s+0\s+util\/$/mu)
    assert.match(r.stdout, /^-\s+\d+\s+log\.js$/mu)
  })
})

describe('createTerminal — text commands', () => {
  it('cat reads files; missing file errors', () => {
    const t = createTerminal(SOURCES)
    assert.equal(t.run('cat README.md').stdout, '# Hello\n\nA project.\n')
    assert.equal(t.run('cat nope').exitCode, 1)
  })

  it('reading a directory reports "is a directory" rather than "no such file"', () => {
    // Matches GNU cat / head / tail: the path exists, it's just
    // not a file. Affects every command that goes through
    // readFilesFor (cat, grep, head, tail, wc).
    const t = createTerminal(SOURCES)
    const r = t.run('cat src')
    assert.equal(r.exitCode, 1)
    assert.match(r.stderr, /is a directory/u)
    assert.doesNotMatch(r.stderr, /no such file/u)
    // Same for head and wc — confirms the helper, not just cat.
    assert.match(t.run('head src').stderr, /is a directory/u)
    assert.match(t.run('wc src').stderr, /is a directory/u)
  })

  it('multi-file: an unreadable operand does not discard the readable files', () => {
    // Regression: readFilesFor used to abort on the first missing/dir
    // path, throwing away output for the valid files — so
    // `cat a missing b | sort` silently produced nothing. Now valid
    // files are emitted, the bad path errors on stderr, and exit is
    // non-zero (matching coreutils' partial-failure behavior).
    const t = createTerminal({ 'a.txt': 'AAA\n', 'b.txt': 'BBB\n', 'dir/inner.txt': 'x\n' })
    const r = t.run('cat a.txt missing.txt b.txt')
    assert.equal(r.stdout, 'AAA\nBBB\n')
    assert.match(r.stderr, /missing\.txt: no such file or directory/u)
    assert.equal(r.exitCode, 1)
    // The pipeline that used to come up empty now carries the data.
    assert.equal(t.run('cat a.txt missing.txt b.txt | sort').stdout, 'AAA\nBBB\n')
    // A directory operand is reported too, without dropping the files.
    const d = t.run('cat a.txt dir b.txt')
    assert.equal(d.stdout, 'AAA\nBBB\n')
    assert.match(d.stderr, /dir: is a directory/u)
    assert.equal(d.exitCode, 1)
  })

  it('multi-file partial failure spans wc / head / sort / cut; all-missing stays empty', () => {
    const t = createTerminal({ 'a.txt': 'AAA\nzzz\n', 'b.txt': 'BBB\n' })
    // wc still tallies the readable files (with a total) and exits 1.
    const w = t.run('wc -l a.txt missing.txt b.txt')
    assert.match(w.stdout, /a\.txt/u)
    assert.match(w.stdout, /b\.txt/u)
    assert.match(w.stdout, /total/u)
    assert.equal(w.exitCode, 1)
    // head keeps its `==>` headers for the files it could read.
    const h = t.run('head -n1 a.txt missing.txt b.txt')
    assert.match(h.stdout, /==> a\.txt <==\nAAA/u)
    assert.match(h.stdout, /==> b\.txt <==\nBBB/u)
    assert.equal(h.exitCode, 1)
    assert.equal(t.run('sort a.txt missing.txt b.txt').stdout, 'AAA\nBBB\nzzz\n')
    assert.equal(t.run('cut -c1 a.txt missing.txt').stdout, 'A\nz\n')
    // When every operand is unreadable, stdout is empty (no stray
    // newline) and exit is non-zero.
    const all = t.run('wc m1 m2')
    assert.equal(all.stdout, '')
    assert.equal(all.exitCode, 1)
  })

  it('grep keeps scanning readable files past an unreadable one (exit 2)', () => {
    const t = createTerminal({ 'a.txt': 'AAA\n', 'b.txt': 'BBB\n' })
    const r = t.run('grep A a.txt missing.txt b.txt')
    assert.match(r.stdout, /a\.txt:AAA/u)
    assert.match(r.stderr, /missing\.txt: no such file or directory/u)
    // GNU grep exits 2 when an error occurs, outranking the 0/1 match status.
    assert.equal(r.exitCode, 2)
  })

  it('grep finds matches and -n prefixes line numbers', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('grep TODO src/foo.js')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, '// TODO: fix\n')
    const numbered = t.run('grep -n TODO src/foo.js').stdout
    assert.equal(numbered, '2:// TODO: fix\n')
  })

  it('grep across multiple files prefixes filename; no match returns exit 1', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('grep TODO src/foo.js src/bar.js')
    assert.match(r.stdout, /^src\/foo\.js:\/\/ TODO: fix\nsrc\/bar\.js:\/\/ TODO: doc this\n$/u)
    assert.equal(t.run('grep ZZZ src/foo.js').exitCode, 1)
  })

  it('grep -r walks a directory tree and prefixes every match with the file', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('grep -r TODO src')
    assert.equal(r.exitCode, 0)
    const lines = r.stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(lines, ['src/bar.js:// TODO: doc this', 'src/foo.js:// TODO: fix'])
  })

  it('grep -r defaults to . and shows filenames relative to cwd', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('grep -r TODO')
    assert.equal(r.exitCode, 0)
    // Defaults to '.'; both matching files appear with no leading '/'.
    assert.match(r.stdout, /^src\/bar\.js:/mu)
    assert.match(r.stdout, /^src\/foo\.js:/mu)
    assert.doesNotMatch(r.stdout, /^\/src/mu)
  })

  it('grep -r forces the filename prefix even on a single named file', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('grep -r fix src/foo.js')
    assert.match(r.stdout, /^src\/foo\.js:/u)
  })

  it('grep -r exits 1 with no output when nothing matches', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('grep -r ZZZZZ src')
    assert.equal(r.exitCode, 1)
    assert.equal(r.stdout, '')
  })

  it('grep -r errors on a missing starting path (exit 2 — grep\'s canonical "error" code)', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('grep -r TODO nope')
    // POSIX exit 2 is grep's "an error occurred" status — distinct
    // from 1 ("no match"). Pinning it explicitly catches a
    // regression that collapsed both into 1.
    assert.equal(r.exitCode, 2)
    assert.match(r.stderr, /no such file or directory/u)
  })

  it('grep -r combines with -i and -n', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('grep -irn todo src')
    assert.equal(r.exitCode, 0)
    assert.match(r.stdout, /^src\/foo\.js:2:\/\/ TODO: fix$/mu)
    assert.match(r.stdout, /^src\/bar\.js:2:\/\/ TODO: doc this$/mu)
  })

  it('grep -R behaves like -r (GNU dereference-recursive alias)', () => {
    const t = createTerminal(SOURCES)
    const lower = t.run('grep -r TODO src')
    const upper = t.run('grep -R TODO src')
    assert.equal(upper.exitCode, lower.exitCode)
    assert.equal(upper.stdout, lower.stdout)
    assert.equal(upper.stderr, lower.stderr)
  })

  it('grep usage line documents PATTERN and [PATH...] (covers -r dirs and -e form)', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('grep')
    assert.notEqual(r.exitCode, 0)
    // PATTERN is required (or supplied via -e); both forms must be
    // mentioned. `[PATH...]` (not `[FILE...]`) so the docs cover
    // recursive directory traversal under -r.
    assert.match(r.stderr, /PATTERN/u)
    assert.match(r.stderr, /-e PATTERN/u)
    assert.match(r.stderr, /\[PATH\.\.\.\]/u)
    assert.doesNotMatch(r.stderr, /\[FILE\.\.\.\]/u)
  })

  it('grep -F matches a literal pattern with regex metacharacters', () => {
    // The original failure from PR #38: `Function(` was rejected
    // as an unterminated group. With -F the `(` is escaped and
    // grep finds the literal substring.
    const t = createTerminal({ 'src/calls.js': 'foo()\nFunction(arg)\nbar\n' })
    const r = t.run('grep -F "Function(" src/calls.js')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'Function(arg)\n')
  })

  it('grep -F treats `*` / `.` / `[` as literal characters', () => {
    const t = createTerminal({ 'src/x.js': 'a.b\na*b\na[b\nxyz\n' })
    assert.equal(t.run('grep -F a.b src/x.js').stdout, 'a.b\n')
    assert.equal(t.run('grep -F a*b src/x.js').stdout, 'a*b\n')
    assert.equal(t.run('grep -F "a[b" src/x.js').stdout, 'a[b\n')
  })

  it('grep -F composes with -i and -w', () => {
    const t = createTerminal({ 'src/x.js': 'Function(x)\nmyFunction(y)\nfunction(z)\n' })
    // -F + -i: case-insensitive literal.
    assert.match(t.run('grep -Fi "FUNCTION(" src/x.js').stdout, /^Function\(x\)$/mu)
    // -F + -w: word-boundary literal — `myFunction(` should NOT match
    // when the search is `Function(` with -w (word boundary before F).
    const w = t.run('grep -Fw "Function(" src/x.js')
    assert.match(w.stdout, /^Function\(x\)$/mu)
    assert.doesNotMatch(w.stdout, /myFunction/u)
  })

  it('grep default = BRE: regex metacharacters are literal', () => {
    // The reason BRE is the default: auditors typing `function(arg)`
    // expect a literal match, not a regex syntax error. Same for
    // `+`, `?`, `|`, `{`, `}` — all literal in BRE.
    const t = createTerminal({ 'src/x.js': 'Function(arg)\na+b\nfoo|bar\nx?y\n' })
    assert.equal(t.run('grep "Function(arg)" src/x.js').stdout, 'Function(arg)\n')
    assert.equal(t.run('grep "a+b" src/x.js').stdout, 'a+b\n')
    assert.equal(t.run('grep "foo|bar" src/x.js').stdout, 'foo|bar\n')
    assert.equal(t.run('grep "x?y" src/x.js').stdout, 'x?y\n')
  })

  it('grep default = BRE: backslashed `\\(` `\\|` `\\+` `\\?` are the metachar forms', () => {
    // The escaping is INVERTED from ES: in BRE the backslash turns
    // a literal into a metachar (group, alternation, repetition).
    const t = createTerminal({ 'src/x.js': 'apple\nbanana\nab\naab\nax\n' })
    // \(apple\|banana\) — alternation inside a group.
    assert.match(t.run('grep "\\(apple\\|banana\\)" src/x.js').stdout, /apple\nbanana/u)
    // a\+b — one-or-more `a` then `b`.
    const plus = t.run('grep "a\\+b" src/x.js').stdout.split('\n').filter(Boolean)
    assert.deepEqual(plus.sort(), ['aab', 'ab'])
    // a\?x — optional `a` then `x`.
    assert.match(t.run('grep "a\\?x" src/x.js').stdout, /ax/u)
  })

  it('grep -E (ERE) restores ECMAScript metachar semantics', () => {
    const t = createTerminal({ 'src/x.js': 'apple\nbanana\ncherry\n' })
    assert.match(t.run('grep -E "apple|banana" src/x.js').stdout, /apple\nbanana/u)
    // The same pattern in BRE would search for the literal string
    // `apple|banana`, which doesn't appear in the file → exit 1.
    assert.equal(t.run('grep "apple|banana" src/x.js').exitCode, 1)
  })

  it('grep -G is the explicit form of the BRE default', () => {
    const t = createTerminal({ 'src/x.js': 'Function(arg)\n' })
    assert.equal(t.run('grep -G "Function(arg)" src/x.js').stdout, 'Function(arg)\n')
  })

  it('grep -E / -F / -G are mutually exclusive', () => {
    const t = createTerminal({ 'src/x.js': 'hi\n' })
    for (const cmd of ['grep -EF foo src/x.js', 'grep -EG foo src/x.js', 'grep -FG foo src/x.js']) {
      const r = t.run(cmd)
      assert.notEqual(r.exitCode, 0, `${cmd}: expected non-zero exit`)
      assert.match(r.stderr, /mutually exclusive/u)
    }
  })

  it('grep character class contents pass through under BRE', () => {
    // `[(){}+?|]` inside `[...]` is just a literal char set in both
    // BRE and ES — the translator must not "swap escaping" inside
    // the class. Pinning the full set so a future regression on
    // any one of them shows up here.
    const t = createTerminal({ 'src/x.js': 'a(b\na)b\na{b\na}b\na+b\na?b\na|b\nxyz\n' })
    for (const ch of ['(', ')', '{', '}', '+', '?', '|']) {
      assert.equal(t.run(`grep "[${ch}]" src/x.js`).stdout, `a${ch}b\n`, `[${ch}] should match a${ch}b`)
    }
  })

  it('grep BRE: bare trailing `\\` errors cleanly (matches GNU)', () => {
    // Real GNU grep also rejects this — but with a clean "Trailing
    // backslash" message rather than echoing the post-translation
    // ES regex. Pin both: non-zero exit AND a short message that
    // doesn't leak `/u:` or `Invalid regular expression`.
    const t = createTerminal({ 'server/foo.ts': 'x\n' })
    const r = t.run("grep -r '\\' server/")
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /trailing backslash/iu)
    assert.doesNotMatch(r.stderr, /Invalid regular expression/u)
  })

  it('grep BRE: `\\<` and `\\>` translate to word boundaries (GNU extension)', () => {
    // `\<word\>` is the GNU BRE muscle-memory form for matching a
    // whole word. Mapped to ES `\b` so the common pattern works.
    const t = createTerminal({
      'src/x.js': 'session\nsession_id\nmy_session\nsession.start\n',
    })
    const r = t.run("grep '\\<session\\>' src/x.js")
    const lines = r.stdout.split('\n').filter(Boolean).sort()
    // `\b` is symmetric so `session_id` and `my_session` are excluded
    // (the underscore is a word char on both sides). `session.start`
    // matches because `.` is non-word.
    assert.deepEqual(lines, ['session', 'session.start'])
  })

  it('grep BRE: -w composes with alternation', () => {
    const t = createTerminal({ 'src/x.js': 'apple pie\nbanana bread\napplesauce\n' })
    // -w wraps the translated source in `\b(?:...)\b` — confirm
    // that the BRE-style alternation `\(apple\|banana\)` still
    // gets the word-boundary wrap correctly.
    const r = t.run("grep -w '\\(apple\\|banana\\)' src/x.js")
    const lines = r.stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(lines, ['apple pie', 'banana bread'])
    // `applesauce` excluded by -w (no word boundary between e and s).
  })

  it('grep BRE: escaped backslash `\\\\` matches a literal backslash', () => {
    // The standard way to grep for a backslash in GNU BRE: `\\` in
    // the pattern. Verifies that our translator doesn't accidentally
    // consume the trailing `\` of `\\` as the start of an escape.
    const t = createTerminal({ 'src/x.js': 'a\\b\nxyz\n' })
    assert.equal(t.run("grep '\\\\' src/x.js").stdout, 'a\\b\n')
  })

  it('grep BRE: backslash sequences inside character classes pass through', () => {
    // The class-passthrough rule covers escape sequences too:
    // `[\\d]` is a digit class, `[\\\\]` is a class containing
    // a literal backslash, `[\\]]` is a class containing a literal
    // `]`. Pinning all three so a future "fix" to the class tracker
    // doesn't quietly break them.
    const t = createTerminal({ 'src/x.js': 'abc123\na\\b\na]b\nxyz\n' })
    assert.match(t.run("grep '[\\d]' src/x.js").stdout, /abc123/u)
    assert.equal(t.run("grep '[\\\\]' src/x.js").stdout, 'a\\b\n')
    assert.equal(t.run("grep '[\\]]' src/x.js").stdout, 'a]b\n')
  })

  it('grep BRE: degenerate `\\(\\)` empty group and `\\|` empty alternation compile', () => {
    // Both are odd but legal in BRE and translate to legal ES.
    // Test that they don't crash the translator — the regexes just
    // happen to match the empty string between every char, so any
    // non-empty line "matches".
    const t = createTerminal({ 'src/x.js': 'hello\n' })
    assert.equal(t.run("grep '\\(\\)' src/x.js").exitCode, 0)
    assert.equal(t.run("grep '\\|' src/x.js").exitCode, 0)
  })

  it('grep BRE: leading `*` is literal (matches ugrep / GNU)', () => {
    // POSIX BRE: `*` with no preceding atom is literal `*`. ES
    // rejects this as "Nothing to repeat", so unfixed our grep
    // would silently fail to find `*foo` in C source (pointer
    // notation, markdown bullets). Verified against `/usr/bin/grep
    // '*foo' file` which matches `*foo` and exits 0.
    const t = createTerminal({ 'src/x.js': 'foo\n*foo\n*bar\n' })
    assert.equal(t.run("grep '*foo' src/x.js").stdout, '*foo\n')
    // Same rule after `^` when `^` is an anchor at position 0.
    const r = t.run("grep '^*' src/x.js")
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, '*foo\n*bar\n')
  })

  it('grep BRE: `*` after a LITERAL `^` still quantifies it (Copilot #40)', () => {
    // `a^*b` — the `^` is mid-pattern (literal in BRE), so `*`
    // quantifies it: matches a + zero-or-more literal `^` + b.
    // Previously we treated any `^*` sequence as "anchor + literal
    // `*`" regardless of position, breaking this case. Verified
    // vs `/usr/bin/grep 'a^*b'` returning a^^b / a^b / ab.
    const t = createTerminal({ 'src/x.js': 'a^^b\na^b\nab\nax\n' })
    const lines = t.run("grep 'a^*b' src/x.js").stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(lines, ['a^^b', 'a^b', 'ab'])
  })

  it('grep BRE: backslash inside `[...]` consumes the next char', () => {
    // Copilot review #40: an escaped `]` inside a class shouldn't
    // prematurely end class tracking, otherwise subsequent metachars
    // (like the `{}` in `\p{L}`) would get BRE-swap-translated and
    // the pattern would fail to compile. Confirms the class tracker
    // tracks escapes properly. Real `\p{L}` Unicode-property class
    // matches Greek letters; ugrep doesn't recognize `\p{L}` in BRE
    // (we extend, GNU-style).
    const t = createTerminal({ 'uni.txt': 'abc\n123\nαβγ\n' })
    const r = t.run("grep '[a\\]b\\p{L}]' uni.txt")
    assert.equal(r.exitCode, 0)
    const lines = r.stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(lines, ['abc', 'αβγ'])
  })

  it('grep: invalid pattern exits 2 (POSIX), not 1', () => {
    // POSIX (and GNU / ugrep): exit 2 for "syntax error in pattern",
    // exit 1 for "no match", exit 0 for "match". Our trailing-`\`
    // and -E "(" cases both surface as syntax errors.
    const t = createTerminal({ 'src/x.js': 'hello\n' })
    assert.equal(t.run("grep '\\' src/x.js").exitCode, 2)
    assert.equal(t.run("grep -E '(' src/x.js").exitCode, 2)
  })

  it('grep: error label reflects -i flag (`/iu` not `/u`)', () => {
    // Minor accuracy: the label tells users which RegExp flags were
    // actually in effect when the compile failed. Hard-coding `/u`
    // hid the fact that `-i` was set.
    const t = createTerminal({ 'src/x.js': 'hi\n' })
    const r = t.run("grep -iE '(' src/x.js")
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /\/iu/u)
  })

  it('grep BRE: `^` is literal mid-pattern, anchor at start (matches ugrep)', () => {
    // POSIX BRE: `^` is an anchor only at position 0. Elsewhere
    // literal. ES treats `^` as anchor everywhere — would silently
    // break grepping for `foo^bar` or `a^b`.
    const t = createTerminal({ 'src/x.js': 'foo\n*foo\nfoo^bar\nfoo$bar\n' })
    // `^foo` at start: anchor — matches lines beginning with `foo`.
    const start = t.run("grep '^foo' src/x.js").stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(start, ['foo', 'foo$bar', 'foo^bar'])
    // `foo^bar` mid-pattern: literal — matches the line `foo^bar`.
    assert.equal(t.run("grep 'foo^bar' src/x.js").stdout, 'foo^bar\n')
    // `^^foo`: first `^` anchor, second literal. No line starts
    // with literal `^foo` → no match.
    assert.equal(t.run("grep '^^foo' src/x.js").exitCode, 1)
  })

  it('grep BRE: `$` is literal mid-pattern, anchor at end (matches ugrep)', () => {
    // Mirrors the `^` rule.
    const t = createTerminal({ 'src/x.js': 'foo\n*foo\nfoo^bar\nfoo$bar\n' })
    // `foo$` at end: anchor — matches lines ending in `foo`.
    const end = t.run("grep 'foo$' src/x.js").stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(end, ['*foo', 'foo'])
    // `foo$bar` mid-pattern: UNESCAPED `$` is literal — this is the
    // post-fix behaviour, and would have returned exit 1 under the
    // old ES-everywhere-anchor default (foo can't both end the line
    // and be followed by `bar`).
    assert.equal(t.run("grep 'foo$bar' src/x.js").stdout, 'foo$bar\n')
  })

  it('grep BRE: `^` / `$` keep anchor semantics adjacent to `\\(` / `\\)`', () => {
    // GNU extension: `^` right after `\(` is still an anchor;
    // `$` right before `\)` likewise. Verified against ugrep.
    const t = createTerminal({ 'src/x.js': 'foo\n*foo\nfoo^bar\nfoo$bar\n' })
    const group = t.run("grep '\\(^foo\\)' src/x.js").stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(group, ['foo', 'foo$bar', 'foo^bar'])
    const endGroup = t.run("grep '\\(foo$\\)' src/x.js").stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(endGroup, ['*foo', 'foo'])
  })

  it('grep BRE: `\\{n,m\\}` and `\\{n\\}` bounded quantifiers', () => {
    // BRE: `\{n,m\}` is the bounded quantifier; the bare `{n,m}`
    // form is literal. Verified output matches ugrep.
    const t = createTerminal({ 'src/x.js': 'a\nab\naab\naaab\nbb\n' })
    // `a\{2,3\}` → 2 or 3 consecutive `a`s.
    const two = t.run("grep 'a\\{2,3\\}' src/x.js").stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(two, ['aaab', 'aab'])
    // `a\{2\}` → exactly 2 consecutive `a`s.
    const exact = t.run("grep 'a\\{2\\}' src/x.js").stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(exact, ['aaab', 'aab'])
    // (Pattern matches anywhere on the line — `aaab` has `aa` substring.)
  })

  it('grep: empty pattern matches every line (POSIX)', () => {
    // `grep '' file` is "match the empty string against every
    // line" — succeeds on every non-empty line. Verified vs ugrep.
    const t = createTerminal({ 'src/x.js': 'a\nb\nc\n' })
    const r = t.run("grep '' src/x.js")
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'a\nb\nc\n')
  })

  it('grep BRE: `\\(group\\)\\N` backreference', () => {
    // BRE supports back-references via `\1`..`\9` referring to
    // earlier `\(...\)` groups. Both ugrep and our ES translation
    // accept them; we matched ugrep's exit-1 / no-match behaviour
    // on the data set, but the pattern compiles cleanly.
    const t = createTerminal({ 'src/x.js': 'foofoo\nfoo\nbar\n' })
    const r = t.run("grep '\\(foo\\)\\1' src/x.js")
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'foofoo\n')
  })

  it('grep BRE: backslash before non-special char is literal (`\\a` → `a`)', () => {
    // Copilot review #40: ES /u rejects identity escapes for
    // non-syntactic chars (`\a`, `\_`, `\@`) as SyntaxError, but
    // POSIX BRE treats them as literal `a` / `_` / `@`. Without
    // this, valid BRE patterns silently fail to compile.
    // Verified against `/usr/bin/grep '\a' file` matching every
    // line containing `a` and exiting 0.
    const t = createTerminal({ 'f.txt': 'apple\nbanana\ncar\n_under\nxyz\n' })
    // `\a` → literal `a`
    const a = t.run("grep '\\a' f.txt").stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(a, ['apple', 'banana', 'car'])
    // `\_` → literal `_`
    assert.equal(t.run("grep '\\_' f.txt").stdout, '_under\n')
    // `\@` → literal `@`, no matches
    assert.equal(t.run("grep '\\@' f.txt").exitCode, 1)
    // `\b` (GNU extension): word boundary, every non-empty line has one
    assert.equal(t.run("grep '\\b' f.txt").exitCode, 0)
  })

  it('grep `-e PATTERN`: single pattern', () => {
    // -e exists primarily so a pattern can start with `-` without
    // being mistaken for a flag.
    const t = createTerminal({ 'f.txt': 'apple\n-dash\nbanana\n' })
    assert.equal(t.run("grep -e -dash f.txt").stdout, '-dash\n')
    // Inline form too.
    assert.equal(t.run("grep -e-dash f.txt").stdout, '-dash\n')
  })

  it('grep `-e PATTERN -e PATTERN`: a line matches if ANY pattern matches', () => {
    // Each `-e` pattern is compiled into its own RegExp; a line
    // matches when any of them does. (Previously combined as
    // `(?:p1)|(?:p2)` — changed because alternation shifts
    // backreference group numbers across patterns.) Verified vs
    // `/usr/bin/grep -e apple -e car` which prints both.
    const t = createTerminal({ 'f.txt': 'apple\nbanana\ncar\ndog\n' })
    const r = t.run("grep -e apple -e car f.txt")
    assert.equal(r.exitCode, 0)
    const lines = r.stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(lines, ['apple', 'car'])
  })

  it('grep `-e` stranded errors with exit 2', () => {
    const t = createTerminal({ 'f.txt': 'foo\n' })
    const r = t.run("grep f.txt -e")
    assert.equal(r.exitCode, 2)
    assert.match(r.stderr, /-e requires an argument/u)
  })

  it('grep `-e` composes with -i / -E / -F', () => {
    const t = createTerminal({ 'f.txt': 'Foo\nbar(\nbaz\n' })
    // -e + -i: case-insensitive
    assert.match(t.run("grep -ie foo f.txt").stdout, /^Foo$/mu)
    // -e + -F: literal -e value
    assert.equal(t.run("grep -Fe 'bar('  f.txt").stdout, 'bar(\n')
    // Two patterns with -E semantics
    const r = t.run("grep -E -e 'foo|bar' -e 'baz' f.txt")
    const lines = r.stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(lines, ['bar(', 'baz'])
  })

  it('grep `-ie PATTERN` bundled, repeated: all patterns kept (Copilot #40)', () => {
    // Before the bundled-aware pre-pass, the second `-ie` would
    // overwrite the first in parseArgs's single-value-per-key Map
    // and one of the patterns silently disappeared. Verified vs
    // `/usr/bin/grep -ie foo -ie bar` returning both matches.
    const t = createTerminal({ 'f.txt': 'FOO\nbar\nhi\n' })
    const lines = t.run('grep -ie foo -ie bar f.txt').stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(lines, ['FOO', 'bar'])
    // Bundled inline form too.
    const lines2 = t.run('grep -iefoo -iebar f.txt').stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(lines2, ['FOO', 'bar'])
  })

  it('grep BRE: negated class `[^a]` excludes only `a`, NOT also `^` (Copilot #40)', () => {
    // The `[` branch was emitting the leading `^` and then NOT
    // advancing past it, so the next iteration reprocessed it
    // inside the class — `[^a]` became `[^^a]` which excluded
    // `^` from the negated set. Verified vs ugrep matching both
    // `b` and `^` (i.e. everything that isn't `a`).
    const t = createTerminal({ 'f.txt': 'a\nb\n^\n' })
    const lines = t.run("grep '[^a]' f.txt").stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(lines, ['^', 'b'])
  })

  it('grep `-A -- -e foo file` keeps -e reachable through value consumption (Copilot #40)', () => {
    // `-A` is a value-taking short, so `--` is its value (and
    // parseNonNegativeInt rejects it). Pre-pass must NOT treat `--`
    // as a terminator that skips over `-e foo` — that would have
    // surfaced as "unknown option: -e" from parseArgs.
    const t = createTerminal({ 'file': 'foo\nbar\n' })
    const r = t.run('grep -A -- -e foo file')
    assert.notEqual(r.exitCode, 0)
    // Error should name -A (the bad value), NOT complain about -e.
    assert.match(r.stderr, /-A/u)
    assert.doesNotMatch(r.stderr, /unknown option: -e/u)
  })

  it('grep BRE: leading `]` inside class is literal (Copilot #40 / POSIX)', () => {
    // POSIX: `[]a]` is a class containing `]` and `a`; `[^]a]` is
    // its negation. ES /u rejects `[]` as empty-class. Translator
    // now escapes the leading `]` to `\]` so the same characters
    // land in the class. Verified vs `/usr/bin/grep '[]a]'` /
    // `'[^]a]'` returning every line.
    const t = createTerminal({ 'f.txt': 'apple\nx]y\nz[a]b\n' })
    const including = t.run("grep '[]a]' f.txt").stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(including, ['apple', 'x]y', 'z[a]b'])
    const negated = t.run("grep '[^]a]' f.txt").stdout.split('\n').filter(Boolean).sort()
    // Every line has at least one char that isn't `]` or `a`.
    assert.deepEqual(negated, ['apple', 'x]y', 'z[a]b'])
  })

  it('grep BRE: trailing `\\` inside class errors cleanly (Copilot #40)', () => {
    // `grep '[\' file` is unterminated; previously surfaced as
    // V8's noisy "Invalid regular expression: /[\/u: \ at end".
    // Now reports the same clean "trailing backslash" message used
    // for the outside-class case. Both ugrep and GNU treat the
    // unterminated class as a syntax error (exit 2).
    const t = createTerminal({ 'f.txt': 'hi\n' })
    const r = t.run("grep '[\\' f.txt")
    assert.equal(r.exitCode, 2)
    assert.match(r.stderr, /trailing backslash/u)
    assert.doesNotMatch(r.stderr, /Invalid regular expression/u)
  })

  it('grep -o with multiple -e: dedupe overlapping matches (Copilot #40)', () => {
    // Previous implementation emitted every regex's match independently,
    // so `-e foo -e fo` on `foofoo` produced six lines (foo+fo per
    // occurrence). ugrep / GNU grep emit one per non-overlapping
    // leftmost-longest position. Verified vs `/usr/bin/grep -oe foo
    // -e fo` returning three lines (foofoo has 2 + foo bar has 1).
    const t = createTerminal({ 'f.txt': 'foofoo\nfoo bar\n' })
    const r = t.run('grep -oe foo -e fo f.txt')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'foo\nfoo\nfoo\n')
  })

  it('grep -o drops zero-length matches (Copilot #40)', () => {
    // `\b` and `\(\)` match at zero width. Emitting them under -o
    // produces a wall of blank lines (worse: multi-`-e` repeats per
    // pattern at the same index because the cursor doesn't advance
    // past an empty match). ugrep / GNU grep drop zero-length
    // matches in -o mode; we do the same.
    const t = createTerminal({ 'f.txt': 'abc def\n' })
    assert.equal(t.run("grep -o '\\b' f.txt").stdout, '')
    assert.equal(t.run("grep -oe '\\b' -e '\\(\\)' f.txt").stdout, '')
    // Non-empty matches still emit normally.
    assert.equal(t.run('grep -o def f.txt').stdout, 'def\n')
  })

  it('grep BRE: `\\u{...}` validates hex body and code-point range (Copilot #40)', () => {
    // Without validation, `\u{zz}` or `\u{110000}` passed through
    // to ES which errored. With validation, the body must be 1-6
    // hex digits AND ≤ 0x10FFFF (ES /u code-point cap); else drop
    // the backslash and treat `u{...}` as literal.
    const t = createTerminal({ 'f.txt': 'apple\nu{zz}line\nu{110000}data\n' })
    // Invalid hex: drop backslash, match literal `u{zz}` substring.
    assert.equal(t.run("grep '\\u{zz}' f.txt").stdout, 'u{zz}line\n')
    // Out-of-range code point: same drop-backslash fallback.
    assert.equal(t.run("grep '\\u{110000}' f.txt").stdout, 'u{110000}data\n')
    // Valid hex stays as the ES Unicode escape (0x41 = 'A'; data has none).
    assert.equal(t.run("grep '\\u{41}' f.txt").exitCode, 1)
  })

  it('grep BRE: control-letter escapes are literal letters (`\\t` → `t`, `\\0` → `0`)', () => {
    // Strict POSIX BRE (and ugrep / GNU grep) treats `\t`, `\n`,
    // `\r`, `\f`, `\v`, `\0` as literal letters, NOT as ES control
    // escapes. Copilot #40 caught `\0` specifically: `\01` would
    // hit V8's legacy-octal "Invalid decimal escape" error.
    const t = createTerminal({ 'f.txt': 'no tab\nwith\ttab\nplain\n01abc\nzero\n' })
    // `\t` → literal `t` (matches lines with letter `t`)
    const tt = t.run("grep '\\t' f.txt").stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(tt, ['no tab', 'with\ttab'])
    // `\0` → literal `0`
    assert.equal(t.run("grep '\\0' f.txt").stdout, '01abc\n')
    // `\01` → literal `01` (would previously throw "Invalid decimal escape")
    assert.equal(t.run("grep '\\01' f.txt").stdout, '01abc\n')
    // `\v` → literal `v`, no `v` in data
    assert.equal(t.run("grep '\\v' f.txt").exitCode, 1)
  })

  it('grep multi `-e`: backreferences stay local to each pattern (Copilot #40)', () => {
    // The earlier `(?:p1)|(?:p2)` combining shifted group numbers
    // across patterns, so pattern2's `\1` could accidentally refer
    // to pattern1's first group. Compiling regexes separately fixes
    // it. Verified vs ugrep matching only `bazbaz`.
    const t = createTerminal({ 'f.txt': 'bazfoo\nbazbaz\nbar\n' })
    const r = t.run("grep -e '\\(foo\\)\\(bar\\)' -e '\\(baz\\)\\1' f.txt")
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'bazbaz\n')
  })

  it('grep BRE: multi-char escape starters validate their suffix (Copilot #40)', () => {
    // `\x`, `\u`, `\p`, `\k`, `\c` require specific suffixes in ES /u
    // (`\xHH`, `\u{...}` / `\uHHHH`, `\p{...}`, `\k<...>`, `\cX`).
    // Without the suffix, POSIX BRE / ugrep treat them as literal.
    // Previously we kept the backslash and tripped ES syntax errors.
    const t = createTerminal({ 'f.txt': 'apple\nx-ray\n_under\n[bracket]\nαβγ\n' })
    assert.equal(t.run("grep '\\x' f.txt").stdout, 'x-ray\n')      // literal x
    assert.equal(t.run("grep '\\u' f.txt").stdout, '_under\n')     // literal u
    assert.equal(t.run("grep '\\p' f.txt").stdout, 'apple\n')      // literal p
    assert.equal(t.run("grep '\\k' f.txt").stdout, '[bracket]\n')  // literal k
    assert.equal(t.run("grep '\\c' f.txt").stdout, '[bracket]\n')  // literal c
    // But the VALID forms still work as ES escapes.
    const greek = t.run("grep '\\p{L}' f.txt").stdout.split('\n').filter(Boolean).sort()
    assert.ok(greek.includes('αβγ'))  // Unicode letter property class
  })

  it('grep BRE: identity escapes inside `[...]` are literal (Copilot #40)', () => {
    // `[\_]` should be a class containing `_` (ES /u rejects `\_`
    // as an Invalid escape, but POSIX BRE treats it as literal `_`).
    // Verified vs ugrep matching the `_under` line.
    const t = createTerminal({ 'f.txt': 'apple\n_under\nxyz\n' })
    assert.equal(t.run("grep '[\\_]' f.txt").stdout, '_under\n')
    // `[\a]`: with backslash dropped, class is `[a]` — matches `apple`.
    // (POSIX would also include the literal `\` in the class, but
    // none of our data has a backslash, so the result is the same.)
    assert.equal(t.run("grep '[\\a]' f.txt").stdout, 'apple\n')
  })

  it('grep -r preserves an absolute starting path in the displayed name', () => {
    // Covers the displayName branch where userPath is absolute
    // (so the result keeps the leading `/`), distinct from the
    // relative-path / `.` cases pinned above.
    const t = createTerminal(SOURCES)
    const r = t.run('grep -r TODO /src')
    assert.equal(r.exitCode, 0)
    const lines = r.stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(lines, ['/src/bar.js:// TODO: doc this', '/src/foo.js:// TODO: fix'])
  })

  it('grep -A N prints N lines after each match', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('grep -A 1 TODO src/foo.js')
    assert.equal(r.exitCode, 0)
    // src/foo.js is "const x = 1\n// TODO: fix\nconst y = 2\n"
    // -A 1 → match line + the next line. (No -n/-H here, so the
    // match/`:` vs context/`-` separator distinction only shows
    // when prefixes are on — see the `-n -A 1 -B 1` test below.)
    assert.equal(r.stdout, '// TODO: fix\nconst y = 2\n')
  })

  it('grep -B N prints N lines before each match', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('grep -B 1 TODO src/foo.js')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'const x = 1\n// TODO: fix\n')
  })

  it('grep -C N is shorthand for -A N -B N', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('grep -C 1 TODO src/foo.js')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'const x = 1\n// TODO: fix\nconst y = 2\n')
  })

  it('grep -C validates its value even when -A and -B are also explicit', () => {
    // Without the dedicated check, `-C` would fall through `??`
    // because both -A and -B took precedence — a typo in -C would
    // be silently dropped. The error message should name -C.
    const t = createTerminal(SOURCES)
    const r = t.run('grep -C garbage -A 1 -B 1 TODO src/foo.js')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /-C/u)
  })

  it('grep -A/-B inserts `--` between non-adjacent context groups in one file', () => {
    const t = createTerminal({
      'log.txt': 'pre1\npre2\nMATCH a\nbetween1\nbetween2\nbetween3\nbetween4\nMATCH b\npost1\npost2\n',
    })
    const r = t.run('grep -A 1 -B 1 MATCH log.txt')
    // Two groups separated by `--`. Each group: 1 before + match + 1 after.
    assert.equal(r.stdout, 'pre2\nMATCH a\nbetween1\n--\nbetween4\nMATCH b\npost1\n')
  })

  it('grep -A/-B with explicit -n prefixes line numbers; context uses `-`', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('grep -n -A 1 -B 1 TODO src/foo.js')
    assert.equal(r.stdout, '1-const x = 1\n2:// TODO: fix\n3-const y = 2\n')
  })

  it('grep -l lists filenames with matches (no content); -L inverts', () => {
    const t = createTerminal(SOURCES)
    const withMatch = t.run('grep -rl TODO').stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(withMatch, ['src/bar.js', 'src/foo.js'])
    const without = new Set(t.run('grep -rL TODO').stdout.split('\n').filter(Boolean))
    // src/util/log.js, README.md, .hidden are dotfile / non-TODO files.
    assert.ok(without.has('src/util/log.js'))
    assert.ok(without.has('README.md'))
    assert.ok(!without.has('src/foo.js'))
  })

  it('grep -c counts matching lines per file', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('grep -rc TODO')
    const counts = Object.fromEntries(
      r.stdout.split('\n').filter(Boolean).map((l) => {
        const [name, n] = l.split(':')
        return [name, Number(n)]
      })
    )
    assert.equal(counts['src/foo.js'], 1)
    assert.equal(counts['src/bar.js'], 1)
    assert.equal(counts['src/util/log.js'], 0)
  })

  it('grep -o prints only the matching substrings, one per line', () => {
    const t = createTerminal({
      'urls.txt': 'see http://a.example/x and http://b.example/y for more\nand http://c.example/z\n',
    })
    // `+` is ERE / ECMAScript; default is BRE where `+` is literal.
    const r = t.run('grep -oE "http://[^ ]+" urls.txt')
    const matches = r.stdout.split('\n').filter(Boolean)
    assert.deepEqual(matches, ['http://a.example/x', 'http://b.example/y', 'http://c.example/z'])
  })

  it('grep -w matches whole words only', () => {
    const t = createTerminal({
      'src/x.js': 'session\nsession_id\nmy_session\nsession.start\n',
    })
    const r = t.run('grep -w session src/x.js')
    // `session` matches plainly; `session_id` and `my_session` are
    // partial-token matches a non-`-w` grep would also catch but
    // `-w` rejects (word-boundary fails inside the identifier).
    // `session.start` matches because `.` isn't a word char.
    assert.equal(r.stdout, 'session\nsession.start\n')
  })

  it('grep -h suppresses the filename prefix even under -r; -H forces it', () => {
    const t = createTerminal(SOURCES)
    const suppressed = t.run('grep -rh TODO src')
    assert.ok(suppressed.stdout.length > 0)
    // No leading "src/foo.js:" prefix on any line:
    for (const line of suppressed.stdout.split('\n').filter(Boolean)) {
      assert.ok(!line.startsWith('src/'), `unexpected name prefix: ${line}`)
    }
    // -H forces the prefix even with one file:
    const forced = t.run('grep -H TODO src/foo.js')
    assert.match(forced.stdout, /^src\/foo\.js:/u)
  })

  it('grep -H labels stdin input as `(standard input)` (matches GNU)', () => {
    // Without this, `echo … | grep -H foo` would emit unprefixed
    // lines and a piped grep result would be indistinguishable
    // from raw data downstream.
    const t = createTerminal(SOURCES)
    assert.equal(t.run('echo hello | grep -H hello').stdout, '(standard input):hello\n')
    assert.equal(t.run('echo hello | grep -Hn hello').stdout, '(standard input):1:hello\n')
    assert.equal(t.run('echo hello | grep -Hc hello').stdout, '(standard input):1\n')
  })

  it('grep -l / -L on stdin labels the stream as `(standard input)`', () => {
    // Previously the stdin case dropped silently because the
    // name was null; consistent with the -H label above.
    const t = createTerminal(SOURCES)
    assert.equal(t.run('echo hello | grep -l hello').stdout, '(standard input)\n')
    assert.equal(t.run('echo hello | grep -L nope').stdout, '(standard input)\n')
  })

  it('grep rejects mutually exclusive flag combinations', () => {
    const t = createTerminal(SOURCES)
    // parseArgs stores flags in a Set, so a user-typed ordering
    // can't pick a winner the way "last one wins" would. We
    // surface the conflict instead of silently preferring one.
    const cases = [
      ['grep -hH foo src/foo.js', /-h and -H/u],
      ['grep -lL foo src/foo.js', /-l \/ -L/u],
      ['grep -lc foo src/foo.js', /-l \/ -c/u],
      ['grep -Lc foo src/foo.js', /-L \/ -c/u],
    ]
    for (const [cmd, re] of cases) {
      const r = t.run(cmd)
      assert.notEqual(r.exitCode, 0, `${cmd}: expected non-zero exit`)
      assert.match(r.stderr, re, `${cmd}: stderr didn't mention the conflict`)
    }
  })

  it('cat -n numbers lines with a 6-wide right-aligned column and a tab separator', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('cat -n src/foo.js')
    assert.equal(r.stdout, '     1\tconst x = 1\n     2\t// TODO: fix\n     3\tconst y = 2\n')
  })

  it('head -n and tail -n', () => {
    const t = createTerminal(SOURCES)
    assert.equal(t.run('head -n 1 src/foo.js').stdout, 'const x = 1\n')
    assert.equal(t.run('tail -n 1 src/foo.js').stdout, 'const y = 2\n')
  })

  it('sort orders ascending by default; -r reverses; -u dedupes', () => {
    // Verified against `/usr/bin/sort` and `/usr/bin/sort -r`/`-u`.
    const t = createTerminal({
      'words.txt': 'banana\ncherry\napple\n',
      'dups.txt': 'b\na\nb\nc\na\nc\n',
    })
    assert.equal(t.run('cat words.txt | sort').stdout, 'apple\nbanana\ncherry\n')
    assert.equal(t.run('cat words.txt | sort -r').stdout, 'cherry\nbanana\napple\n')
    assert.equal(t.run('cat dups.txt | sort -u').stdout, 'a\nb\nc\n')
  })

  it('sort -n orders by numeric value (default sort is lexicographic)', () => {
    // Verified against `/usr/bin/sort -n`. Lexicographic sort puts
    // `100` before `2`; numeric sort gets the magnitudes right.
    const t = createTerminal({ 'n.txt': '10\n9\n100\n2\n' })
    assert.equal(t.run('cat n.txt | sort').stdout, '10\n100\n2\n9\n')
    assert.equal(t.run('cat n.txt | sort -n').stdout, '2\n9\n10\n100\n')
    assert.equal(t.run('cat n.txt | sort -rn').stdout, '100\n10\n9\n2\n')
    // Reads file arguments like the rest of sort.
    assert.equal(t.run('sort -n n.txt').stdout, '2\n9\n10\n100\n')
  })

  it('sort -n handles negatives, decimals, and non-numeric lines (as 0)', () => {
    // Verified against `/usr/bin/sort -n`.
    const t = createTerminal({})
    assert.equal(t.run('echo -e "-5\\n3\\n-10\\n0" | sort -n').stdout, '-10\n-5\n0\n3\n')
    assert.equal(t.run('echo -e "1.5\\n1.25\\n1.1" | sort -n').stdout, '1.1\n1.25\n1.5\n')
    // Lines without a leading number sort as 0, ordered among
    // themselves by the whole line (GNU's last-resort comparison).
    assert.equal(t.run('echo -e "foo\\n3\\n1\\nbar" | sort -n').stdout, 'bar\nfoo\n1\n3\n')
    // Equal numeric value, different text: whole line breaks the tie.
    assert.equal(t.run('echo -e "10 b\\n10 a\\n2 c" | sort -n').stdout, '2 c\n10 a\n10 b\n')
  })

  it('sort -nu dedupes by numeric value, keeping the first in input order', () => {
    // Verified against `/usr/bin/sort -nu` / `-rnu`. `1` and `01` are
    // the same value, so -u keeps whichever appeared first; the
    // last-resort tiebreak is suppressed under -u.
    const t = createTerminal({})
    assert.equal(t.run('echo -e "1\\n01\\n2" | sort -nu').stdout, '1\n2\n')
    assert.equal(t.run('echo -e "01\\n1\\n2" | sort -nu').stdout, '01\n2\n')
    assert.equal(t.run('echo -e "1\\n01\\n2" | sort -rnu').stdout, '2\n1\n')
  })

  it('uniq -c counts CONSECUTIVE runs (not totals — matches coreutils)', () => {
    // GNU `uniq` only collapses adjacent duplicates; non-adjacent
    // dupes keep separate count rows. Width 7 + space + value.
    const t = createTerminal({ 'f.txt': 'a\na\nb\na\n' })
    assert.equal(t.run('cat f.txt | uniq -c').stdout, '      2 a\n      1 b\n      1 a\n')
  })

  it('uniq -d keeps only lines that recurred in a run; -u keeps only one-shots', () => {
    // For input a a b a a a c:
    // runs are (a,2), (b,1), (a,3), (c,1).
    // -d keeps runs with count >= 2 → one `a` per repeated run.
    // -u keeps runs with count == 1 → `b`, `c`.
    const t = createTerminal({ 'f.txt': 'a\na\nb\na\na\na\nc\n' })
    assert.equal(t.run('cat f.txt | uniq -d').stdout, 'a\na\n')
    assert.equal(t.run('cat f.txt | uniq -u').stdout, 'b\nc\n')
    // -cd: count column with only the duplicate runs.
    assert.equal(t.run('cat f.txt | uniq -cd').stdout, '      2 a\n      3 a\n')
  })

  it('uniq -d -u together produces no output (empty intersection)', () => {
    // A line can't simultaneously be a duplicate AND a one-shot.
    // GNU behaves the same way (or errors on some versions); we
    // pick the silent-empty path so scripts passing both flags
    // by accident don't blow up.
    const t = createTerminal({ 'f.txt': 'a\na\nb\n' })
    const r = t.run('cat f.txt | uniq -du')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, '')
  })

  it('uniq -i compares case-insensitively; output preserves the first occurrence as-is', () => {
    // Apple / APPLE collapse into one run; the kept text is the
    // FIRST line of the run (`Apple`), not normalized to lowercase.
    const t = createTerminal({ 'f.txt': 'Apple\nAPPLE\napple\nBanana\nbanana\n' })
    assert.equal(t.run('cat f.txt | uniq -i').stdout, 'Apple\nBanana\n')
    // -ic combines correctly: count reflects the case-insensitive
    // grouping (3 + 2).
    assert.equal(t.run('cat f.txt | uniq -ic').stdout, '      3 Apple\n      2 Banana\n')
  })

  it('sort reads filename arguments (not just stdin)', () => {
    // Regression: `sort <file>` used to silently ignore the file and
    // emit nothing with exit 0, breaking pipelines like `sort f | uniq`.
    const t = createTerminal({ 'words.txt': 'banana\ncherry\napple\n' })
    assert.equal(t.run('sort words.txt').stdout, 'apple\nbanana\ncherry\n')
    assert.equal(t.run('sort -r words.txt').stdout, 'cherry\nbanana\napple\n')
    // Stays composable downstream now that it actually emits.
    assert.equal(t.run('sort words.txt | uniq -c').stdout, '      1 apple\n      1 banana\n      1 cherry\n')
  })

  it('sort merges multiple file arguments before ordering (coreutils behavior)', () => {
    const t = createTerminal({ 'a.txt': 'b\nd\n', 'b.txt': 'a\nc\n' })
    assert.equal(t.run('sort a.txt b.txt').stdout, 'a\nb\nc\nd\n')
  })

  it('uniq reads filename arguments (not just stdin)', () => {
    // Regression: `uniq <file>` / `uniq -c <file>` used to return
    // empty stdout with exit 0 instead of reading the file.
    const t = createTerminal({ 'f.txt': 'a\na\nb\na\n' })
    assert.equal(t.run('uniq f.txt').stdout, 'a\nb\na\n')
    assert.equal(t.run('uniq -c f.txt').stdout, '      2 a\n      1 b\n      1 a\n')
  })

  it('sort / uniq report missing files instead of silently emitting nothing', () => {
    const t = createTerminal({ 'f.txt': 'a\n' })
    const s = t.run('sort nope.txt')
    assert.equal(s.exitCode, 1)
    assert.match(s.stderr, /sort: nope\.txt: no such file/u)
    const u = t.run('uniq nope.txt')
    assert.equal(u.exitCode, 1)
    assert.match(u.stderr, /uniq: nope\.txt: no such file/u)
  })

  it('echo -e interprets backslash escapes; default leaves them literal', () => {
    // Without -e, escapes pass through verbatim (the historical
    // behavior); -e turns `\n`, `\t`, etc. into the real characters.
    const t = createTerminal({})
    assert.equal(t.run('echo "a\\nb"').stdout, 'a\\nb\n')
    assert.equal(t.run('echo -e "a\\nb"').stdout, 'a\nb\n')
    assert.equal(t.run('echo -e "x\\ty"').stdout, 'x\ty\n')
    // -E is the explicit "no interpretation" form and is accepted.
    assert.equal(t.run('echo -E "a\\nb"').stdout, 'a\\nb\n')
    // -n still suppresses the trailing newline, and bundles with -e.
    assert.equal(t.run('echo -ne "a\\nb"').stdout, 'a\nb')
    // Unrecognized escapes keep their backslash, matching GNU.
    assert.equal(t.run('echo -e "\\q"').stdout, '\\q\n')
  })

  it('echo -e supports octal/hex escapes and `\\c` halting output', () => {
    const t = createTerminal({})
    assert.equal(t.run('echo -e "\\0101"').stdout, 'A\n')
    assert.equal(t.run('echo -e "\\x41"').stdout, 'A\n')
    // `\c` stops output and suppresses the trailing newline, dropping
    // the rest of the line and any following arguments.
    assert.equal(t.run('echo -e "a\\cb" c').stdout, 'a')
  })

  it('ls multi-target partial failure: matches succeed on stdout, misses on stderr', () => {
    // Already pinned in the basics block (line 54) but not against
    // an actual data file — confirm here that stdout still carries
    // the successful target's listing alongside stderr for the miss.
    const t = createTerminal(SOURCES)
    const r = t.run('ls src nope')
    assert.equal(r.exitCode, 1)
    assert.match(r.stderr, /nope:.*no such file/u)
    assert.match(r.stdout, /foo\.js/u)
    assert.doesNotMatch(r.stdout, /nope/u)
  })
})

describe('createTerminal — pipelines', () => {
  it('cat | grep | head pipes stdout to stdin', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('cat src/foo.js src/bar.js | grep TODO | head -n 1')
    assert.equal(r.stdout, '// TODO: fix\n')
  })

  it('sort | uniq dedupes adjacent duplicates after sort', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('echo c | cat')
    assert.equal(r.stdout, 'c\n')
    const r2 = t.run('cat src/foo.js | grep const | sort')
    assert.equal(r2.stdout, 'const x = 1\nconst y = 2\n')
  })

  it('wc -l counts lines from a pipe (adaptive width = `3`, no leading pad)', () => {
    // GNU prints just the count with no leading whitespace when it
    // fits its own digit-count — verified against `/usr/bin/wc -l`.
    const t = createTerminal(SOURCES)
    const r = t.run('cat src/foo.js | wc -l')
    assert.equal(r.stdout, '3\n')
  })
})

describe('createTerminal — find / tree / path', () => {
  it('find walks the tree; --type and --name filter', () => {
    const t = createTerminal(SOURCES)
    const all = new Set(t.run('find /').stdout.split('\n').filter(Boolean))
    assert.ok(all.has('/src/foo.js'))
    assert.ok(all.has('/src/util'))
    const filesOnly = new Set(t.run('find / --type f').stdout.split('\n').filter(Boolean))
    assert.ok(!filesOnly.has('/src'))
    const named = t.run('find / --name "*.js"').stdout.split('\n').filter(Boolean)
    assert.deepEqual(named.sort(), ['/src/bar.js', '/src/foo.js', '/src/util/log.js'])
  })

  it('find accepts POSIX-style single-dash primaries (-name, -type)', () => {
    const t = createTerminal(SOURCES)
    const dirs = new Set(t.run('find / -type d').stdout.split('\n').filter(Boolean))
    assert.ok(dirs.has('/src'))
    assert.ok(dirs.has('/src/util'))
    assert.ok(!dirs.has('/src/foo.js'))
    const named = t.run('find / -name "*.js"').stdout.split('\n').filter(Boolean)
    assert.deepEqual(named.sort(), ['/src/bar.js', '/src/foo.js', '/src/util/log.js'])
    // Combining works the same as the long form.
    const combined = t.run('find / -type f -name "*.md"').stdout.split('\n').filter(Boolean)
    assert.deepEqual(combined, ['/README.md'])
  })

  it('find -type / --type with a bad value errors and mentions both forms', () => {
    const t = createTerminal(SOURCES)
    // Whichever form the user typed, the error mentions both so it
    // doesn't mislead callers who used the long form.
    for (const cmd of ['find / -type x', 'find / --type x']) {
      const r = t.run(cmd)
      assert.notEqual(r.exitCode, 0)
      assert.match(r.stderr, /-type/u, `${cmd}: short form missing from error`)
      assert.match(r.stderr, /--type/u, `${cmd}: long form missing from error`)
    }
  })

  it('find -maxdepth N caps walk depth (0 = start only, 1 = +direct children, …)', () => {
    const t = createTerminal(SOURCES)
    // SOURCES has /src/foo.js, /src/bar.js, /src/util/log.js,
    // /README.md, /.hidden. Depth 0 = `/`, depth 1 = /src + /README.md
    // + /.hidden, depth 2 = /src/foo.js + /src/bar.js + /src/util,
    // depth 3 = /src/util/log.js.
    const d0 = new Set(t.run('find / -maxdepth 0').stdout.split('\n').filter(Boolean))
    assert.deepEqual([...d0], ['/'])
    const d1 = new Set(t.run('find / -maxdepth 1').stdout.split('\n').filter(Boolean))
    assert.ok(d1.has('/'))
    assert.ok(d1.has('/src'))
    assert.ok(d1.has('/README.md'))
    assert.ok(!d1.has('/src/foo.js'))
    const d2 = new Set(t.run('find / -maxdepth 2').stdout.split('\n').filter(Boolean))
    assert.ok(d2.has('/src/foo.js'))
    assert.ok(d2.has('/src/util'))
    assert.ok(!d2.has('/src/util/log.js'))
    const d3 = new Set(t.run('find / -maxdepth 3').stdout.split('\n').filter(Boolean))
    assert.ok(d3.has('/src/util/log.js'))
  })

  it('find -mindepth N skips entries shallower than N (0 = include start)', () => {
    // Verified against `/usr/bin/find`. Same SOURCES depths as the
    // -maxdepth test: 0 = `/`, 1 = /src + /README.md + /.hidden,
    // 2 = /src/{foo,bar}.js + /src/util, 3 = /src/util/log.js.
    const t = createTerminal(SOURCES)
    const m1 = new Set(t.run('find / -mindepth 1').stdout.split('\n').filter(Boolean))
    assert.ok(!m1.has('/'))            // the start point is dropped
    assert.ok(m1.has('/src'))
    assert.ok(m1.has('/src/util/log.js'))
    const m2 = new Set(t.run('find / -mindepth 2').stdout.split('\n').filter(Boolean))
    assert.ok(!m2.has('/'))
    assert.ok(!m2.has('/src'))         // depth-1 entries dropped
    assert.ok(!m2.has('/README.md'))
    assert.ok(m2.has('/src/foo.js'))   // depth-2 entries kept
    assert.ok(m2.has('/src/util/log.js'))
    // `--mindepth` long form; depth 3 leaves only the deepest file.
    assert.deepEqual(
      t.run('find / --mindepth 3').stdout.split('\n').filter(Boolean),
      ['/src/util/log.js'],
    )
    // -mindepth 0 keeps the start point (the default).
    assert.ok(new Set(t.run('find / -mindepth 0').stdout.split('\n').filter(Boolean)).has('/'))
    // Shares the depth-option parser with -maxdepth, so it validates too.
    assert.match(t.run('find / -mindepth foo').stderr, /-mindepth: invalid count/u)
  })

  it('find combines -mindepth and -maxdepth to select an exact depth band', () => {
    // Verified against `/usr/bin/find -mindepth 2 -maxdepth 2`.
    const t = createTerminal(SOURCES)
    const band = new Set(t.run('find / -mindepth 2 -maxdepth 2').stdout.split('\n').filter(Boolean))
    assert.ok(band.has('/src/foo.js'))
    assert.ok(band.has('/src/util'))
    assert.ok(!band.has('/src'))             // depth 1 excluded by -mindepth
    assert.ok(!band.has('/src/util/log.js')) // depth 3 excluded by -maxdepth
    // -mindepth greater than -maxdepth selects nothing (matches GNU).
    assert.equal(t.run('find / -mindepth 3 -maxdepth 1').stdout, '')
  })

  it('find -path PATTERN matches against the full path, `*` spans `/`', () => {
    const t = createTerminal(SOURCES)
    const r = t.run("find / -path '*/util/*'").stdout.split('\n').filter(Boolean)
    assert.deepEqual(r, ['/src/util/log.js'])
    // `--path` long form also works:
    const r2 = new Set(t.run("find / --path '*src*'").stdout.split('\n').filter(Boolean))
    assert.ok(r2.has('/src'))
    assert.ok(r2.has('/src/foo.js'))
  })

  it('find -not -path PATTERN (and `! -path`) excludes the matching subtree', () => {
    const t = createTerminal({
      'src/index.js': 'export {}',
      'src/util.js': 'export {}',
      'node_modules/foo/index.js': 'module.exports = {}',
      'node_modules/foo/sub/x.js': '',
      'node_modules/bar/y.js': '',
    })
    // The exact invocation from the request. Paths are POSIX-relative
    // (preserve `./`) so `*/node_modules/*` matches descendants.
    const r = t.run("find . -maxdepth 3 -type f -not -path '*/node_modules/*'")
      .stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(r, ['./src/index.js', './src/util.js'])
    // `!` is the same as -not:
    const r2 = t.run("find . -type f ! -path '*node_modules*'")
      .stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(r2, ['./src/index.js', './src/util.js'])
  })

  it('find -not also negates -name and -type', () => {
    const t = createTerminal(SOURCES)
    // -not -name "*.js" → everything but the .js files
    const r = new Set(t.run('find / -not -name "*.js"').stdout.split('\n').filter(Boolean))
    assert.ok(!r.has('/src/foo.js'))
    assert.ok(r.has('/README.md'))
    assert.ok(r.has('/src'))
    // -not -type d → only files
    const r2 = new Set(t.run('find / -not -type d').stdout.split('\n').filter(Boolean))
    assert.ok(r2.has('/src/foo.js'))
    assert.ok(!r2.has('/src'))
  })

  it('find rejects malformed -not usage', () => {
    const t = createTerminal(SOURCES)
    for (const cmd of ['find -not /src', 'find /src -not -not -name "*.js"', 'find /src -not']) {
      const r = t.run(cmd)
      assert.notEqual(r.exitCode, 0, `${cmd}: expected non-zero exit`)
      assert.match(r.stderr, /-not/u)
    }
  })

  it('find: `--` ends primary normalization; a literal `-name` after it stays a path', () => {
    // Without the terminator guard, `-name` after `--` would be
    // rewritten to `--name`, swallowing the next token as a glob.
    // With the guard, `-name` stays a positional — find then tries
    // to start from a path called `-name`, which doesn't exist.
    const t = createTerminal(SOURCES)
    const r = t.run('find -- -name')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /-name: no such file or directory/u)
  })

  it('find: `-maxdepth` after `--` is a path, not the maxdepth option', () => {
    // -maxdepth is extracted in a pre-pass (before primary normalization),
    // so the `--` terminator has to be honored there too — otherwise
    // `find -- -maxdepth 1` would set maxDepth=1 instead of treating
    // both tokens as start paths.
    const t = createTerminal(SOURCES)
    const r = t.run('find -- -maxdepth 1')
    assert.notEqual(r.exitCode, 0)
    assert.doesNotMatch(r.stderr, /-maxdepth requires/u)
    assert.match(r.stderr, /-maxdepth: no such file or directory/u)
  })

  it('find -name accepts `--` as the literal glob value (POSIX getopt convention)', () => {
    // A value-taking primary immediately followed by `--` consumes
    // `--` as the value, not as the terminator. Matches getopt and
    // the `-name -foo` precedent below.
    const t = createTerminal(SOURCES)
    const r = t.run('find / -name --')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, '') // no basename equals literal `--`
  })

  it('find -maxdepth surfaces "invalid count" when given `--` as value', () => {
    // Not "requires a value" — the value WAS supplied (`--`),
    // it just doesn't parse as a non-negative integer.
    const t = createTerminal(SOURCES)
    const r = t.run('find / -maxdepth --')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /invalid count: --/u)
    assert.doesNotMatch(r.stderr, /requires a value/u)
  })

  it('find -name accepts a dash-prefixed value as the literal glob', () => {
    // parseArgs's takeNext takes whatever follows a value-flag, even
    // if it looks like another flag — useful here so a user can pass
    // a glob that starts with `-`. SOURCES has no file matching the
    // literal `-foo` glob; find succeeds with no output (exit 0
    // since find doesn't signal "no match" the way grep does).
    const t = createTerminal(SOURCES)
    const r = t.run('find / -name -foo')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, '')
  })

  it('find -exec ... ; dispatches once per match with `{}` replaced by the path', () => {
    const t = createTerminal(SOURCES)
    // `echo {}` via -exec produces one line per match. Use -type f to
    // get a deterministic set, and sort the output since walk order
    // depends on listDir ordering.
    const r = t.run('find src -type f -exec echo {} ";"')
    assert.equal(r.exitCode, 0)
    const lines = r.stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(lines, ['src/bar.js', 'src/foo.js', 'src/util/log.js'])
  })

  it('find -exec ... ; suppresses the default -print (no double output)', () => {
    // POSIX: any -exec / -print action suppresses the implicit -print.
    // Without this rule, every match would print AND echo, doubling
    // the output.
    const t = createTerminal(SOURCES)
    const r = t.run('find src -type f -name "*.js" -exec echo {} ";"')
    const lines = r.stdout.split('\n').filter(Boolean)
    assert.equal(lines.length, 3)
    assert.ok(lines.every((l) => !l.startsWith('src/') || l.endsWith('.js')))
  })

  it('find -exec ... ; acts as a predicate (exit code filters the match, but does NOT bubble to find\'s exit)', () => {
    // GNU semantic (verified against /usr/bin/find 4.9):
    // `find . -exec false ;` exits 0. find's exit code reflects find's
    // OWN success (traversal), not the exec'd commands' exit codes.
    // The exit code DOES still drive the predicate boolean — `false`
    // makes the entry not match — but the predicate's exit code is
    // not bubbled.
    const t = createTerminal(SOURCES)
    const r = t.run('find src -type f -exec false ";"')
    assert.equal(r.exitCode, 0, 'failing -exec must NOT bubble to find exit code')
    assert.equal(r.stdout, '', 'no matches reach -print since exec returned false')
    // `true` exits 0 → keeps matches, no output (true is silent).
    const r2 = t.run('find src -type f -exec true ";"')
    assert.equal(r2.exitCode, 0)
    assert.equal(r2.stdout, '')
  })

  it('find -not -exec false ; exits 0 (negation flips the boolean; exec exit still does not bubble)', () => {
    // Verified against /usr/bin/find: `find . -not -exec false ;`
    // exits 0 — the user explicitly inverted the predicate, so every
    // entry "succeeds" from find's view AND find's own exit reflects
    // only the walk. Stdout stays empty because -exec is in the tree
    // (default -print suppressed); a regression that re-enabled the
    // implicit print under -not would slip through if we only checked
    // exit code.
    const t = createTerminal(SOURCES)
    const r = t.run('find src -type f -not -exec false ";"')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, '', 'implicit -print should stay suppressed when -exec is in the tree')
  })

  it('find -exec on a non-existent command surfaces stderr but exits 0', () => {
    // Verified against /usr/bin/find: the "command not found" error
    // goes to stderr but find itself still exits 0 — the dispatch
    // failure is exec output, not a find error.
    const t = createTerminal(SOURCES)
    const r = t.run('find src -type f -exec definitelynotacmd ";"')
    assert.equal(r.exitCode, 0)
    assert.match(r.stderr, /definitelynotacmd/u)
  })

  it('find continues past a missing start path (does not abort the whole walk)', () => {
    // Verified against /usr/bin/find: `find src nope` walks src,
    // surfaces the error for `nope` on stderr, and exits 1. The
    // pre-fix bug was an early `return err(...)` that discarded
    // every earlier walk's output the moment any later start failed.
    const t = createTerminal(SOURCES)
    const r = t.run('find src nope')
    assert.equal(r.exitCode, 1)
    assert.match(r.stderr, /nope: no such file or directory/u)
    // src's entries must still appear despite nope's failure.
    const lines = r.stdout.split('\n').filter(Boolean).sort()
    assert.ok(lines.includes('src/foo.js'), `expected src/foo.js in stdout, got ${JSON.stringify(lines)}`)
    assert.ok(lines.includes('src/bar.js'))
  })

  it('find -exec ... + with a non-existent command bubbles exit 1 (clamped, not 127)', () => {
    // Verified against /usr/bin/find 4.9: a "command not found"
    // failure in the `+` form is reflected as find exit 1 — find
    // doesn't pass through the dispatcher's 127. Without the clamp,
    // ctx.dispatch's 127 would leak through unchanged.
    const t = createTerminal(SOURCES)
    const r = t.run('find src -type f -exec definitelynotacmd {} +')
    assert.equal(r.exitCode, 1, 'should be 1, not 127 (dispatcher) or 0')
    assert.match(r.stderr, /definitelynotacmd/u)
  })

  it('find -exec without `;` or `+` terminator hints at the `\\;` quoting trap', () => {
    // The canonical GNU idiom is `find ... -exec CMD \\;`, but our
    // shell parser doesn't honor backslash-escapes outside quotes,
    // so `\\;` parses as the step separator before find sees it.
    // The error message points users at the workaround.
    const t = createTerminal(SOURCES)
    const r = t.run('find src -exec echo {}')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /missing terminator/u)
    assert.match(r.stderr, /quoted|\\\\;/u, 'should hint at the shell-escape trap')
  })

  it('find -exec ... + DOES bubble its exit code (unlike the `;` form)', () => {
    // Verified against /usr/bin/find 4.9:
    //   `find . -exec false ;` exits 0
    //   `find . -exec false {} +` exits 1
    // The `+` form runs an actual batched command on the collected
    // list — its exit code is the command's result, not a predicate
    // input, so it bubbles to find's exit. The `;` form's exit code
    // is a per-match predicate signal and stays bottled.
    const t = createTerminal(SOURCES)
    const r = t.run('find src -type f -exec false {} +')
    assert.equal(r.exitCode, 1)
    // Success in the `+` form keeps find at 0.
    const r2 = t.run('find src -type f -exec true {} +')
    assert.equal(r2.exitCode, 0)
    // Empty batch: collector is empty, no dispatch, exit 0 (matches
    // xargs -r behavior — verified separately below).
    const r3 = t.run('find src -type f -name "*.zzz" -exec false {} +')
    assert.equal(r3.exitCode, 0)
  })

  it("find -exec `{}` in-arg substitution: prefix / suffix / multiple / no-op edge cases", () => {
    // Verified against /usr/bin/find 4.9: every literal `{}` in each
    // argument is replaced (not just standalone `{}`).
    const t = createTerminal({ 'a.txt': 'x\n' })
    assert.equal(t.run("find a.txt -exec echo '{}-suffix' ';'").stdout, 'a.txt-suffix\n')
    assert.equal(t.run("find a.txt -exec echo 'prefix-{}' ';'").stdout, 'prefix-a.txt\n')
    assert.equal(t.run("find a.txt -exec echo '{}{}' ';'").stdout, 'a.txta.txt\n')
    // {{}} → {a.txt}: outer braces are literal, inner {} substitutes.
    assert.equal(t.run("find a.txt -exec echo '{{}}' ';'").stdout, '{a.txt}\n')
    // { } (with space) is NOT a placeholder — no substitution.
    assert.equal(t.run("find a.txt -exec echo '{ }' ';'").stdout, '{ }\n')
  })

  it('find -exec ... + batches every collected path into a single dispatch', () => {
    const t = createTerminal(SOURCES)
    // echo all paths on one line; `+` joins them with spaces.
    const r = t.run('find src -type f -exec echo {} +')
    assert.equal(r.exitCode, 0)
    const line = r.stdout.replace(/\n$/u, '')
    // One line, three paths, space-separated. Sort the tokens so the
    // assertion doesn't depend on walk order.
    assert.deepEqual(line.split(' ').sort(), ['src/bar.js', 'src/foo.js', 'src/util/log.js'])
  })

  it('find src -type f -name "*.txt" -exec wc -l {} + (the originally attempted invocation)', () => {
    // The flag combination that prompted this feature. With a fixture
    // that has .txt files, `+` collects every match and runs wc -l
    // once with the full list — output includes a `total` row, which
    // is wc's per-batch summary.
    const t = createTerminal({
      'src/a.txt': 'one\ntwo\nthree\n',
      'src/b.txt': 'only-one\n',
      'src/skip.md': 'ignored\n',
    })
    const r = t.run('find src -type f -name "*.txt" -exec wc -l {} +')
    assert.equal(r.exitCode, 0)
    // Both .txt files appear, the .md does not, and wc adds a `total`
    // row for the multi-file batch.
    assert.match(r.stdout, /^\s*3\s+src\/a\.txt$/mu)
    assert.match(r.stdout, /^\s*1\s+src\/b\.txt$/mu)
    assert.match(r.stdout, /^\s*4\s+total$/mu)
    assert.doesNotMatch(r.stdout, /skip\.md/u)
  })

  it('find -exec sed -n {} + uses cumulative line numbering (post-PR #24 seam guard)', () => {
    // Cross-command regression guard: now that sed accepts multiple
    // files, `find ... -exec sed ... +` runs sed once with every
    // match. Sed concatenates them with cumulative numbering — so
    // `-n '1,2p'` returns the first 2 lines of the FIRST file only,
    // NOT the first 2 lines of each file. Faithful to GNU; pin it
    // so a future "per-file" reinterpretation can't slip in silently.
    const t = createTerminal({
      'dir/a.txt': 'A1\nA2\nA3\n',
      'dir/b.txt': 'B1\nB2\nB3\n',
    })
    const r = t.run("find dir -type f -name '*.txt' -exec sed -n '1,2p' {} +")
    assert.equal(r.exitCode, 0)
    // Cumulative numbering: lines 1-2 of (a.txt + b.txt) = A1, A2.
    assert.equal(r.stdout, 'A1\nA2\n')
  })

  it('find -exec ... + with zero matches skips the dispatch (xargs -r convention)', () => {
    const t = createTerminal(SOURCES)
    // `*.zzz` matches nothing; the batched echo must NOT run with an
    // empty path list (otherwise we\'d get a spurious blank line).
    const r = t.run('find src -type f -name "*.zzz" -exec echo {} +')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, '')
  })

  it('find -exec validation: missing terminator, missing command, and `+` without `{}`', () => {
    const t = createTerminal(SOURCES)
    // No `;` or `+` ever appears.
    const noTerm = t.run('find src -type f -exec echo {}')
    assert.notEqual(noTerm.exitCode, 0)
    assert.match(noTerm.stderr, /missing terminator/u)
    // `;` immediately after -exec — no command at all.
    const noCmd = t.run('find src -type f -exec ";"')
    assert.notEqual(noCmd.exitCode, 0)
    assert.match(noCmd.stderr, /requires a command/u)
    // `+` form must end in `{}`.
    const badPlus = t.run('find src -type f -exec echo +')
    assert.notEqual(badPlus.exitCode, 0)
    assert.match(badPlus.stderr, /`\{\}` must be the last argument/u)
  })

  it('find -exec composes with -type / -name and runs only on the filtered set', () => {
    const t = createTerminal(SOURCES)
    // -name '*.md' constrains the set; -exec echo runs only for matches.
    const r = t.run('find / -type f -name "*.md" -exec echo {} ";"')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout.split('\n').filter(Boolean).sort().join(','), '/README.md')
  })

  it('find -exec ... + rejects multiple `{}` instances (POSIX/GNU)', () => {
    // The leading `{}` would otherwise pass through literally because
    // only the trailing arg is checked / replaced — confusing and
    // inconsistent with GNU.
    const t = createTerminal(SOURCES)
    const r = t.run('find src -exec echo {} {} +')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /only one instance of `\{\}`/u)
  })

  it('find rejects `-not -exec ... +` (incoherent under always-true batching)', () => {
    // The `+` form is treated as always-true during the walk because
    // it can't filter before the post-walk dispatch. Negating that
    // would either silently drop every match or still run the batched
    // command anyway — pick neither, surface the error.
    const t = createTerminal(SOURCES)
    const r = t.run('find src -not -exec echo {} +')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /no meaningful negation/u)
  })

  it('basename / dirname operate on path strings', () => {
    const t = createTerminal(SOURCES)
    assert.equal(t.run('basename /src/foo.js').stdout, 'foo.js\n')
    assert.equal(t.run('dirname /src/foo.js').stdout, '/src\n')
  })

  it('tree prints a hierarchy', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('tree /src')
    assert.match(r.stdout, /foo\.js/u)
    assert.match(r.stdout, /util\//u)
    assert.match(r.stdout, /log\.js/u)
  })

  it('tree errors when the target is not a directory or is missing', () => {
    const t = createTerminal(SOURCES)
    const missing = t.run('tree /nope')
    assert.notEqual(missing.exitCode, 0)
    assert.match(missing.stderr, /not a directory/u)
    const onFile = t.run('tree src/foo.js')
    assert.notEqual(onFile.exitCode, 0)
    assert.match(onFile.stderr, /not a directory/u)
  })

  it('basename and dirname handle root, trailing slash, and unrooted names (matches coreutils)', () => {
    const t = createTerminal(SOURCES)
    // Pinning behaviour verified against `/usr/bin/basename` and
    // `/usr/bin/dirname` on each case.
    assert.equal(t.run('basename /foo/bar').stdout, 'bar\n')
    assert.equal(t.run('basename /foo/').stdout, 'foo\n')   // trailing slash stripped
    assert.equal(t.run('basename /').stdout, '/\n')         // root returns root
    assert.equal(t.run('basename foo').stdout, 'foo\n')     // unrooted
    assert.equal(t.run('dirname /foo/bar').stdout, '/foo\n')
    assert.equal(t.run('dirname /foo').stdout, '/\n')       // root parent
    assert.equal(t.run('dirname /').stdout, '/\n')          // root → root
    assert.equal(t.run('dirname foo').stdout, '.\n')        // unrooted → .
  })
})

describe('createTerminal — errors', () => {
  it('unknown command exits 127 with a usage hint', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('frobnicate')
    assert.equal(r.exitCode, 127)
    assert.match(r.stderr, /command not found/u)
    assert.match(r.stderr, /Available: /u)
    assert.match(r.stderr, /\bcat\b/u)
  })

  it('/bin/, /sbin/, /usr/bin/, /usr/local/bin/ prefixes resolve to the registered command', () => {
    const t = createTerminal(SOURCES)
    // Bare and prefixed forms produce identical results for any
    // registered command — same stdout, same exit code.
    const bare = t.run('ls')
    for (const prefix of ['/bin/', '/sbin/', '/usr/bin/', '/usr/local/bin/']) {
      const r = t.run(`${prefix}ls`)
      assert.equal(r.stdout, bare.stdout, `${prefix}ls: stdout mismatch`)
      assert.equal(r.exitCode, bare.exitCode, `${prefix}ls: exit mismatch`)
    }
    // Args pass through to the resolved command.
    assert.equal(t.run('/bin/echo hi').stdout, 'hi\n')
    assert.equal(t.run('/usr/bin/grep TODO src/foo.js').stdout, '// TODO: fix\n')
    assert.equal(t.run('/usr/local/bin/echo hi').stdout, 'hi\n')
    // Works inside pipelines too — dispatch is the single entry point.
    assert.equal(t.run('echo hi | /bin/cat').stdout, 'hi\n')
  })

  it('prefixed names that do not resolve to a known command still error', () => {
    const t = createTerminal(SOURCES)
    // The bare name isn't registered, so the prefix isn't stripped
    // and the not-found error reflects what was typed.
    const r = t.run('/bin/frobnicate')
    assert.equal(r.exitCode, 127)
    assert.match(r.stderr, /\/bin\/frobnicate: command not found/u)
  })

  it('Object.prototype names are not dispatchable as commands', () => {
    // Without `__proto__: null` on the registries, `COMMANDS['toString']`
    // would surface `Object.prototype.toString` and dispatch() would
    // happily call it. Pin the registry isolation so a future spread
    // refactor can't reintroduce the prototype chain.
    const t = createTerminal(SOURCES)
    for (const name of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__']) {
      const r = t.run(name)
      assert.equal(r.exitCode, 127, `${name}: expected 127`)
      assert.match(r.stderr, /command not found/u, `${name}: expected "command not found"`)
    }
  })

  it('unterminated quote returns an error result, not a throw', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('echo "hi')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /unterminated/u)
  })

  it('empty pipeline stage errors', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('cat |')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /empty pipeline/u)
  })

  it('grep invalid pattern names the dialect in the error', () => {
    // With the default BRE dialect, a bare `(` is literal, so the
    // user's original "Function(" case no longer errors — covered
    // in the BRE-default describe block below. But asking for ERE
    // explicitly preserves the ECMAScript-style error path.
    const t = createTerminal(SOURCES)
    const r = t.run('grep -E "Function(" src/foo.js')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /ERE|ECMAScript/u)
  })
})

describe('createTerminal — strict option parsing', () => {
  // Every command rejects unknown short / long / bundled flags.
  // Variants chosen to cover: bare short, bundled short, long form.
  const cases = [
    'cat -z foo',
    'cat --bogus foo',
    'grep -z PAT',
    'grep -ivz PAT',
    'grep --bogus PAT',
    'head -z',
    'head --bogus',
    'tail -z',
    'tail --bogus',
    'wc -z',
    'wc -lz',
    'sort -z',
    'sort --bogus',
    'uniq -z',
    'echo -z hi',
    'echo --bogus',
    'ls -z',
    'ls -laz',
    'find -z',
    'find --bogus',
    'tree -z',
    'tree --bogus',
    'cd -z',
    'pwd -z',
    'pwd --bogus',
    'basename -z foo',
    'dirname -z foo',
    'xargs -z echo',
  ]
  for (const line of cases) {
    it(`rejects: ${line}`, () => {
      const t = createTerminal(SOURCES)
      const r = t.run(line)
      assert.notEqual(r.exitCode, 0, 'expected non-zero exit')
      assert.match(r.stderr, /unknown option/u, 'expected "unknown option" in stderr')
    })
  }

  it('-- ends flag parsing so leading-dash positionals survive', () => {
    const t = createTerminal(SOURCES)
    assert.equal(t.run('echo -- -z hi').stdout, '-z hi\n')
    // After `--`, `-z` is treated as a filename — cat tries to read it.
    const r = t.run('cat -- -z')
    assert.equal(r.exitCode, 1)
    assert.match(r.stderr, /no such file/u)
  })

  it('numeric-prefixed args (e.g. negative numbers) stay positional', () => {
    const t = createTerminal(SOURCES)
    assert.equal(t.run('echo -5').stdout, '-5\n')
  })

  it('quoted args carrying whitespace are positional, not options', () => {
    const t = createTerminal(SOURCES)
    // A token with an embedded space can only be a quoted string, so it
    // is data even when it starts like a flag — the whitespace sibling
    // of the pure-dash `echo "---"` rule. Matches bash echo.
    assert.equal(t.run('echo "---- foo ----"').stdout, '---- foo ----\n')
    assert.equal(t.run('echo "-- foo"').stdout, '-- foo\n')
    assert.equal(t.run('echo "-n hi"').stdout, '-n hi\n')
    assert.equal(t.run('echo "---"').stdout, '---\n')
    // Quoting ALONE isn't enough (bash agrees): a dash token with no
    // whitespace is still a flag — `"-n"` drops the newline — and an
    // empty token is just an empty positional.
    assert.equal(t.run('echo "-n"').stdout, '')
    assert.equal(t.run('echo ""').stdout, '\n')
    // Unquoted single-token flags are still parsed strictly.
    assert.match(t.run('echo -z hi').stderr, /unknown option/u)
    // The rule lives in the shared parser, so it reaches every command:
    // `grep "-- foo"` searches for the literal pattern rather than
    // erroring on a malformed option.
    const g = createTerminal({ 'f.txt': '-- foo\nbar\n' })
    assert.equal(g.run('grep "-- foo" f.txt').stdout, '-- foo\n')
  })
})

describe('createTerminal — xargs', () => {
  it('appends stdin tokens to the command args', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('echo /src/foo.js /src/bar.js | xargs cat')
    assert.match(r.stdout, /TODO: fix/u)
    assert.match(r.stdout, /export function bar/u)
  })

  it('-n N invokes the command once per chunk', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('echo a b c | xargs -n 1 echo')
    assert.equal(r.stdout, 'a\nb\nc\n')
  })

  it('-r skips the run when stdin is empty', () => {
    const t = createTerminal(SOURCES)
    const empty = t.run('grep ZZZ src/foo.js | xargs -r echo hello')
    assert.equal(empty.stdout, '')
    // Without -r, xargs runs echo once with no extra args.
    const noR = t.run('grep ZZZ src/foo.js | xargs echo hello')
    assert.equal(noR.stdout, 'hello\n')
  })

  it('defaults to echo when no command is given', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('echo a b c | xargs')
    assert.equal(r.stdout, 'a b c\n')
  })

  it('propagates exit codes from the inner command', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('echo /src/missing.js | xargs cat')
    assert.equal(r.exitCode, 1)
    assert.match(r.stderr, /no such file/u)
  })

  it('reports unknown inner commands the same way as bare dispatch', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('echo a | xargs frobnicate')
    assert.equal(r.exitCode, 127)
    assert.match(r.stderr, /command not found/u)
  })

  it('-n 0 is rejected (would otherwise silently degrade to no chunking)', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('echo a b c | xargs -n 0 echo')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /at least 1/u)
  })

  it('flags after the inner command name belong to the inner command, not xargs', () => {
    // Without stopAtFirstPositional, xargs would greedily parse
    // `-n PATTERN` as its own chunk-size flag and die in
    // parsePositiveInt('PATTERN'). With the fix, those flags
    // pass through to grep verbatim.
    const t = createTerminal(SOURCES)
    const r = t.run('echo src/foo.js | xargs grep -n TODO')
    assert.equal(r.exitCode, 0)
    assert.match(r.stdout, /^2:\/\/ TODO: fix\n$/u)
  })
})

describe('createTerminal — pathological inputs', () => {
  it('createTerminal handles very deep paths without overflowing the stack', () => {
    // ensureDir previously recursed up `dirname` per ancestor; a
    // path with thousands of segments overflowed the stack at
    // construction time. The iterative form scales linearly.
    const depth = 5000
    const path = Array.from({ length: depth }, (_, i) => `d${i}`).join('/') + '/leaf.txt'
    const t = createTerminal({ [path]: 'hi' })
    assert.equal(t.run(`cat /${path}`).stdout, 'hi')
  })
})

describe('createTerminal — read-only filesystem', () => {
  it('rejects `>` to a real path with a friendly message that suggests `|`', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('cat src/foo.js > out.txt')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /read-only/u)
    assert.match(r.stderr, /`\|`/u)
  })

  it('rejects `>>` (append) the same way', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('echo hi >> log')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /read-only/u)
  })

  it('a `>` inside a quoted string is data, not a redirect', () => {
    const t = createTerminal(SOURCES)
    assert.equal(t.run('echo "a > b"').stdout, 'a > b\n')
  })

  it('a fully-quoted boundary char is data, not a structural token', () => {
    // Earlier the tokenizer emitted a string '|' / '>' for both
    // unquoted and quoted single-char tokens, so `echo "|" foo`
    // silently split into two pipeline stages and `echo ">"` was
    // rejected as a redirect. Now boundary tokens are tagged by
    // `kind`, so these all pass through as ordinary words.
    const t = createTerminal(SOURCES)
    assert.equal(t.run('echo "|" foo').stdout, '| foo\n')
    assert.equal(t.run('echo ">"').stdout, '>\n')
    assert.equal(t.run('echo ">>"').stdout, '>>\n')
    assert.equal(t.run('echo "&&"').stdout, '&&\n')
  })

  it('the suggested `|` form works for the same logical task', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('cat src/foo.js | grep TODO')
    assert.equal(r.exitCode, 0)
    assert.match(r.stdout, /TODO/u)
  })
})

describe('createTerminal — /dev/null redirects', () => {
  it('`2>/dev/null` suppresses stderr while leaving exit code and stdout intact', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('cat /nope 2>/dev/null')
    assert.equal(r.exitCode, 1)
    assert.equal(r.stderr, '')
    assert.equal(r.stdout, '')
  })

  it('`>/dev/null` and `1>/dev/null` discard stdout', () => {
    const t = createTerminal(SOURCES)
    assert.equal(t.run('echo hi > /dev/null').stdout, '')
    assert.equal(t.run('echo hi 1>/dev/null').stdout, '')
    // Exit code and stderr unaffected.
    const r = t.run('cat /nope 1>/dev/null')
    assert.equal(r.exitCode, 1)
    assert.match(r.stderr, /no such file/u)
  })

  it('redirects only allow `/dev/null` as the target', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('cat src/foo.js 2> err.log')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /read-only/u)
    // Suggestion mentions both the pipe alternative and /dev/null.
    assert.match(r.stderr, /\/dev\/null/u)
  })

  it('a missing redirect target errors clearly', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('cat foo 2>')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /requires a target/u)
  })

  it('redirect attaches to its own stage in a pipeline', () => {
    const t = createTerminal(SOURCES)
    // cat's stderr is suppressed; head still sees cat's stdout.
    const r = t.run('cat /nope 2>/dev/null | head -n 5')
    assert.equal(r.stderr, '')
    assert.equal(r.stdout, '')
    // head exits 0 (it got empty stdin and produced empty stdout),
    // so the pipeline's exit code is head's.
    assert.equal(r.exitCode, 0)
  })
})

describe('createTerminal — `2>&1` fd-to-fd redirects', () => {
  it('`2>&1` merges stderr into stdout, leaves stderr empty', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('cat /nope 2>&1')
    // cat /nope failed: error message that was previously on stderr
    // is now on stdout. Exit code is preserved.
    assert.equal(r.exitCode, 1)
    assert.equal(r.stderr, '')
    assert.match(r.stdout, /no such file/u)
  })

  it('`2>&1 | …` lets the next stage see both streams', () => {
    const t = createTerminal(SOURCES)
    // Without 2>&1, grep would see only cat's empty stdout. With it,
    // cat's stderr is folded into the pipe so grep can match on it.
    const r = t.run('cat /nope 2>&1 | grep "no such"')
    assert.equal(r.exitCode, 0)
    assert.match(r.stdout, /no such file/u)
    assert.equal(r.stderr, '')
  })

  it('`>/dev/null 2>&1` silences both streams', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('cat /nope >/dev/null 2>&1')
    assert.equal(r.exitCode, 1)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '')
  })

  it('`1>&2` merges stdout into stderr (symmetric)', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('echo hi 1>&2')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, 'hi\n')
  })

  it('quoting suppresses fd-to-fd recognition', () => {
    // `"2>&1"` is just an argv token — echo prints it verbatim.
    const t = createTerminal(SOURCES)
    const r = t.run('echo "2>&1"')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, '2>&1\n')
  })

  it('redirect attaches to its own stage in a pipeline', () => {
    const t = createTerminal(SOURCES)
    // Only the first stage merges; head's own stderr (none here) is
    // unaffected. Confirms the flag is per-stage, not per-pipeline.
    const r = t.run('cat /nope 2>&1 | head -n 1')
    assert.equal(r.exitCode, 0)
    assert.match(r.stdout, /no such file/u)
    assert.equal(r.stderr, '')
  })

  it('malformed `N>&` forms surface a redirect-target error, not "background processes"', () => {
    // Per Copilot review: previously each of these tokenized as
    // `2>` + a stray `&...` token, with the `&` triggering the
    // background-process branch and producing a misleading error.
    const t = createTerminal(SOURCES)
    for (const cmd of [
      'echo hi 2>&',         // missing fd
      'echo hi 2>&3',        // invalid fd (only 1 / 2 supported)
      'echo hi 2>&1foo',     // valid fd but no token boundary after
    ]) {
      const r = t.run(cmd)
      assert.notEqual(r.exitCode, 0, `${cmd}: expected non-zero exit`)
      assert.match(r.stderr, /2>&/u, `${cmd}: stderr should name the redirect`)
      assert.doesNotMatch(r.stderr, /background processes/u, `${cmd}: should not surface amp error`)
    }
  })
})

describe('createTerminal — && / || sequencing', () => {
  it('`&&` runs the next step only when the previous succeeded', () => {
    const t = createTerminal(SOURCES)
    const ok = t.run('pwd && echo next')
    assert.equal(ok.exitCode, 0)
    assert.equal(ok.stdout, '/\nnext\n')
    const fail = t.run('cat /nope 2>/dev/null && echo next')
    assert.equal(fail.exitCode, 1)
    assert.equal(fail.stdout, '')
  })

  it('`||` runs the next step only when the previous failed', () => {
    const t = createTerminal(SOURCES)
    const recover = t.run('cat /nope 2>/dev/null || echo recovered')
    assert.equal(recover.exitCode, 0)
    assert.equal(recover.stdout, 'recovered\n')
    const noRecover = t.run('pwd || echo unreached')
    assert.equal(noRecover.exitCode, 0)
    assert.equal(noRecover.stdout, '/\n')
  })

  it('chains `&& ... && ...` short-circuit on first failure', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('cat /nope 2>/dev/null && echo a && echo b')
    assert.equal(r.exitCode, 1)
    assert.equal(r.stdout, '')
  })

  it('the exact command from the request runs end-to-end', () => {
    // Existing /dir scenario: /dir is absent → first step fails →
    // && short-circuits the rest. Stderr is suppressed.
    const t = createTerminal(SOURCES)
    const missing = t.run('ls /dir 2>/dev/null && echo "---" && cat /dir/1.txt 2>/dev/null | head -200')
    assert.equal(missing.exitCode, 1)
    assert.equal(missing.stdout, '')
    assert.equal(missing.stderr, '')
    // Now with the dir + file present: the chain runs fully.
    const present = createTerminal({
      'dir/1.txt': 'line 1\nline 2\nline 3\n',
      'dir/other.md': 'x',
    })
    const r = present.run('ls /dir 2>/dev/null && echo "---" && cat /dir/1.txt 2>/dev/null | head -200')
    assert.equal(r.exitCode, 0)
    assert.match(r.stdout, /1\.txt/u)
    assert.match(r.stdout, /---/u)
    assert.match(r.stdout, /^line 1$/mu)
    assert.match(r.stdout, /^line 3$/mu)
  })

  it('`&` alone (background) is rejected with a clear message', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('echo hi &')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /background/u)
  })
})

describe('createTerminal — `;` sequential separator', () => {
  it('`cmd1 ; cmd2` runs both regardless of cmd1 exit', () => {
    const t = createTerminal(SOURCES)
    // First command fails (no /nope); second still runs. Final exit
    // is the second command's, matching bash's `;` semantics.
    const r = t.run('cat /nope 2>/dev/null ; echo after')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'after\n')
  })

  it('trailing `;` is a no-op (`cmd ;` == `cmd`)', () => {
    // Trailing `;` would otherwise hit the empty-pipeline guard;
    // tolerated so users typing `cmd ;` out of habit don't error.
    const t = createTerminal(SOURCES)
    assert.equal(t.run('echo hi ;').stdout, 'hi\n')
    assert.equal(t.run('echo hi;').stdout, 'hi\n')
    assert.equal(t.run('echo a ; echo b ;').stdout, 'a\nb\n')
  })

  it('reported failure: `cmd1 2>&1; cmd2 2>&1` (regression case)', () => {
    // `;` next to `2>&1` was a layered failure: the fd-to-fd
    // boundary check rejected the `;` and didn't even reach step
    // separation. Both layers are now fixed.
    const t = createTerminal(SOURCES)
    const r = t.run('cat /nope 2>&1; echo hi 2>&1')
    assert.equal(r.exitCode, 0)
    assert.match(r.stdout, /no such file/u)
    assert.match(r.stdout, /^hi$/mu)
  })

  it('leading `;` errors (empty left-hand step)', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('; echo hi')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /empty pipeline/u)
  })

  it('consecutive `;;` errors', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('echo a ;; echo b')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /empty pipeline/u)
  })

  it('a quoted `;` stays a literal argv token', () => {
    const t = createTerminal(SOURCES)
    assert.equal(t.run('echo "a;b"').stdout, 'a;b\n')
  })

  it('an unquoted mid-token `;` splits into two commands (bash compat)', () => {
    // `echo a;b` is two commands in bash — `echo a`, then `b`
    // (command not found). Whitespace is not required around `;`.
    // Pinned because the PR adding `;` initially described it as
    // "mid-word stays literal", which would diverge from bash.
    const t = createTerminal(SOURCES)
    const r = t.run('echo a;echo b')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'a\nb\n')
  })
})

describe('createTerminal — newline command separator', () => {
  it('reported failure: a pasted `ls` / `echo` / `pwd` block runs line by line', () => {
    // Was: the three lines collapsed into one `ls echo "---" pwd`
    // invocation, so `ls` reported `echo` / `---` / `pwd` as missing
    // files. An unquoted newline now ends each command like `;`.
    const t = createTerminal(SOURCES)
    const r = t.run('ls\necho "---"\npwd')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stderr, '')
    assert.equal(r.stdout, 'src/\nREADME.md\n---\n/\n')
  })

  it('a newline separates commands like `;` (exit is the last command\'s)', () => {
    const t = createTerminal(SOURCES)
    // First command fails; second still runs and sets the final exit.
    const r = t.run('cat /nope 2>/dev/null\necho after')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'after\n')
    const r2 = t.run('echo ok\ncat /nope 2>/dev/null')
    assert.equal(r2.exitCode, 1)
    assert.equal(r2.stdout, 'ok\n')
  })

  it('blank lines and leading/trailing newlines are no-ops', () => {
    const t = createTerminal(SOURCES)
    // Interior blank lines are the tokenizer's job (a newline after a
    // `;`/newline is absorbed); the leading/trailing pair is handled
    // upstream by safeRun's `line.trim()` before parsing.
    assert.equal(t.run('echo a\n\n\necho b').stdout, 'a\nb\n')
    assert.equal(t.run('\n\necho hi\n\n').stdout, 'hi\n')
    assert.equal(t.run('\n\n').exitCode, 0)
  })

  it('a newline after `&&` / `||` / `|` / `(` continues the command', () => {
    const t = createTerminal(SOURCES)
    assert.equal(t.run('echo a &&\necho b').stdout, 'a\nb\n')
    assert.equal(t.run('false ||\necho fallback').stdout, 'fallback\n')
    assert.equal(t.run('echo hi |\ncat').stdout, 'hi\n')
    assert.equal(t.run('(\necho grouped\n)').stdout, 'grouped\n')
  })

  it('a newline inside quotes (single or double) stays a literal character', () => {
    const t = createTerminal(SOURCES)
    // The break is data here, not a separator: one `echo` prints a
    // two-line argument. Single and double quotes take different
    // tokenizer branches, so pin both.
    assert.equal(t.run('echo "a\nb"').stdout, 'a\nb\n')
    assert.equal(t.run("echo 'a\nb'").stdout, 'a\nb\n')
  })

  it('only `\\n` separates: `\\r\\n` splits cleanly, a lone `\\r` does not', () => {
    const t = createTerminal(SOURCES)
    // `\r\n` (Windows paste): the `\r` ends the word as whitespace,
    // then the `\n` separates — two clean commands, no stray CR.
    assert.equal(t.run('echo a\r\necho b').stdout, 'a\nb\n')
    // A lone `\r` is NOT a separator (only `\n` is); it falls through
    // to the whitespace branch, so this stays a single `echo` — exit
    // 0, never a `b: command not found` split.
    const lone = t.run('echo a\recho b')
    assert.equal(lone.exitCode, 0)
    assert.equal(lone.stdout, 'a echo b\n')
  })

  it('a newline separates whole pipelines, and cwd persists across lines', () => {
    const t = createTerminal(SOURCES)
    // Each line is its own step in the same terminal: the `cd` on line
    // 1 is visible to `pwd` on line 3, and the middle line is a full
    // `cat | grep` pipeline terminated by the newline (not a bare cmd).
    const r = t.run('cd src\ncat foo.js | grep TODO\npwd')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, '// TODO: fix\n/src\n')
  })

  it('newlines and `;` interleave freely', () => {
    const t = createTerminal(SOURCES)
    assert.equal(t.run('echo a; echo b\necho c').stdout, 'a\nb\nc\n')
  })

  it('a gate left dangling at end-of-input still errors (newline does not satisfy it)', () => {
    // A newline right after `&&` is absorbed as a continuation, so with
    // nothing following, the `&&` has no right-hand step — the same
    // error as a bare trailing `&&`. (Bash would prompt for more.)
    const t = createTerminal(SOURCES)
    const r = t.run('echo a &&\n')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /empty pipeline/u)
  })
})

describe('createTerminal — `(...)` subshell grouping', () => {
  it('`(cmd)` runs the inner pipeline and surfaces its output / exit', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('(echo hi)')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'hi\n')
    assert.equal(r.stderr, '')
  })

  it('`(cd dir; pwd)` reports the inner cwd but does NOT leak it', () => {
    // The defining feature of a subshell: cwd changes are scoped to
    // the group. `pwd` inside sees the moved cwd; after the group
    // returns, the outer terminal is right back where it started.
    const t = createTerminal(SOURCES)
    assert.equal(t.cwd(), '/')
    const r = t.run('(cd src; pwd)')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, '/src\n')
    assert.equal(t.cwd(), '/')
    // Independent confirmation: pwd outside still reads `/`.
    assert.equal(t.run('pwd').stdout, '/\n')
  })

  it('cwd is restored even when the inner pipeline fails partway', () => {
    // `cd src` moves the inner cwd; the next command exits 1; the
    // group as a whole still has to put the outer cwd back.
    const t = createTerminal(SOURCES)
    const r = t.run('(cd src && false)')
    assert.equal(r.exitCode, 1)
    assert.equal(t.cwd(), '/')
  })

  it('`(...) | cmd` pipes the group output into the next stage', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('(echo a; echo b; echo c) | grep b')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'b\n')
  })

  it('`cmd | (...)` delivers stdin to the group\'s first step only', () => {
    // Bash semantics for a string-typed stdin: the group "owns" the
    // pipe, and within the group only the first command in the first
    // step gets to read it. Later steps (after `;`/gates) see empty.
    const t = createTerminal(SOURCES)
    const r = t.run('echo hi | (cat; echo done)')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'hi\ndone\n')
  })

  it('`cmd | (true; cat)` — second step sees empty stdin (documented divergence)', () => {
    // Diverges from real bash (where `cat` would inherit the pipe fd
    // and print "hi"). Our string-typed pipe can only deliver stdin
    // to one consumer, and the chosen consumer is the first step.
    // Pinning this so a future "let any step read it" change is a
    // deliberate decision, not an accident.
    const t = createTerminal(SOURCES)
    const r = t.run('echo hi | (true; cat)')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, '')
  })

  it('stdin reaches a multi-stage pipeline inside the group', () => {
    // The "first step" caveat is about steps (`;`/gates), not stages
    // (`|`). Within the group's first step, the pipeline threads stdin
    // through stages normally, so `(cat | wc -l)` should count.
    const t = createTerminal(SOURCES)
    const r = t.run('echo hi | (cat | wc -l)')
    assert.equal(r.exitCode, 0)
    assert.match(r.stdout, /^\s*1$/mu)
  })

  it('groups on both sides of `|`', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('(echo a; echo b) | (cat; echo c)')
    assert.equal(r.exitCode, 0)
    // Left group emits "a\nb\n", right group's first step (cat) reads
    // it; the second step (echo c) sees empty stdin and prints "c".
    assert.equal(r.stdout, 'a\nb\nc\n')
  })

  it('brace and glob expansion happen inside groups', () => {
    // Both expansions are stage-local — they live in runStage, which
    // the group's inner runSteps reaches through runPipeline. Worth
    // pinning because the group path skips runStage entirely; if a
    // future refactor moves expansion to runPipeline's outer scope
    // it could regress.
    const t = createTerminal(SOURCES)
    assert.equal(t.run('(echo {a,b,c})').stdout, 'a b c\n')
    // Glob uses the SUBSHELL's cwd, not the outer's. cd inside the
    // group moves into src; the star expands against /src.
    const r = t.run('(cd src; ls *.js)')
    assert.equal(r.exitCode, 0)
    assert.match(r.stdout, /foo\.js/u)
    assert.match(r.stdout, /bar\.js/u)
  })

  it('`(... && ... ; ... || ...)` runs multi-gate chains inside the group', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('(true && echo y; false || echo n)')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'y\nn\n')
    // Inner failure shadows outer gate: group exits with the LAST
    // step's exit code, just like a bash subshell.
    const failed = t.run('(true; false) && echo never')
    assert.equal(failed.exitCode, 1)
    assert.equal(failed.stdout, '')
  })

  it('group cwd is restored to the OUTER cwd (not always `/`)', () => {
    // The save/restore must use the cwd at the moment the group
    // started, not a hardcoded root. Cover this by parking the
    // outer terminal in /src first.
    const t = createTerminal(SOURCES, { cwd: '/src' })
    assert.equal(t.cwd(), '/src')
    const r = t.run('(cd /; pwd)')
    assert.equal(r.stdout, '/\n')
    assert.equal(t.cwd(), '/src')
    // Sequential groups: each restore is independent, none leak.
    t.run('(cd /); (cd util)')
    assert.equal(t.cwd(), '/src')
  })

  it('`(...) || cmd` and `(...) && cmd` gate on the group\'s exit', () => {
    const t = createTerminal(SOURCES)
    assert.equal(t.run('(false) || echo recovered').stdout, 'recovered\n')
    assert.equal(t.run('(true) && echo yes').stdout, 'yes\n')
    assert.equal(t.run('(false) && echo skipped').stdout, '')
    // Inner gate determines the group's exit code.
    const inner = t.run('(false || true) && echo yes')
    assert.equal(inner.exitCode, 0)
    assert.equal(inner.stdout, 'yes\n')
  })

  it('`(...) >/dev/null` redirects apply to the whole group', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('(echo a; echo b) >/dev/null')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, '')
    // 2>&1 on the group merges everything; the trailing /dev/null then
    // discards the merged stream — both stdout AND stderr must be empty.
    const silenced = t.run('(cat /nope; echo ok) 2>&1 >/dev/null')
    assert.equal(silenced.stdout, '')
    assert.equal(silenced.stderr, '')
  })

  it('leading redirects attach to a following group (bash compat)', () => {
    // `>/dev/null (cmd)` is bash-equivalent to `(cmd) >/dev/null`.
    // The redirect flag set by applyRedir must survive when the
    // in-flight stage acquires its `group`.
    const t = createTerminal(SOURCES)
    const dropped = t.run('>/dev/null (echo hi)')
    assert.equal(dropped.exitCode, 0)
    assert.equal(dropped.stdout, '')
    // Same for 2>&1: merge sets a flag, then the group runs, then the
    // merge applies to the group's combined output.
    const merged = t.run('2>&1 (cat /nope)')
    assert.match(merged.stdout, /no such file/u)
    assert.equal(merged.stderr, '')
    // Leading + trailing redirects on the same group must both apply.
    const both = t.run('2>&1 (cat /nope; echo ok) >/dev/null')
    assert.equal(both.stdout, '')
    assert.equal(both.stderr, '')
    // Leading redirect on a nested group attaches to the OUTER group,
    // not the inner — the inner is parsed by a separate buildSteps
    // call that starts with a fresh stage.
    const nested = t.run('>/dev/null ((echo hi))')
    assert.equal(nested.exitCode, 0)
    assert.equal(nested.stdout, '')
  })

  it('`(cmd 2>&1)` parses without whitespace before `)`', () => {
    // Regression: the `N>&M` boundary-after check originally listed
    // only `\s|&>;` as valid delimiters, so `2>&1)` mis-parsed as
    // "fd-dup followed by junk" and errored. `(` / `)` must count
    // as boundaries here too.
    const t = createTerminal(SOURCES)
    const r = t.run('(cat /nope 2>&1)')
    assert.equal(r.exitCode, 1)
    assert.match(r.stdout, /no such file/u)
    assert.equal(r.stderr, '')
    // Symmetric `1>&2)` form.
    const sym = t.run('(echo hi 1>&2)')
    assert.equal(sym.stdout, '')
    assert.match(sym.stderr, /^hi$/mu)
  })

  it('a group whose only contents are redirects errors (not silently dropped)', () => {
    // `(>/dev/null)` and `(echo a; >/dev/null)` both produce a step
    // whose stage has redirect flags but no argv. finishGroup must
    // NOT treat that as the trailing-`;` case — the redirect would
    // vanish and the user would never know. Also covers `2>&1` (a
    // merge flag, not a null sink) to pin that hasRedirects checks
    // the full flag set, not just the null sinks.
    const t = createTerminal(SOURCES)
    for (const cmd of [
      '(>/dev/null)',
      '(echo a; >/dev/null)',
      '(2>&1)',
      '(echo a; 2>&1)',
    ]) {
      const r = t.run(cmd)
      assert.notEqual(r.exitCode, 0, `${cmd} should error`)
      assert.match(r.stderr, /empty pipeline/u, `${cmd} should report empty pipeline`)
    }
  })

  it('nested `((...))` parses and runs', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('((echo nested))')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'nested\n')
    // Inner cd is still isolated from the outer terminal.
    t.run('((cd src; cd util))')
    assert.equal(t.cwd(), '/')
  })

  it('whitespace around `(` / `)` is optional (bash compat)', () => {
    // `(echo a)`, `( echo a )`, and `(echo a;)` should all be
    // accepted; the tokenizer flushes on `(` / `)` the same way it
    // flushes on `;` / `|`.
    const t = createTerminal(SOURCES)
    assert.equal(t.run('(echo a)').stdout, 'a\n')
    assert.equal(t.run('( echo a )').stdout, 'a\n')
    assert.equal(t.run('(echo a;)').stdout, 'a\n')
    assert.equal(t.run('(echo a);echo b').stdout, 'a\nb\n')
  })

  it('quoted parens stay literal in argv', () => {
    const t = createTerminal(SOURCES)
    assert.equal(t.run('echo "(a)"').stdout, '(a)\n')
    assert.equal(t.run("echo '(a;b)'").stdout, '(a;b)\n')
  })

  it('`()` (empty subshell) errors with a distinct message', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('()')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /empty subshell/u)
  })

  it('unmatched `(` and `)` error with clear messages', () => {
    const t = createTerminal(SOURCES)
    const open = t.run('(echo a')
    assert.notEqual(open.exitCode, 0)
    assert.match(open.stderr, /unmatched `\(`/u)
    const close = t.run('echo a)')
    assert.notEqual(close.exitCode, 0)
    assert.match(close.stderr, /unexpected `\)`/u)
  })

  it('`(` mid-stage errors instead of producing an argv+group hybrid', () => {
    // `echo a (echo b)` has no sensible interpretation — the stage
    // already has argv tokens when the `(` appears. Better to surface
    // a syntax error than to silently drop or merge.
    const t = createTerminal(SOURCES)
    const r = t.run('echo a (echo b)')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /unexpected `\(`/u)
  })

  it('a stray word after `)` errors', () => {
    // After `)` the only legal continuations are a boundary
    // (`|`/`;`/`&&`/`||`) or a redirect; bare words don't fit.
    const t = createTerminal(SOURCES)
    const r = t.run('(echo a) hi')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /after `\)`/u)
  })

  it('a redirect between two groups errors instead of producing a hybrid', () => {
    // `(echo a) 2>&1 (echo b)`: the redirect attaches to the in-flight
    // stage (which now has `group` set from the first `(...)`), then
    // the second `(` tries to set `group` again — the paren_open guard
    // catches this. Pinned so a future "let groups chain" change is
    // a deliberate decision, not silent state accumulation.
    const t = createTerminal(SOURCES)
    const r = t.run('(echo a) 2>&1 (echo b)')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /unexpected `\(`/u)
  })
})

describe('createTerminal — `true` / `false` / `:` builtins', () => {
  it('`true` exits 0 with no output (args ignored)', () => {
    const t = createTerminal(SOURCES)
    for (const cmd of ['true', 'true ignored args']) {
      const r = t.run(cmd)
      assert.equal(r.exitCode, 0)
      assert.equal(r.stdout, '')
      assert.equal(r.stderr, '')
    }
  })

  it('`false` exits 1 with no output (args ignored)', () => {
    const t = createTerminal(SOURCES)
    for (const cmd of ['false', 'false ignored args']) {
      const r = t.run(cmd)
      assert.equal(r.exitCode, 1)
      assert.equal(r.stdout, '')
      assert.equal(r.stderr, '')
    }
  })

  it('`:` (POSIX colon) is a no-op alias for `true`', () => {
    const t = createTerminal(SOURCES)
    const r = t.run(':')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, '')
  })

  it('compose cleanly with `;` / `&&` / `||` gates', () => {
    const t = createTerminal(SOURCES)
    assert.equal(t.run('false && echo skipped').stdout, '')
    assert.equal(t.run('false || echo recovered').stdout, 'recovered\n')
    assert.equal(t.run('false; echo after').stdout, 'after\n')
    assert.equal(t.run('true && echo yes').stdout, 'yes\n')
    assert.equal(t.run('true || echo no').stdout, '')
  })
})

describe('createTerminal — count validation', () => {
  it('empty string (e.g. `head -n "" file`) is rejected, not silently 0', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('head -n "" src/foo.js')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /invalid count/u)
  })

  it('`head -n --` consumes `--` as the count value (POSIX getopt)', () => {
    // A value-taking short option immediately followed by `--`
    // consumes `--` as the value, not as the terminator. The value
    // then fails parseNonNegativeInt with "invalid count", not
    // "requires a value" (which would mean no value was supplied).
    const t = createTerminal(SOURCES)
    const r = t.run('head -n -- src/foo.js')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /invalid count: --/u)
  })

  it('non-decimal counts (whitespace, hex, scientific) are rejected', () => {
    const t = createTerminal(SOURCES)
    for (const bad of ['" "', '0x10', '1e3', '+5', '-5', '1.5']) {
      const r = t.run(`head -n ${bad} src/foo.js`)
      assert.notEqual(r.exitCode, 0, `expected ${bad} to be rejected`)
    }
  })

  it('out-of-safe-range counts are rejected', () => {
    const t = createTerminal(SOURCES)
    // 2^53 = 9007199254740992 is exactly the smallest unsafe positive
    // integer for Number.isSafeInteger.
    const r = t.run('head -n 9007199254740992 src/foo.js')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /out of range/u)
  })
})

describe('createTerminal — sed line-range slice (narrow subset)', () => {
  // Build a 300-line file we can carve ranges out of.
  const NUMBERED = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  const SRC = { 'big.txt': NUMBERED }

  it('-n \'X,Yp\' prints lines X through Y inclusive from a file', () => {
    const t = createTerminal(SRC)
    const r = t.run("sed -n '140,195p' big.txt")
    assert.equal(r.exitCode, 0)
    const lines = r.stdout.split('\n').filter(Boolean)
    assert.equal(lines[0], 'line 140')
    assert.equal(lines.at(-1), 'line 195')
    assert.equal(lines.length, 195 - 140 + 1)
  })

  it('-n \'X,Yp\' from a pipe reads stdin', () => {
    const t = createTerminal(SRC)
    const r = t.run("cat big.txt | sed -n '160,230p'")
    assert.equal(r.exitCode, 0)
    const lines = r.stdout.split('\n').filter(Boolean)
    assert.equal(lines[0], 'line 160')
    assert.equal(lines.at(-1), 'line 230')
    assert.equal(lines.length, 230 - 160 + 1)
  })

  it('-n \'Np\' (single line) is supported as a degenerate range', () => {
    const t = createTerminal(SRC)
    assert.equal(t.run("sed -n '42p' big.txt").stdout, 'line 42\n')
  })

  it('range past EOF clamps silently', () => {
    const t = createTerminal(SRC)
    const r = t.run("sed -n '295,500p' big.txt")
    const lines = r.stdout.split('\n').filter(Boolean)
    assert.deepEqual(lines, ['line 295', 'line 296', 'line 297', 'line 298', 'line 299', 'line 300'])
  })

  it('range entirely past EOF produces no output, exit 0', () => {
    const t = createTerminal(SRC)
    const r = t.run("sed -n '400,500p' big.txt")
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, '')
  })

  it("-n 'X1,Y1p;X2,Y2p;…' prints multiple non-contiguous ranges in input order", () => {
    const t = createTerminal(SRC)
    // The originally-attempted invocation: three non-contiguous
    // slices of a long file in one pass.
    const r = t.run("sed -n '1,80p;220,265p;285,345p' big.txt")
    assert.equal(r.exitCode, 0)
    const lines = r.stdout.split('\n').filter(Boolean)
    // 80 + 46 (220..265) + 16 (285..300 — clamped at EOF=300) = 142.
    assert.equal(lines.length, 80 + 46 + 16)
    assert.equal(lines[0], 'line 1')
    assert.equal(lines[79], 'line 80')
    assert.equal(lines[80], 'line 220')
    assert.equal(lines[125], 'line 265')
    assert.equal(lines[126], 'line 285')
    assert.equal(lines.at(-1), 'line 300')
  })

  it('overlapping ranges produce duplicates (matches GNU sed per-command processing)', () => {
    const t = createTerminal(SRC)
    // For each input line in order, each matching range fires —
    // so `1,3p;2,4p` prints lines 2 and 3 TWICE.
    const r = t.run("sed -n '1,3p;2,4p' big.txt")
    assert.equal(r.exitCode, 0)
    assert.deepEqual(r.stdout.split('\n').filter(Boolean), [
      'line 1', 'line 2', 'line 2', 'line 3', 'line 3', 'line 4',
    ])
  })

  it("multi-range tolerates empty segments (leading/trailing/doubled ';')", () => {
    const t = createTerminal(SRC)
    // GNU is lenient; templated callers may emit `;` separators
    // unconditionally. `;1,2p;;5p;` should behave like `1,2p;5p`.
    const r = t.run("sed -n ';1,2p;;5p;' big.txt")
    assert.equal(r.exitCode, 0)
    assert.deepEqual(r.stdout.split('\n').filter(Boolean), ['line 1', 'line 2', 'line 5'])
  })

  it('multi-range surfaces a specific reversed-range error naming the offender (no partial output)', () => {
    // Validation runs per segment, so a bad range in the middle of
    // a script still surfaces with its offender named. The earlier
    // valid segments (`1,5p`) must NOT produce output — if they did,
    // it would mean parseScript wrote ranges before erroring, which
    // would leak partial results on every malformed script.
    const t = createTerminal(SRC)
    const r = t.run("sed -n '1,5p;50,20p;80,90p' big.txt")
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /reversed range: 50,20/u)
    assert.equal(r.stdout, '', 'no partial output before the error')
  })

  it('multiple input files concatenate with cumulative line numbering (matches GNU sed)', () => {
    // Verified against `/usr/bin/sed`: `sed -n '5p' a b c` with each
    // file 3 lines long prints the 5th line of the concatenation,
    // which is the 2nd line of `b.txt`. Line numbers do NOT reset
    // per file — confirmed by experiment before implementing.
    const t = createTerminal({
      'a.txt': 'A1\nA2\nA3\n',
      'b.txt': 'B1\nB2\nB3\n',
      'c.txt': 'C1\nC2\nC3\n',
    })
    assert.equal(t.run("sed -n '5p' a.txt b.txt c.txt").stdout, 'B2\n')
    // Range spanning a file boundary: lines 3-7 = A3, B1, B2, B3, C1.
    assert.equal(t.run("sed -n '3,7p' a.txt b.txt c.txt").stdout, 'A3\nB1\nB2\nB3\nC1\n')
    // Range entirely past the first file: lines 8-9 = C2, C3.
    assert.equal(t.run("sed -n '8,9p' a.txt b.txt c.txt").stdout, 'C2\nC3\n')
  })

  it('multi-file composes with multi-range (the originally-attempted `dir/*.txt` shape)', () => {
    // `sed -n '1,2p;7,9p' a b c` — verified against GNU sed:
    // prints A1, A2 (lines 1-2) then C1, C2, C3 (lines 7-9 of the
    // 9-line concatenation).
    const t = createTerminal({
      'dir/a.txt': 'A1\nA2\nA3\n',
      'dir/b.txt': 'B1\nB2\nB3\n',
      'dir/c.txt': 'C1\nC2\nC3\n',
    })
    const r = t.run("sed -n '1,2p;7,9p' dir/a.txt dir/b.txt dir/c.txt")
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'A1\nA2\nC1\nC2\nC3\n')
  })

  it('multi-file: a file with no trailing newline still ends its last line cleanly', () => {
    // GNU sed verified: `printf 'A1\\nA2\\nA3'` (no trailing \\n)
    // followed by `B1\\nB2\\n` numbers as 5 lines (A1..A3, B1, B2),
    // NOT as 4 lines with A3B1 merged. Implementation honors this
    // by splitLines-per-input + flatMap, rather than joining raw
    // content and splitting once.
    const t = createTerminal({
      'a.txt': 'A1\nA2\nA3',   // no trailing newline
      'b.txt': 'B1\nB2\n',
    })
    assert.equal(t.run("sed -n '3,4p' a.txt b.txt").stdout, 'A3\nB1\n')
    assert.equal(t.run("sed -n '5p' a.txt b.txt").stdout, 'B2\n')
  })

  it('multi-file: a missing file mid-list surfaces an error and keeps reading the rest', () => {
    // Matches GNU sed: stderr gets the per-file error, the surviving
    // files contribute their lines in their listed order, and exit
    // code reflects the partial failure (1 in this codebase\'s
    // convention; GNU uses 2 — diverging deliberately to match the
    // existing partial-read pattern for cat/grep/head/tail/wc).
    const t = createTerminal({
      'a.txt': 'A1\nA2\nA3\n',
      'c.txt': 'C1\nC2\nC3\n',
    })
    const r = t.run("sed -n '1,5p' a.txt nope.txt c.txt")
    assert.equal(r.exitCode, 1)
    assert.match(r.stderr, /nope\.txt: no such file/u)
    // Surviving files\' lines are still in cumulative-numbering order:
    // a.txt = lines 1-3, c.txt = lines 4-6 (skipped file contributes
    // nothing). `1,5p` therefore prints lines 1-5 = A1, A2, A3, C1, C2.
    assert.equal(r.stdout, 'A1\nA2\nA3\nC1\nC2\n')
  })

  it('rejects anything outside the narrow subset (single canonical message)', () => {
    const t = createTerminal(SRC)
    // Everything in this group should hit the same "only -n 'X[,Y]p'"
    // message — including unknown flags (which would otherwise
    // surface as parseArgs's generic "unknown option" error).
    const unsupportedCases = [
      'sed',                                // no args
      "sed '1,5p' big.txt",                 // missing -n
      "sed -n 's/foo/bar/g' big.txt",       // substitution
      "sed -n '/foo/p' big.txt",            // regex address
      "sed -n '1,5p;s/a/b/' big.txt",       // mixing range with non-range
      "sed -i -n '1,2p' big.txt",           // unsupported flag
      "sed -e '1p' big.txt",                // unsupported flag
    ]
    for (const cmd of unsupportedCases) {
      const r = t.run(cmd)
      assert.notEqual(r.exitCode, 0, `${cmd}: expected non-zero exit`)
      assert.match(r.stderr, /only `-n 'X\[,Y\]p'`/u, `${cmd}: expected canonical message`)
    }
    // These hit specific (non-canonical) errors that name the
    // actual problem — they don't get the generic unsupported text.
    const specific = [
      ["sed -n '0,5p' big.txt", /line numbers must be >= 1/u],
      ["sed -n '200,100p' big.txt", /reversed range: 200,100/u],
    ]
    for (const [cmd, re] of specific) {
      const r = t.run(cmd)
      assert.notEqual(r.exitCode, 0, `${cmd}: expected non-zero exit`)
      assert.match(r.stderr, re, `${cmd}: expected specific error`)
    }
  })

  it('is hidden — the unknown-command "Available" hint does not list sed', () => {
    // Intentionally undocumented surface. Discoverable by using
    // the exact subset, not by browsing the available list.
    const t = createTerminal(SRC)
    const r = t.run('frobnicate')
    assert.match(r.stderr, /command not found/u)
    assert.match(r.stderr, /Available: /u)
    assert.doesNotMatch(r.stderr, /\bsed\b/u)
  })
})

describe('createTerminal — shell-style glob expansion', () => {
  const SRC = {
    'dir/foo.js': 'a\nb\nc\n',
    'dir/bar.js': 'x\ny\n',
    'dir/baz.md': 'z\n',
    'other/qux.js': 'q\n',
    '.hidden.js': 'h\n',
  }

  it('`wc -l dir/*.js` expands to the matching files', () => {
    const t = createTerminal(SRC)
    const r = t.run('wc -l dir/*.js')
    assert.equal(r.exitCode, 0)
    // bar.js (2 lines) + foo.js (3 lines), in lexicographic order,
    // plus the total. Width is adaptive — all counts here are
    // 1-digit (max width 1), so no leading padding.
    assert.match(r.stdout, /^2 dir\/bar\.js$/mu)
    assert.match(r.stdout, /^3 dir\/foo\.js$/mu)
    assert.match(r.stdout, /^5 total$/mu)
  })

  it('wc -c counts bytes (UTF-8), not UTF-16 code units', () => {
    // Verified against `/usr/bin/wc -c`: ASCII is 1 byte, `é` is 2,
    // an emoji is 4 — so plain string `.length` (code units) would
    // undercount the last two. The `c` column is the byte count.
    const t = createTerminal({ 'a.txt': 'abc\n', 'u.txt': 'café\n', 'e.txt': '😀\n' })
    assert.match(t.run('wc -c a.txt').stdout, /^\s*4 a\.txt$/mu)
    assert.match(t.run('wc -c u.txt').stdout, /^\s*6 u\.txt$/mu)
    assert.match(t.run('wc -c e.txt').stdout, /^\s*5 e\.txt$/mu)
    // The byte count also flows into the default (no-flag) c column.
    assert.match(t.run('wc u.txt').stdout, /\b6\b/u)
  })

  it('a single-quoted pattern stays literal — no expansion', () => {
    const t = createTerminal(SRC)
    // Quoted: wc tries to read a file literally named `dir/*.js`.
    const r = t.run("wc -l 'dir/*.js'")
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /no such file/u)
  })

  it('double-quoted pattern is also literal', () => {
    const t = createTerminal(SRC)
    const r = t.run('wc -l "dir/*.js"')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /no such file/u)
  })

  it('pattern with no matches passes through verbatim (bash default)', () => {
    const t = createTerminal(SRC)
    const r = t.run('wc -l dir/*.txt')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /dir\/\*\.txt: no such file/u)
  })

  it('absolute glob — `/dir/*.js`', () => {
    const t = createTerminal(SRC)
    const r = t.run('cat /dir/*.js')
    // bar.js then foo.js (lex order).
    assert.equal(r.stdout, 'x\ny\na\nb\nc\n')
  })

  it('multi-segment glob (`*/qux.js`) walks each matching dir', () => {
    const t = createTerminal(SRC)
    const r = t.run('cat */qux.js')
    assert.equal(r.stdout, 'q\n')
  })

  it('dotfiles are not matched by a leading wildcard (bash default)', () => {
    const t = createTerminal(SRC)
    // `*.js` from root matches nothing — top-level .js is hidden,
    // and `dir/*.js` files aren't in scope of root-level `*.js`.
    // `cat` will report the unexpanded pattern as a missing file.
    const r = t.run('cat *.js')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /\*\.js: no such file/u)
    // Explicit `.` matches the dotfile.
    const dot = t.run('cat .*.js')
    assert.equal(dot.stdout, 'h\n')
  })

  it('the command name itself is never glob-expanded', () => {
    // Even if a file named `cat` existed in cwd, `c*` shouldn't
    // get picked up as a command. (No such file in SRC; just
    // confirm the dispatcher treats argv[0] as a literal name.)
    const t = createTerminal(SRC)
    const r = t.run('c*')
    assert.equal(r.exitCode, 127)
    assert.match(r.stderr, /command not found/u)
  })

  it('preserves a trailing `/` on directory-only glob matches (bash convention)', () => {
    const t = createTerminal({
      'a/x.js': '',
      'b/y.js': '',
      'c.txt': '',
    })
    // `*/` matches directories only, with the slash preserved on
    // each match — bash and the module's "preserve user-typed
    // shape" contract. Echo prints argv joined by a space, so the
    // expanded shape is directly observable.
    assert.equal(t.run('echo */').stdout, 'a/ b/\n')
  })

  it('preserves a leading `./` prefix in expansion (bash convention)', () => {
    const t = createTerminal(SRC)
    // `./dir/*.js` should yield `./dir/bar.js`, not `dir/bar.js` —
    // bash keeps the user-typed prefix so output reads naturally
    // when the receiving command echoes its args.
    const r = t.run('wc -l ./dir/*.js')
    assert.equal(r.exitCode, 0)
    assert.match(r.stdout, /\.\/dir\/bar\.js/u)
    assert.match(r.stdout, /\.\/dir\/foo\.js/u)
    assert.doesNotMatch(r.stdout, /(?<!\.\/)dir\/bar\.js/u)
  })

  it('expansion sorts results so order is stable across runs', () => {
    const t = createTerminal({
      'a/y.js': '',
      'a/z.js': '',
      'a/x.js': '',
    })
    const r = t.run('find a/*.js -type f').stdout.split('\n').filter(Boolean)
    // Pattern expands into ['a/x.js', 'a/y.js', 'a/z.js'] which then
    // become start paths for find. Three single-file finds, each
    // emits its file. Order tracks the sort.
    assert.deepEqual(r, ['a/x.js', 'a/y.js', 'a/z.js'])
  })
})

describe('createTerminal — brace expansion', () => {
  const SRC = {
    'src/foo.js': 'a\n',
    'src/bar.js': 'b\n',
    'src/baz.ts': 'c\n',
  }

  it('`{a,b,c}` expands into three argv items', () => {
    const t = createTerminal(SRC)
    assert.equal(t.run('echo {a,b,c}').stdout, 'a b c\n')
  })

  it('prefix and suffix attach to each alternative', () => {
    const t = createTerminal(SRC)
    assert.equal(t.run('echo pre{a,b}post').stdout, 'preapost prebpost\n')
  })

  it('adjacent groups produce the cartesian product', () => {
    const t = createTerminal(SRC)
    assert.equal(t.run('echo {a,b}{c,d}').stdout, 'ac ad bc bd\n')
  })

  it('nested groups expand inside-out per alternative', () => {
    const t = createTerminal(SRC)
    assert.equal(t.run('echo {a,b{c,d}}').stdout, 'a bc bd\n')
  })

  it('no comma → no expansion (`{a}`, `{}`, unmatched)', () => {
    const t = createTerminal(SRC)
    assert.equal(t.run('echo {a}').stdout, '{a}\n')
    assert.equal(t.run('echo {}').stdout, '{}\n')
    assert.equal(t.run('echo {abc').stdout, '{abc\n')
  })

  it('quoted braces stay literal', () => {
    const t = createTerminal(SRC)
    assert.equal(t.run('echo "{a,b}"').stdout, '{a,b}\n')
    assert.equal(t.run("echo '{a,b}'").stdout, '{a,b}\n')
  })

  it('empty alternatives are preserved (`{,a,}` → 3 items, two empty)', () => {
    // Bash compat: trailing/leading commas produce empty argv tokens.
    const t = createTerminal(SRC)
    assert.equal(t.run('echo {,a,}').stdout, ' a \n')
  })

  it('feeds the glob expander — braces resolve first, then `*` matches', () => {
    // `{src/foo,src/bar}*.js` → `src/foo*.js src/bar*.js` (brace),
    // then glob each against the FS. Echo prints the resolved argv
    // joined with spaces so the two-phase expansion is observable.
    const t = createTerminal(SRC)
    const r = t.run('echo {src/foo,src/bar}*.js')
    assert.equal(r.exitCode, 0)
    assert.match(r.stdout, /src\/foo\.js/u)
    assert.match(r.stdout, /src\/bar\.js/u)
  })

  it('combines with real file paths (`cat src/{foo,bar}.js`)', () => {
    const t = createTerminal(SRC)
    assert.equal(t.run('cat src/{foo,bar}.js').stdout, 'a\nb\n')
  })

  it('command name (argv[0]) is never brace-expanded', () => {
    // Matches expandGlobs' carve-out — expanding `{c,e}cho` into
    // multiple tokens would be surprising and is rarely useful.
    const t = createTerminal(SRC)
    const r = t.run('{c,e}cho hi')
    assert.equal(r.exitCode, 127)
    assert.match(r.stderr, /command not found/u)
  })
})

describe('createTerminal — find -a / -o operators', () => {
  const SRC = {
    'src/foo.js': '',
    'src/bar.js': '',
    'src/baz.ts': '',
    'src/data.json': '',
    'src/sub/inner.js': '',
    'README.md': '',
  }

  it('-o (OR) takes either left or right predicate', () => {
    const t = createTerminal(SRC)
    const r = new Set(t.run("find / -name '*.js' -o -name '*.ts'").stdout.split('\n').filter(Boolean))
    assert.ok(r.has('/src/foo.js'))
    assert.ok(r.has('/src/bar.js'))
    assert.ok(r.has('/src/baz.ts'))
    assert.ok(r.has('/src/sub/inner.js'))
    assert.ok(!r.has('/src/data.json'))
    assert.ok(!r.has('/README.md'))
  })

  it('-a (AND) is the implicit default; explicit form behaves the same', () => {
    const t = createTerminal(SRC)
    const a = new Set(t.run("find / -type f -name '*.js'").stdout.split('\n').filter(Boolean))
    const b = new Set(t.run("find / -type f -a -name '*.js'").stdout.split('\n').filter(Boolean))
    assert.deepEqual([...a].sort(), [...b].sort())
    assert.ok(a.has('/src/foo.js'))
    assert.ok(!a.has('/src')) // -type f excludes the dir
  })

  it('-a binds tighter than -o (standard precedence)', () => {
    // `find / -name '*.ts' -o -name '*.js' -a -type d` parses as
    // `(*.ts) OR (*.js AND type=d)`. Nothing matches the AND group
    // (no .js dir), so only .ts files match.
    const t = createTerminal(SRC)
    const r = t.run("find / -name '*.ts' -o -name '*.js' -a -type d")
      .stdout.split('\n').filter(Boolean).sort()
    assert.deepEqual(r, ['/src/baz.ts'])
  })

  it('-not / ! flips the predicate it directly precedes', () => {
    const t = createTerminal(SRC)
    // (-not name=*.js) AND (type=f) → .ts / .json / .md files
    const r = new Set(t.run("find / -not -name '*.js' -a -type f").stdout.split('\n').filter(Boolean))
    assert.ok(r.has('/src/baz.ts'))
    assert.ok(r.has('/src/data.json'))
    assert.ok(r.has('/README.md'))
    assert.ok(!r.has('/src/foo.js'))
  })

  it('rejects malformed -o usage', () => {
    const t = createTerminal(SRC)
    for (const cmd of ['find / -o -name "*.js"', "find / -name '*.js' -o"]) {
      const r = t.run(cmd)
      assert.notEqual(r.exitCode, 0, `${cmd}: expected non-zero exit`)
      assert.match(r.stderr, /-o/u)
    }
  })

  it('rejects malformed -a usage (mirrors -o validation)', () => {
    // `-a` is an explicit operator and should error on the same
    // shapes `-o` does: leading (no LHS), trailing (no RHS), and
    // consecutive (no expression between). Previously a silent
    // no-op that let `find / -a` succeed match-all.
    const t = createTerminal(SRC)
    const cases = [
      'find / -a',                       // no LHS, no RHS
      "find / -a -name '*.js'",          // no LHS
      "find / -name '*.js' -a",          // no RHS (trailing)
      "find / -name '*.js' -a -a -type f", // consecutive operators
    ]
    for (const cmd of cases) {
      const r = t.run(cmd)
      assert.notEqual(r.exitCode, 0, `${cmd}: expected non-zero exit`)
      assert.match(r.stderr, /-a/u, `${cmd}: stderr should mention -a`)
    }
  })
})

describe('createTerminal — head/tail -N shorthand', () => {
  it('`head -N file` is shorthand for `head -n N file`', () => {
    const t = createTerminal(SOURCES)
    assert.equal(t.run('head -2 src/foo.js').stdout, 'const x = 1\n// TODO: fix\n')
    assert.equal(t.run('head -1 src/foo.js').stdout, t.run('head -n 1 src/foo.js').stdout)
  })

  it('`tail -N file` is shorthand for `tail -n N file`', () => {
    const t = createTerminal(SOURCES)
    assert.equal(t.run('tail -1 src/foo.js').stdout, 'const y = 2\n')
  })

  it('explicit `-n N` wins over numeric shorthand in the same invocation', () => {
    // Both forms in one call: `-n 1` is the explicit count;
    // `-100` would have been the shorthand had `-n` not already
    // been set. The shorthand-promotion logic skips when `-n` is
    // present, so `-100` stays a positional — and since the file
    // `-100` doesn't exist, head errors on it. The error message
    // confirms the shorthand wasn't consumed (and so -n won).
    const t = createTerminal(SOURCES)
    const r = t.run('head -n 1 -100 src/foo.js')
    assert.equal(r.exitCode, 1)
    assert.match(r.stderr, /-100: no such file/u)
  })

  it('redirect error messages use bare `>` / `>>` for stdout (fd=1) but `2>` for stderr', () => {
    const t = createTerminal(SOURCES)
    // bare `>` to a real path mentions `>` (not `1>`):
    const stdoutErr = t.run('cat src/foo.js > out').stderr
    assert.match(stdoutErr, /`>\/dev\/null`/u)
    assert.doesNotMatch(stdoutErr, /`1>/u)
    // `>>` append rejection also uses bare form:
    const appendErr = t.run('echo hi >> log').stderr
    assert.match(appendErr, /`>>`/u)
    // stderr redirects keep the explicit fd:
    const stderrErr = t.run('cat foo 2> log').stderr
    assert.match(stderrErr, /`2>/u)
  })
})

describe('createTerminal — tac', () => {
  it('reverses line order from stdin and from a file', () => {
    const t = createTerminal({ 'lines.txt': 'a\nb\nc\n' })
    assert.equal(t.run('cat lines.txt | tac').stdout, 'c\nb\na\n')
    assert.equal(t.run('tac lines.txt').stdout, 'c\nb\na\n')
  })

  it('reverses each file independently then concatenates (GNU per-file semantics)', () => {
    // GNU `tac a b` reverses each file separately — not the
    // concatenated stream. Use `cat a b | tac` to reverse the
    // combined stream instead.
    const t = createTerminal({ 'a.txt': '1\n2\n', 'b.txt': '3\n4\n' })
    assert.equal(t.run('tac a.txt b.txt').stdout, '2\n1\n4\n3\n')
    assert.equal(t.run('cat a.txt b.txt | tac').stdout, '4\n3\n2\n1\n')
  })

  it('input without a trailing newline still emits each line on its own row', () => {
    // splitLines drops the trailing empty produced by a final `\n`
    // but doesn't add one when missing — so `"a\nb"` (no trailing)
    // and `"a\nb\n"` both parse to ['a','b']. tac then reverses to
    // ['b','a'] and joinLines adds a single trailing newline, so
    // the output is the same in both cases.
    const t = createTerminal({ 'no-nl.txt': 'a\nb' })
    assert.equal(t.run('tac no-nl.txt').stdout, 'b\na\n')
  })

  it('empty input produces empty output (exit 0)', () => {
    const t = createTerminal({ 'empty.txt': '' })
    const r = t.run('tac empty.txt')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, '')
  })
})

describe('createTerminal — seq', () => {
  it('one-arg form counts 1..LAST', () => {
    const t = createTerminal({})
    assert.equal(t.run('seq 4').stdout, '1\n2\n3\n4\n')
  })

  it('two-arg form counts FIRST..LAST; descending range auto-picks -1', () => {
    const t = createTerminal({})
    assert.equal(t.run('seq 3 5').stdout, '3\n4\n5\n')
    // Descending: `seq 5 3` defaults the increment to -1 (GNU does
    // this when FIRST > LAST in the 2-arg form). Without the auto-
    // detect, the loop would step +1 and emit nothing.
    assert.equal(t.run('seq 5 3').stdout, '5\n4\n3\n')
  })

  it('three-arg form uses explicit increment (positive and negative)', () => {
    const t = createTerminal({})
    assert.equal(t.run('seq 1 2 7').stdout, '1\n3\n5\n7\n')
    assert.equal(t.run('seq 10 -3 1').stdout, '10\n7\n4\n1\n')
  })

  it('rejects floats, scientific, and zero increment', () => {
    const t = createTerminal({})
    assert.match(t.run('seq 1.5').stderr, /invalid integer/u)
    assert.match(t.run('seq 1e3').stderr, /invalid integer/u)
    assert.match(t.run('seq 1 0 5').stderr, /non-zero/u)
  })

  it('feeds xargs cleanly', () => {
    const t = createTerminal({})
    assert.equal(t.run('seq 3 | xargs echo').stdout, '1 2 3\n')
  })

  it('one-arg form with LAST <= 0 prints nothing (matches GNU)', () => {
    // Regression: earlier auto-sign logic ran for the 1-arg form
    // too, so `seq 0` picked incr=-1 and emitted `1\n0\n`. GNU `seq
    // 0` / `seq -5` are empty because FIRST is fixed at 1 and the
    // ascending loop `1<=0` / `1<=-5` doesn't fire.
    const t = createTerminal({})
    assert.equal(t.run('seq 0').exitCode, 0)
    assert.equal(t.run('seq 0').stdout, '')
    assert.equal(t.run('seq -5').stdout, '')
    // The 2-arg form keeps its auto-sign behavior, untouched.
    assert.equal(t.run('seq 5 1').stdout, '5\n4\n3\n2\n1\n')
  })

  it('caps oversized ranges instead of OOMing the buffered pipeline', () => {
    // Pipelines materialize each stage's output, so an unbounded seq
    // (e.g. `seq 1 1000000000 | head -1`) would build a billion lines
    // and run out of memory. The count is rejected before allocating.
    const t = createTerminal({})
    const big = t.run('seq 1 1000000000')
    assert.equal(big.exitCode, 1)
    assert.match(big.stderr, /range too large/u)
    // The original OOM repro: seq errors, head sees empty stdin.
    assert.equal(t.run('seq 1 1000000000 | head -1').stdout, '')
    // Large descending and out-of-safe-range counts are caught too.
    assert.match(t.run('seq 1000000000 -1 1').stderr, /range too large/u)
    assert.match(t.run('seq 1 99999999999999999999').stderr, /range too large/u)
    // Just over the limit is rejected; the limit itself is allowed.
    assert.match(t.run('seq 1 1000001').stderr, /range too large/u)
    assert.equal(t.run('seq 1 1000000').exitCode, 0)
  })
})

describe('createTerminal — nl', () => {
  it('default (-b t) numbers non-empty lines; empties pass through unprefixed', () => {
    const t = createTerminal({ 'f.txt': 'a\n\nb\n\nc\n' })
    const r = t.run('nl f.txt')
    // Empties stay as the bare empty line — no number, no tab.
    // Numbered lines keep cat-n's 6-wide right-aligned format.
    assert.equal(r.stdout, '     1\ta\n\n     2\tb\n\n     3\tc\n')
  })

  it('-b a numbers EVERY line, including blanks', () => {
    const t = createTerminal({ 'f.txt': 'a\n\nb\n' })
    assert.equal(t.run('nl -b a f.txt').stdout, '     1\ta\n     2\t\n     3\tb\n')
  })

  it('line counter continues across multiple files (no per-file reset)', () => {
    // GNU `nl a b` defaults to no reset (one "logical page" across
    // input). Pin this so a future `nl` rework can't silently
    // change to per-file numbering.
    const t = createTerminal({ 'a.txt': 'x\ny\n', 'b.txt': 'z\n' })
    assert.equal(t.run('nl a.txt b.txt').stdout, '     1\tx\n     2\ty\n     3\tz\n')
  })

  it('rejects unsupported -b styles with a message naming the valid options', () => {
    // Real nl supports `-b n` (no numbering) and `-b pREGEX` too,
    // but those are out of scope. The error should make that clear.
    const t = createTerminal({ 'f.txt': 'a\n' })
    const r = t.run('nl -b n f.txt')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /only `a` and `t`/u)
  })

  it('reads from stdin when no file is given', () => {
    const t = createTerminal({})
    assert.equal(t.run('echo hello | nl').stdout, '     1\thello\n')
  })
})

describe('createTerminal — cut', () => {
  it('-f extracts fields with default tab delimiter', () => {
    const t = createTerminal({ 'tsv.txt': 'a\tb\tc\nd\te\tf\n' })
    assert.equal(t.run('cut -f 2 tsv.txt').stdout, 'b\ne\n')
    assert.equal(t.run('cut -f 1,3 tsv.txt').stdout, 'a\tc\nd\tf\n')
  })

  it('-d sets the field delimiter; -f LIST supports ranges and open-ended', () => {
    const t = createTerminal({ 'csv.txt': 'a,b,c,d,e\n1,2,3,4,5\n' })
    assert.equal(t.run('cut -d , -f 2-4 csv.txt').stdout, 'b,c,d\n2,3,4\n')
    assert.equal(t.run('cut -d , -f 3- csv.txt').stdout, 'c,d,e\n3,4,5\n')
    assert.equal(t.run('cut -d , -f -2 csv.txt').stdout, 'a,b\n1,2\n')
  })

  it('-c picks characters by 1-indexed position', () => {
    const t = createTerminal({ 'f.txt': 'abcdef\nABCDEF\n' })
    assert.equal(t.run('cut -c 1-3 f.txt').stdout, 'abc\nABC\n')
    // Output is in position order, NOT list order — matches GNU.
    assert.equal(t.run('cut -c 4,1 f.txt').stdout, 'ad\nAD\n')
  })

  it('-c open-ended range past end-of-line clamps gracefully', () => {
    // `Math.min(Infinity, len)` is `len`, so `-c 2-` on a 1-char
    // line picks nothing (the loop never enters) and on a 5-char
    // line picks chars 2..5. Pins the open-ended edge.
    const t = createTerminal({ 'f.txt': 'a\nhello\n' })
    assert.equal(t.run('cut -c 2- f.txt').stdout, '\nello\n')
  })

  it('-c is codepoint-aware: a single emoji counts as one position', () => {
    // `[...line]` splits by code-point, so an astral char like a
    // family emoji is one position, not a surrogate pair. Without
    // this, `cut -c 1` on `😀abc` would emit half a surrogate and
    // downstream commands would see mojibake.
    const t = createTerminal({ 'f.txt': '😀abc\n' })
    assert.equal(t.run('cut -c 1 f.txt').stdout, '😀\n')
    assert.equal(t.run('cut -c 2-3 f.txt').stdout, 'ab\n')
  })

  it('lines without the delimiter pass through verbatim (no -s)', () => {
    const t = createTerminal({ 'mixed.txt': 'a,b,c\nNOCOMMA\nd,e,f\n' })
    assert.equal(t.run('cut -d , -f 2 mixed.txt').stdout, 'b\nNOCOMMA\ne\n')
  })

  it('rejects malformed shapes with specific messages', () => {
    const t = createTerminal({ 'f.txt': 'a,b\n' })
    // Neither -f nor -c.
    assert.match(t.run('cut f.txt').stderr, /usage:/u)
    // Both -f and -c.
    assert.match(t.run('cut -f 1 -c 1 f.txt').stderr, /usage:/u)
    // -d with -c.
    assert.match(t.run('cut -d , -c 1 f.txt').stderr, /-d is only valid with -f/u)
    // Reversed range.
    assert.match(t.run('cut -c 5-2 f.txt').stderr, /reversed range/u)
    // Multi-char delim.
    assert.match(t.run('cut -d ,, -f 1 f.txt').stderr, /single character/u)
  })

  it('composes naturally in a pipeline', () => {
    const t = createTerminal({ 'csv.txt': 'name,age\nalice,30\nbob,25\n' })
    assert.equal(t.run('tail -n 2 csv.txt | cut -d , -f 1').stdout, 'alice\nbob\n')
  })
})

describe('createTerminal — tr', () => {
  it('translate: SET1 → SET2 char-by-char', () => {
    const t = createTerminal({})
    assert.equal(t.run('echo hello | tr a-z A-Z').stdout, 'HELLO\n')
    assert.equal(t.run('echo abc | tr abc xyz').stdout, 'xyz\n')
  })

  it('-d deletes every char in SET', () => {
    const t = createTerminal({})
    assert.equal(t.run('echo "a1b2c3" | tr -d 0-9').stdout, 'abc\n')
  })

  it('-s squeezes runs of SET chars', () => {
    const t = createTerminal({})
    assert.equal(t.run('echo "aaabbbccc" | tr -s a-z').stdout, 'abc\n')
    // Only listed chars squeeze; others pass through unchanged.
    assert.equal(t.run('echo "aaaXXXbbb" | tr -s a').stdout, 'aXXXbbb\n')
  })

  it('SET2 shorter than SET1 → last SET2 char is padded (GNU default)', () => {
    const t = createTerminal({})
    // a→x, b→y, c→y (padded), d→y (padded)
    assert.equal(t.run('echo abcd | tr abcd xy').stdout, 'xyyy\n')
  })

  it('escape sequences and ranges parse in sets', () => {
    const t = createTerminal({})
    // `\t` → space, `\n` left alone in the data, range `a-c` works.
    assert.equal(t.run('echo "a\tb\tc" | tr "\t" " "').stdout, 'a b c\n')
  })

  it('rejects -d combined with -s and missing operands', () => {
    const t = createTerminal({})
    assert.match(t.run('echo x | tr -ds a b').stderr, /-d combined with -s/u)
    assert.match(t.run('echo x | tr a').stderr, /usage:/u)
    assert.match(t.run('tr').stderr, /usage:/u)
  })

  it('-d with an empty SET is a no-op (input passes through unchanged)', () => {
    // Filtering against an empty Set keeps every char. Documenting
    // the current behavior rather than erroring — GNU is fine with
    // `tr -d ""` too.
    const t = createTerminal({})
    assert.equal(t.run('echo hello | tr -d ""').stdout, 'hello\n')
  })

  it('astral codepoints (emoji) read as single units in SET and ranges', () => {
    // Pre-splitting the spec with `[...spec]` means a single emoji
    // is one unit, not a surrogate pair. Range walking then uses
    // codepoint values (`codePointAt`/`fromCodePoint`), so a small
    // emoji range translates each member correctly.
    const t = createTerminal({})
    // Single-codepoint translate: 😀 → X.
    assert.equal(t.run('echo "a😀b" | tr "😀" X').stdout, 'aXb\n')
    // Range over astral codepoints: 😀 (U+1F600), 😁 (U+1F601),
    // 😂 (U+1F602) all map to X.
    assert.equal(t.run('echo "😀😁😂" | tr "😀-😂" X').stdout, 'XXX\n')
  })
})

describe('createTerminal — which', () => {
  it('prints /usr/bin/<name> for each registered command', () => {
    const t = createTerminal({})
    assert.equal(t.run('which ls').stdout, '/usr/bin/ls\n')
    assert.equal(t.run('which grep cat echo').stdout, '/usr/bin/grep\n/usr/bin/cat\n/usr/bin/echo\n')
  })

  it('finds which itself (registry membership, not hardcoded list)', () => {
    // Confirms `which` looks up against the live registry rather
    // than a baked-in name table — otherwise it would miss itself
    // and any future additions.
    const t = createTerminal({})
    assert.equal(t.run('which which').stdout, '/usr/bin/which\n')
  })

  it('unknown command: prints `<name> not found` on stdout, exit 1', () => {
    // Matches the zsh `which` builtin shape: misses are reported
    // inline (so a multi-arg call shows which ones failed) and the
    // exit code bumps so callers can still detect "not all found".
    const t = createTerminal({})
    const r = t.run('which frobnicate')
    assert.equal(r.exitCode, 1)
    assert.equal(r.stdout, 'frobnicate not found\n')
    assert.equal(r.stderr, '')
  })

  it('mixed: paths and not-found interleave in argv order; exit 1 if any miss', () => {
    const t = createTerminal({})
    const r = t.run('which ls frobnicate cat')
    assert.equal(r.exitCode, 1)
    assert.equal(r.stdout, '/usr/bin/ls\nfrobnicate not found\n/usr/bin/cat\n')
  })

  it('does NOT participate in the /bin prefix mapping', () => {
    // `dispatch` strips `/bin/` etc. when the bare name is known,
    // but `which` checks registry membership directly. So
    // `which /bin/ls` looks up the literal `/bin/ls` name (not
    // registered) and reports it as missing. This keeps which's
    // contract simple — strip the prefix yourself if you want the
    // fake path.
    const t = createTerminal({})
    const r = t.run('which /bin/ls')
    assert.equal(r.exitCode, 1)
    assert.equal(r.stdout, '/bin/ls not found\n')
  })
})

describe('createTerminal — whoami / date (hidden, chain-friendly)', () => {
  it('whoami prints the configured user (default "user")', () => {
    const t = createTerminal({})
    assert.equal(t.run('whoami').stdout, 'user\n')
    assert.equal(t.run('whoami').exitCode, 0)
  })

  it('opts.user overrides the default; omitted opts fall back to "user"', () => {
    assert.equal(createTerminal({}, { user: 'alice' }).run('whoami').stdout, 'alice\n')
    assert.equal(createTerminal({}, {}).run('whoami').stdout, 'user\n')
    // Explicitly passing an empty string is honored — only `undefined`
    // triggers the default (same convention as opts.cwd handling).
    assert.equal(createTerminal({}, { user: '' }).run('whoami').stdout, '\n')
  })

  it('whoami rejects extra operands', () => {
    const t = createTerminal({})
    const r = t.run('whoami foo')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /extra operand: foo/u)
  })

  it('date with no args emits the GNU default shape', () => {
    // GNU C-locale default: `%a %b %e %T %Z %Y`, e.g.
    // `Tue May 28 12:34:56 UTC 2026`. Match shape, not value —
    // the test runs at wall-clock time so the year/etc. shift.
    const t = createTerminal({})
    const r = t.run('date')
    assert.equal(r.exitCode, 0)
    // weekday + month + day (space- OR digit-padded) + HH:MM:SS + tz + year + \n
    assert.match(r.stdout, /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \S+ \d{4}\n$/u)
  })

  it('date +FORMAT applies a strftime-like template', () => {
    const t = createTerminal({})
    assert.match(t.run('date +%Y-%m-%d').stdout, /^\d{4}-\d{2}-\d{2}\n$/u)
    assert.match(t.run('date +%T').stdout, /^\d{2}:\d{2}:\d{2}\n$/u)
    assert.match(t.run('date +%F').stdout, /^\d{4}-\d{2}-\d{2}\n$/u)
    assert.match(t.run('date +%s').stdout, /^\d+\n$/u)
    // Named components: weekday + month abbreviations.
    assert.match(t.run('date "+%a %b"').stdout, /^[A-Z][a-z]{2} [A-Z][a-z]{2}\n$/u)
  })

  it('date -u forces UTC for tz-sensitive specifiers (%Z, %z)', () => {
    const t = createTerminal({})
    assert.equal(t.run('date -u +%Z').stdout, 'UTC\n')
    assert.equal(t.run('date -u +%z').stdout, '+0000\n')
  })

  it('date escape specifiers: %% / %n / %t / unknown pass-through', () => {
    const t = createTerminal({})
    assert.equal(t.run('date +%%').stdout, '%\n')
    assert.equal(t.run('date +%n').stdout, '\n\n')   // %n is a literal newline + always-appended trailing newline
    assert.equal(t.run('date +%t').stdout, '\t\n')
    // Unknown specifiers pass through (matching GNU's lenient behavior).
    assert.equal(t.run('date +%Q').stdout, '%Q\n')
  })

  it('date errors on bare (non-`+`) positional and on multiple +FORMAT args', () => {
    const t = createTerminal({})
    const bare = t.run('date xxx')
    assert.notEqual(bare.exitCode, 0)
    assert.match(bare.stderr, /usage: date/u)
    const dupe = t.run('date +a +b')
    assert.notEqual(dupe.exitCode, 0)
    assert.match(dupe.stderr, /at most one \+FORMAT/u)
  })

  it('`pwd && whoami && date` chains cleanly (the originally-requested ritual)', () => {
    const t = createTerminal({}, { user: 'auditor' })
    const r = t.run('pwd && whoami && date')
    assert.equal(r.exitCode, 0)
    const lines = r.stdout.split('\n')
    assert.equal(lines[0], '/')                              // pwd
    assert.equal(lines[1], 'auditor')                        // whoami
    assert.match(lines[2], /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d /u)  // date default
  })

  it('whoami / date are hidden — not in the unknown-command "Available" hint', () => {
    // Both commands are dispatchable (the chain test above proves it),
    // but they shouldn\'t appear in the not-found hint — they\'re
    // chain-friendly utilities, not part of the documented audit
    // surface. `which whoami` / `which date` still resolve, since
    // ctx.hasCommand checks the HIDDEN registry.
    const t = createTerminal({})
    const stderr = t.run('nosuchcmd').stderr
    assert.doesNotMatch(stderr, /\bwhoami\b/u)
    assert.doesNotMatch(stderr, /\bdate\b/u)
    assert.equal(t.run('which whoami').stdout, '/usr/bin/whoami\n')
    assert.equal(t.run('which date').stdout, '/usr/bin/date\n')
  })
})

describe('createTerminal — complete', () => {
  it('empty input lists every public command', () => {
    const t = createTerminal(SOURCES)
    const c = t.complete('')
    // Sample a handful from both registries; full membership check
    // would tie the test to the exact command set and add no value.
    for (const name of ['cat', 'grep', 'pwd', 'cd', 'ls', 'find', 'echo']) {
      assert.ok(c.includes(name), `expected ${name} in completions`)
    }
    // HIDDEN commands (sed) are intentionally excluded — matches the
    // "Available: …" hint surfaced by unknownCommand().
    assert.ok(!c.includes('sed'))
  })

  it('command-name prefix narrows to commands starting with it', () => {
    const t = createTerminal(SOURCES)
    assert.deepEqual(t.complete('gre'), ['grep'])
    const c = t.complete('c')
    assert.ok(c.includes('cat'))
    assert.ok(c.includes('cd'))
    // Negative: nothing starting with 'c' should leak in (e.g. grep)
    for (const name of c) assert.ok(name.startsWith('c'))
  })

  it('returns [] when no command matches the prefix', () => {
    const t = createTerminal(SOURCES)
    assert.deepEqual(t.complete('zzz'), [])
  })

  it('bin prefixes list commands under that prefix', () => {
    const t = createTerminal(SOURCES)
    for (const prefix of ['/usr/local/bin/', '/usr/bin/', '/bin/', '/sbin/']) {
      const c = t.complete(prefix)
      assert.ok(c.includes(prefix + 'grep'), `${prefix} should list grep`)
      assert.ok(c.includes(prefix + 'cat'))
      // Prefix is preserved on every entry.
      for (const entry of c) assert.ok(entry.startsWith(prefix))
    }
  })

  it('bin prefix + partial narrows to commands with that suffix', () => {
    const t = createTerminal(SOURCES)
    assert.deepEqual(t.complete('/usr/bin/gre'), ['/usr/bin/grep'])
    assert.deepEqual(t.complete('/bin/gre'), ['/bin/grep'])
  })

  it('`/` lists root entries, dirs trailing-slashed (when input has whitespace)', () => {
    const t = createTerminal(SOURCES)
    // Bare `/` would suppress (no-whitespace rule) — anchor with `cat ` to
    // exercise path completion mechanics.
    const c = t.complete('cat /')
    assert.ok(c.includes('cat /src/'))
    assert.ok(c.includes('cat /README.md'))
    // Dotfiles hidden unless partial starts with '.'
    assert.ok(!c.includes('cat /.hidden'))
    assert.ok(t.complete('cat /.').includes('cat /.hidden'))
  })

  it('`./` lists cwd entries relative to the current cwd', () => {
    const t = createTerminal(SOURCES, { cwd: '/src' })
    const c = t.complete('cat ./')
    assert.ok(c.includes('cat ./foo.js'))
    assert.ok(c.includes('cat ./bar.js'))
    assert.ok(c.includes('cat ./util/'))
  })

  it('subdirectory path completion preserves the typed prefix', () => {
    const t = createTerminal(SOURCES)
    assert.deepEqual(t.complete('cat /src/f'), ['cat /src/foo.js'])
    assert.deepEqual(t.complete('cat ./src/f'), ['cat ./src/foo.js'])
  })

  it('returns [] for paths under a missing directory', () => {
    const t = createTerminal(SOURCES)
    assert.deepEqual(t.complete('cat /nope/foo'), [])
  })

  it('pipe / `&&` / `||` / `;` reset to command position', () => {
    const t = createTerminal(SOURCES)
    // Full-line replacements: everything before the trailing word is
    // preserved verbatim, so the caller can drop a result in unmodified.
    assert.deepEqual(t.complete('cat foo | gre'), ['cat foo | grep'])
    assert.deepEqual(t.complete('cat foo && gre'), ['cat foo && grep'])
    assert.deepEqual(t.complete('cat foo || gre'), ['cat foo || grep'])
    assert.deepEqual(t.complete('cat foo ; gre'), ['cat foo ; grep'])
    // `||` shouldn't be misread as two `|`s — the next-segment word
    // should still see an empty command-position word, not "|".
    const c = t.complete('cat foo ||')
    assert.ok(c.includes('cat foo ||grep'))
  })

  it('argument-position bare names path-complete against cwd', () => {
    // `cat src/f` is treated as `cat ./src/f` — both walk the FS.
    const t = createTerminal(SOURCES)
    assert.deepEqual(t.complete('cat src/f'), ['cat src/foo.js'])
    assert.deepEqual(t.complete('cat src'), ['cat src/'])
    // From inside /src, bare `fo` finds foo.js without any `./` prefix.
    const tSrc = createTerminal(SOURCES, { cwd: '/src' })
    assert.deepEqual(tSrc.complete('cat fo'), ['cat foo.js'])
    // Trailing space → empty word → cwd listing (like bash).
    const c = t.complete('cat ')
    assert.ok(c.includes('cat src/'))
    assert.ok(c.includes('cat README.md'))
    // No match still yields [].
    assert.deepEqual(t.complete('cat zzz'), [])
  })

  it('path completion in argument position works after a command', () => {
    const t = createTerminal(SOURCES)
    assert.deepEqual(t.complete('cat /src/f'), ['cat /src/foo.js'])
    const c = t.complete('cat ./')
    assert.ok(c.includes('cat ./src/'))
    assert.ok(c.includes('cat ./README.md'))
  })
})

describe('createTerminal — complete: full-line contract', () => {
  it('every variant is a drop-in replacement for the whole input', () => {
    const t = createTerminal(SOURCES)
    // Caller does NOT need to tokenize — each result string can be
    // set directly as the new input.
    assert.deepEqual(t.complete('gre'), ['grep'])
    // Pipe completion auto-inserts a space when the user didn't.
    assert.deepEqual(t.complete('cat|gre'), ['cat| grep'])
    assert.deepEqual(t.complete('cat foo | gre'), ['cat foo | grep'])
    assert.deepEqual(t.complete('  echo hi ; gre'), ['  echo hi ; grep'])
    assert.deepEqual(t.complete('cat foo | /usr/bin/gre'), ['cat foo | /usr/bin/grep'])
    assert.deepEqual(t.complete('echo bar && cat ./src/f'), ['echo bar && cat ./src/foo.js'])
  })

  it('leading whitespace and inline tabs survive verbatim', () => {
    const t = createTerminal(SOURCES)
    assert.deepEqual(t.complete('   gre'), ['   grep'])
    assert.deepEqual(t.complete('\tgre'), ['\tgrep'])
    assert.deepEqual(t.complete('a |\tgre'), ['a |\tgrep'])
  })
})

describe('createTerminal — complete: corner cases', () => {
  it('whitespace-only input is empty command position (returns all commands)', () => {
    const t = createTerminal(SOURCES)
    // Leading whitespace is preserved verbatim in each full-line variant.
    for (const input of [' ', '   ', '\t', '\n', '\t  ']) {
      const c = t.complete(input)
      assert.ok(c.includes(input + 'cat'), `expected ${JSON.stringify(input + 'cat')}`)
      assert.ok(c.includes(input + 'grep'), `expected ${JSON.stringify(input + 'grep')}`)
    }
  })

  it('separator-only input resets to fresh command position', () => {
    const t = createTerminal(SOURCES)
    // Each form: the trailing word is empty and the command-position
    // check sees `''.trim() === ''` → all commands. The separator chars
    // are kept verbatim as a prefix on each variant. The single-pipe
    // case auto-inserts a space (`|` → `| grep`); other separators
    // are left exactly as typed.
    const cases = [
      ['|',         '| grep'],
      [';',         ';grep'],
      ['||',        '||grep'],
      ['&&',        '&&grep'],
      ['|;||&&',    '|;||&&grep'],
      [';   ',      ';   grep'],
      [' && ',      ' && grep'],
    ]
    for (const [input, expected] of cases) {
      assert.ok(t.complete(input).includes(expected), `expected ${JSON.stringify(expected)} for ${JSON.stringify(input)}`)
    }
  })

  it('command-position unknown prefix returns []', () => {
    const t = createTerminal(SOURCES)
    assert.deepEqual(t.complete('zzz'), [])
    assert.deepEqual(t.complete('xyz123'), [])
    // After a pipe, still command position — same rule applies.
    assert.deepEqual(t.complete('cat | zzz'), [])
  })

  it('arg-position empty word lists everything in cwd', () => {
    const t = createTerminal(SOURCES)
    // Trailing space → empty trailing word in arg position → cwd
    // listing, line prefix preserved verbatim.
    for (const input of ['cat ', 'grep -n ', 'cat foo ']) {
      const c = t.complete(input)
      assert.ok(c.includes(input + 'src/'), `expected ${JSON.stringify(input + 'src/')}`)
      assert.ok(c.includes(input + 'README.md'))
      // Dotfiles stay hidden when partial is empty.
      assert.ok(!c.some((s) => s.endsWith('.hidden')))
    }
    // Empty FS → empty cwd listing → [].
    assert.deepEqual(createTerminal({}).complete('cat '), [])
  })

  it('arg-position bare names walk the FS (equivalent to `./`-prefixed)', () => {
    const t = createTerminal(SOURCES)
    // `cat src/f` matches `cat ./src/f` 1:1.
    assert.deepEqual(t.complete('cat src/f'), t.complete('cat ./src/f').map((s) => s.replace('./', '')))
    assert.deepEqual(t.complete('cat src/f'), ['cat src/foo.js'])
    assert.deepEqual(t.complete('cat src/'), ['cat src/util/', 'cat src/bar.js', 'cat src/foo.js'])
    assert.deepEqual(t.complete('cat src'), ['cat src/'])
    // Misses (no FS entry under cwd-relative path) still return [].
    assert.deepEqual(t.complete('cat fo'), [])
    assert.deepEqual(t.complete('cat zzz/foo'), [])
  })

  it('path completion returns [] when the directory is missing', () => {
    const t = createTerminal(SOURCES)
    assert.deepEqual(t.complete('/nope/'), [])
    assert.deepEqual(t.complete('/nope/foo'), [])
    assert.deepEqual(t.complete('./nope/'), [])
    assert.deepEqual(t.complete('./nope/foo'), [])
    // Deep nesting under a missing intermediate.
    assert.deepEqual(t.complete('/src/nope/foo'), [])
  })

  it('path completion treats a file-as-dir as missing (returns [])', () => {
    const t = createTerminal(SOURCES)
    assert.deepEqual(t.complete('/README.md/'), [])
    assert.deepEqual(t.complete('/src/foo.js/'), [])
    assert.deepEqual(t.complete('./README.md/foo'), [])
  })

  it('path completion returns [] when nothing in the directory matches', () => {
    const t = createTerminal(SOURCES)
    assert.deepEqual(t.complete('/zzz'), [])
    assert.deepEqual(t.complete('/src/zzz'), [])
    assert.deepEqual(t.complete('./zzz'), [])
  })

  it('dotfile gating: hidden entries surface only when partial starts with `.`', () => {
    const t = createTerminal(SOURCES)
    // Anchor with `cat ` so path completion fires (bare `/`-prefixed
    // tokens are suppressed by the no-whitespace rule).
    assert.ok(!t.complete('cat /').some((s) => s.endsWith('.hidden')))
    assert.ok(t.complete('cat /.').includes('cat /.hidden'))
    assert.ok(t.complete('cat /.h').includes('cat /.hidden'))
    assert.deepEqual(t.complete('cat /.x'), [])
    // Same for ./ at root.
    assert.ok(!t.complete('cat ./').some((s) => s.endsWith('.hidden')))
    assert.ok(t.complete('cat ./.').includes('cat ./.hidden'))
  })

  it('hidden commands (sed, true, false, :) are invisible to completion', () => {
    const t = createTerminal(SOURCES)
    // Each name dispatches but isn't surfaced by the completion API.
    for (const name of ['sed', 'true', 'false', ':']) {
      assert.deepEqual(t.complete(name), [], `${name} should be hidden`)
      assert.ok(!t.complete('/usr/bin/').includes('/usr/bin/' + name))
      assert.deepEqual(t.complete('/usr/bin/' + name), [])
    }
    // Empty completion (the full command list) doesn't include any of them.
    const all = t.complete('')
    for (const name of ['sed', 'true', 'false', ':']) {
      assert.ok(!all.includes(name), `${name} should be absent from empty completion`)
    }
    // Sampled prefix `se` doesn't surface sed either.
    assert.ok(!t.complete('se').includes('sed'))
    // Dispatch still works — these are HIDDEN, not removed.
    assert.equal(t.run('true').exitCode, 0)
    assert.equal(t.run('false').exitCode, 1)
    assert.equal(t.run(':').exitCode, 0)
    assert.equal(t.run('false || true').exitCode, 0)
  })

  it('empty completion lists ls first, then by auditor priority', () => {
    const t = createTerminal(SOURCES)
    const all = t.complete('')
    assert.equal(all[0], 'ls')
    // Spot-check the priority groupings.
    const idx = (name) => all.indexOf(name)
    // Browse + read + search come first.
    assert.ok(idx('cd') < idx('cat'), 'cd before cat')
    assert.ok(idx('cat') < idx('grep'), 'cat before grep')
    assert.ok(idx('grep') < idx('find'), 'grep before find')
    // pwd drops below cat/grep — the prompt already shows cwd.
    assert.ok(idx('cat') < idx('pwd'), 'cat before pwd')
    assert.ok(idx('grep') < idx('pwd'), 'grep before pwd')
    assert.ok(idx('xargs') < idx('pwd'), 'xargs before pwd (pwd is rare in audit flows)')
    // tree sits near the listing tools, not at the very end.
    assert.ok(idx('wc') < idx('tree'), 'wc before tree')
    assert.ok(idx('tree') < idx('sort'), 'tree before sort')
    // Path utilities are the tail.
    assert.ok(idx('basename') < idx('dirname'), 'basename before dirname')
    assert.equal(idx('dirname'), all.length - 1, 'dirname is last')
  })

  it('after `|`, completion only suggests commands that consume stdin', () => {
    const t = createTerminal(SOURCES)
    // Non-pipeable: ls / pwd / cd / find / tree / echo / seq / which /
    // basename / dirname — none of them read stdin, so none should
    // surface as a pipe target.
    for (const name of ['ls', 'pwd', 'cd', 'find', 'tree', 'echo', 'seq', 'which', 'basename', 'dirname']) {
      assert.deepEqual(t.complete('cat | ' + name), [], `${name} should not be a pipe target`)
    }
    // A prefix that only matches non-pipeable commands (`l` → ls) is [].
    assert.deepEqual(t.complete('cat | l'), [])
    // Pipeable: every PIPE_NAMES entry surfaces for the empty trailing word.
    const c = t.complete('cat | ')
    for (const name of ['grep', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'xargs', 'tr', 'nl', 'tac', 'cat']) {
      assert.ok(c.includes('cat | ' + name), `${name} should be a pipe target`)
    }
    // Empty completion straight after `|` has length 12 — full pipe set.
    assert.equal(c.length, 12)
  })

  it('pipe-target priority lists grep first', () => {
    const t = createTerminal(SOURCES)
    assert.equal(t.complete('cat | ')[0], 'cat | grep')
    // Most common pipe targets come before transforms / passthrough.
    const c = t.complete('cat | ')
    const idx = (full) => c.indexOf(full)
    assert.ok(idx('cat | grep') < idx('cat | sort'), 'grep before sort')
    assert.ok(idx('cat | head') < idx('cat | xargs'), 'head before xargs')
    assert.ok(idx('cat | xargs') < idx('cat | cat'), 'xargs before cat (cat passthrough is last)')
  })

  it('`||` / `&&` / `;` are not pipes — full command list applies', () => {
    const t = createTerminal(SOURCES)
    // `ls` is non-pipeable but legal after the non-pipe separators.
    assert.deepEqual(t.complete('cat || l'), ['cat || ls'])
    assert.deepEqual(t.complete('cat && l'), ['cat && ls'])
    assert.deepEqual(t.complete('cat ; l'), ['cat ; ls'])
    // Likewise for empty trailing word — fresh command position with
    // the FULL command list, including non-pipeable commands.
    assert.ok(t.complete('cat || ').includes('cat || ls'))
    assert.ok(t.complete('cat && ').includes('cat && pwd'))
    assert.ok(t.complete('cat ; ').includes('cat ; find'))
  })

  it('bin-prefix completion after `|` also restricts to pipe targets', () => {
    const t = createTerminal(SOURCES)
    // grep IS pipeable — bin-prefix path resolves.
    assert.deepEqual(t.complete('cat | /usr/bin/gre'), ['cat | /usr/bin/grep'])
    assert.deepEqual(t.complete('cat | /bin/he'), ['cat | /bin/head'])
    // ls / find / pwd are NOT pipeable — even with the bin prefix.
    assert.deepEqual(t.complete('cat | /usr/bin/l'), [])
    assert.deepEqual(t.complete('cat | /usr/bin/ls'), [])
    assert.deepEqual(t.complete('cat | /bin/find'), [])
    assert.deepEqual(t.complete('cat | /usr/bin/pwd'), [])
  })

  it('every pipe target dispatches as a real command', () => {
    // Sanity guard: PIPE_NAMES must be a subset of the public command
    // set so completion never offers a name that fails at runtime.
    const t = createTerminal(SOURCES)
    const allNames = new Set(t.complete(''))
    const pipeTargets = t.complete('cat | ').map((s) => s.slice('cat | '.length))
    for (const name of pipeTargets) {
      assert.ok(allNames.has(name), `${name} is a pipe target but missing from COMMAND_NAMES`)
    }
  })

  it('pipe at the very start of a line is recognized as command position', () => {
    const t = createTerminal({})
    // A bare `| gre` reads as "no prior command, but the next slot is
    // a pipe target". Useful when the consumer pre-inserts the pipe.
    assert.deepEqual(t.complete(' | gre'), [' | grep'])
    assert.deepEqual(t.complete(' | l'), [])
  })

  it('`|` without surrounding whitespace still pipe-filters and inserts a space', () => {
    const t = createTerminal({})
    // Auto-inserted space sits between the `|` and the completion.
    assert.deepEqual(t.complete('cat|gre'), ['cat| grep'])
    // ls is non-pipeable even when the user squishes the pipe in.
    assert.deepEqual(t.complete('cat|l'), [])
    // Empty trailing word: full pipe set, each glued to `cat| ` with a space.
    const c = t.complete('cat|')
    assert.equal(c.length, 12)
    assert.equal(c[0], 'cat| grep')
    // Every variant has the inserted space — no `cat|grep` leaks through.
    for (const variant of c) assert.ok(variant.startsWith('cat| '), `expected "cat| " prefix on ${variant}`)
  })

  it('multi-pipe pipelines filter on the most recent `|`', () => {
    const t = createTerminal(SOURCES)
    assert.deepEqual(t.complete('cat | grep TODO | he'), ['cat | grep TODO | head'])
    // ls is non-pipeable — still rejected several pipes in.
    assert.deepEqual(t.complete('cat | grep TODO | ls'), [])
    assert.deepEqual(t.complete('cat | grep TODO | l'), [])
  })

  it('`||` after a `|` resets the trailing word to the full command list', () => {
    const t = createTerminal(SOURCES)
    // Last separator is `||`, not `|` — pipe filter doesn't carry over.
    assert.deepEqual(t.complete('cat | grep || l'), ['cat | grep || ls'])
    assert.ok(t.complete('cat | grep || ').includes('cat | grep || ls'))
    assert.ok(t.complete('cat | grep || ').includes('cat | grep || pwd'))
  })

  it('path completion is suppressed everywhere after `|` (file args mislead the user)', () => {
    const t = createTerminal(SOURCES)
    // Argument position after `|` — empty word would list cwd in
    // the no-pipe case (`cat ` → [src/, README.md]); with the pipe
    // it's [].
    assert.deepEqual(t.complete('cat | grep TODO '), [])
    // Argument position, bare path partial.
    assert.deepEqual(t.complete('cat | grep TODO src/f'), [])
    // Argument position, `/`-prefixed path.
    assert.deepEqual(t.complete('cat | grep TODO /src/f'), [])
    // Argument position, `./`-prefixed path.
    assert.deepEqual(t.complete('cat | grep TODO ./src/f'), [])
    // Command position right after `|`, `./` / `/` path tokens are
    // also suppressed — even though they'd be FS lookups without
    // the pipe context.
    assert.deepEqual(t.complete('cat | ./'), [])
    assert.deepEqual(t.complete('cat | /src/f'), [])
  })

  it('but bin-prefixed command names still complete after `|` (they are commands, not files)', () => {
    const t = createTerminal(SOURCES)
    // `/usr/bin/grep` is parsed as a command alias, not a file path,
    // so bin-prefix completion still resolves against PIPE_NAMES.
    assert.deepEqual(t.complete('cat | /usr/bin/gre'), ['cat | /usr/bin/grep'])
    assert.deepEqual(t.complete('cat | /bin/he'), ['cat | /bin/head'])
    // Non-pipeable bin-prefixed commands still return [] — same as before.
    assert.deepEqual(t.complete('cat | /usr/bin/l'), [])
  })

  it('`||` / `&&` / `;` after a pipe restore normal path completion', () => {
    const t = createTerminal(SOURCES)
    // After these separators we're in a fresh statement context —
    // file args mean files again.
    assert.deepEqual(t.complete('cat ; grep PATT src/f'), ['cat ; grep PATT src/foo.js'])
    assert.deepEqual(t.complete('cat && grep PATT /src/f'), ['cat && grep PATT /src/foo.js'])
    const c = t.complete('cat || grep PATT ')
    assert.ok(c.includes('cat || grep PATT src/'))
    assert.ok(c.includes('cat || grep PATT README.md'))
  })

  it('HIDDEN pipeable command (sed) stays invisible after `|`', () => {
    const t = createTerminal(SOURCES)
    // sed reads stdin but is HIDDEN, so absent from PIPE_NAMES.
    assert.deepEqual(t.complete('cat | sed'), [])
    assert.deepEqual(t.complete('cat | /usr/bin/sed'), [])
    // `s` prefix matches the public pipeable `sort`, not the hidden `sed`.
    assert.deepEqual(t.complete('cat | s'), ['cat | sort'])
  })

  it('non-pipeable public commands (seq, which, tree) are absent from pipe completion', () => {
    const t = createTerminal(SOURCES)
    assert.deepEqual(t.complete('cat | seq'), [])
    assert.deepEqual(t.complete('cat | which'), [])
    assert.deepEqual(t.complete('cat | tree'), [])
    // `t` matches tail / tr / tac (pipeable) but NOT tree.
    const c = t.complete('cat | t')
    assert.ok(c.includes('cat | tail'))
    assert.ok(c.includes('cat | tr'))
    assert.ok(c.includes('cat | tac'))
    assert.ok(!c.includes('cat | tree'))
  })

  it('tab and mixed whitespace between `|` and the pipe target', () => {
    const t = createTerminal({})
    // Whitespace (tab or space) sitting after the `|` counts as
    // already-present — no extra space is inserted.
    assert.deepEqual(t.complete('cat |\tgre'), ['cat |\tgrep'])
    assert.deepEqual(t.complete('cat\t|\tgre'), ['cat\t|\tgrep'])
    assert.deepEqual(t.complete('cat   |    gre'), ['cat   |    grep'])
    // Empty trailing word with funky whitespace prefix still pipe-filters.
    assert.ok(t.complete('cat |  ').includes('cat |  grep'))
  })

  it('auto-inserts a space after `|` when one is missing', () => {
    const t = createTerminal({})
    // The two cases the user called out directly.
    assert.deepEqual(t.complete('cat 1 |'), [
      'cat 1 | grep', 'cat 1 | head', 'cat 1 | tail', 'cat 1 | wc',
      'cat 1 | sort', 'cat 1 | uniq', 'cat 1 | cut', 'cat 1 | xargs',
      'cat 1 | tr', 'cat 1 | nl', 'cat 1 | tac', 'cat 1 | cat',
    ])
    assert.deepEqual(t.complete('cat 1 | '), [
      'cat 1 | grep', 'cat 1 | head', 'cat 1 | tail', 'cat 1 | wc',
      'cat 1 | sort', 'cat 1 | uniq', 'cat 1 | cut', 'cat 1 | xargs',
      'cat 1 | tr', 'cat 1 | nl', 'cat 1 | tac', 'cat 1 | cat',
    ])
    // Partial pipe-target word: space goes between `|` and the word.
    assert.deepEqual(t.complete('cat |gre'), ['cat | grep'])
    assert.deepEqual(t.complete('cat|gre'), ['cat| grep'])
    // Bare `|` at the very start of a line: same treatment.
    assert.ok(t.complete('|').includes('| grep'))
    // Bin-prefix completion after a no-space pipe gets the space too.
    assert.deepEqual(t.complete('cat|/usr/bin/gre'), ['cat| /usr/bin/grep'])
  })

  it('space insertion is single-pipe-only — `||` / `&&` / `;` stay verbatim', () => {
    const t = createTerminal({})
    // `||` / `&&` / `;` start fresh statements with their own stdin,
    // so the pipe-completion convenience doesn't apply.
    assert.deepEqual(t.complete('cat||gre'), ['cat||grep'])
    assert.deepEqual(t.complete('cat&&gre'), ['cat&&grep'])
    assert.deepEqual(t.complete('cat;gre'), ['cat;grep'])
    // Even when the last separator is `||` after an earlier `|`, the
    // last-separator type wins — no space inserted.
    assert.deepEqual(t.complete('cat|grep||l'), ['cat|grep||ls'])
  })

  it('non-pipeable first command does not affect completion (no validation)', () => {
    // `echo | gre` — `echo` ignores stdin, so the pipe is wasted in
    // practice. Completion doesn't second-guess what the user typed
    // upstream of the trailing word; it just completes `gre`.
    const t = createTerminal({})
    assert.deepEqual(t.complete('echo | gre'), ['echo | grep'])
    assert.deepEqual(t.complete('pwd | he'), ['pwd | head'])
  })

  it('bin-prefix completion fires only in command position', () => {
    const t = createTerminal(SOURCES)
    // Command position (start of segment) — yes.
    assert.ok(t.complete('/usr/bin/').includes('/usr/bin/grep'))
    // Arg position — no. `/usr/bin/` isn't in the virtual FS, so path
    // completion fails over to [] rather than surfacing fake "commands".
    assert.deepEqual(t.complete('cat /usr/bin/'), [])
    assert.deepEqual(t.complete('cat /usr/bin/gre'), [])
    assert.deepEqual(t.complete('echo /bin/'), [])
  })

  it('bin-prefix completion resumes after a pipe (next stage = command position)', () => {
    const t = createTerminal(SOURCES)
    assert.deepEqual(t.complete('cat foo | /usr/bin/gre'), ['cat foo | /usr/bin/grep'])
    assert.deepEqual(t.complete('cat foo && /bin/cat'), ['cat foo && /bin/cat'])
  })

  it('bin-prefix without trailing slash falls into path completion', () => {
    const t = createTerminal(SOURCES)
    // `/usr/bin` isn't a BIN_PREFIX (those all end in /). It becomes a
    // plain path lookup, and the virtual FS has no /usr.
    assert.deepEqual(t.complete('/usr/bin'), [])
    assert.deepEqual(t.complete('/bin'), [])
    assert.deepEqual(t.complete('/sbin'), [])
  })

  it('empty filesystem: path completion is [] but commands still work', () => {
    const t = createTerminal({})
    assert.deepEqual(t.complete('/'), [])
    assert.deepEqual(t.complete('/foo'), [])
    assert.deepEqual(t.complete('./'), [])
    // Command set is intrinsic to the terminal — independent of FS.
    assert.ok(t.complete('').includes('cat'))
    assert.ok(t.complete('/usr/bin/').includes('/usr/bin/cat'))
  })

  it('separators without surrounding whitespace still split', () => {
    const t = createTerminal(SOURCES)
    // `;` / `&&` / `||` are preserved verbatim — no spaces inserted.
    // Single `|` is the exception: pipe completion auto-inserts a space.
    assert.deepEqual(t.complete('cat|gre'), ['cat| grep'])
    assert.deepEqual(t.complete('cat;gre'), ['cat;grep'])
    assert.deepEqual(t.complete('a||b||gre'), ['a||b||grep'])
    assert.deepEqual(t.complete('a&&b&&gre'), ['a&&b&&grep'])
    // Mixed and chained: last separator is `||`, so no space inserted.
    assert.deepEqual(t.complete('a|b;c&&d||gre'), ['a|b;c&&d||grep'])
  })

  it('multiple consecutive separators behave like one', () => {
    const t = createTerminal(SOURCES)
    assert.deepEqual(t.complete('a ;;; gre'), ['a ;;; grep'])
    assert.deepEqual(t.complete('a |||| gre'), ['a |||| grep'])
    assert.ok(t.complete('a ; ; ; ').includes('a ; ; ; grep'))
  })

  it('single `&` is not a separator (only `&&` is)', () => {
    const t = createTerminal(SOURCES)
    // `foo&` reads as a single command-position word; no public command
    // matches that literal, so [].
    assert.deepEqual(t.complete('foo&'), [])
    // `foo&&` IS a separator — fresh command position after it.
    assert.ok(t.complete('foo&&').includes('foo&&cat'))
    assert.deepEqual(t.complete('foo&&gre'), ['foo&&grep'])
  })

  it('cwd is live: cd changes what `./` resolves to', () => {
    const t = createTerminal(SOURCES)
    const atRoot = t.complete('cat ./')
    assert.ok(atRoot.includes('cat ./src/'))
    assert.ok(atRoot.includes('cat ./README.md'))
    t.run('cd src')
    const atSrc = t.complete('cat ./')
    assert.ok(atSrc.includes('cat ./foo.js'))
    assert.ok(atSrc.includes('cat ./util/'))
    assert.ok(!atSrc.some((s) => s.includes('./src')))
  })

  it('path completion at deep nested subdirectories', () => {
    const t = createTerminal({
      'a/b/c/d/e.js': 'x',
      'a/b/c/d/f.js': 'y',
      'a/b/c/other.js': 'z',
    })
    const c = t.complete('cat /a/b/c/d/')
    assert.deepEqual(c.sort(), ['cat /a/b/c/d/e.js', 'cat /a/b/c/d/f.js'])
    assert.deepEqual(t.complete('cat /a/b/c/d/e'), ['cat /a/b/c/d/e.js'])
    assert.deepEqual(t.complete('cat /a/b/c/o'), ['cat /a/b/c/other.js'])
  })

  it('fully-typed token completes to itself (single-match echo)', () => {
    const t = createTerminal(SOURCES)
    assert.deepEqual(t.complete('grep'), ['grep'])
    // Bin-prefix paths still complete even without whitespace — they
    // resolve as commands, not files.
    assert.deepEqual(t.complete('/usr/bin/grep'), ['/usr/bin/grep'])
    // Bare paths need a whitespace anchor to fire path completion.
    assert.deepEqual(t.complete('cat /README.md'), ['cat /README.md'])
    assert.deepEqual(t.complete('cat /src/foo.js'), ['cat /src/foo.js'])
  })

  it('command-position path tokens are always suppressed (only BIN_PREFIXES dispatch)', () => {
    const t = createTerminal(SOURCES)
    // `./` / `/` at the head of a segment look like commands but
    // resolveCommand only recognizes BIN_PREFIXES — anything else
    // would dispatch to "command not found".
    assert.deepEqual(t.complete('./'), [])
    assert.deepEqual(t.complete('/'), [])
    assert.deepEqual(t.complete('./src/f'), [])
    assert.deepEqual(t.complete('/src/f'), [])
    assert.deepEqual(t.complete('/.hidden'), [])
    // Bare names hit the command-list filter, not the FS — `src`
    // matches no command, so [].
    assert.deepEqual(t.complete('src'), [])
    assert.deepEqual(t.complete('src/f'), [])
    // Bin-prefixed commands are exempt — they resolve as commands.
    assert.deepEqual(t.complete('/usr/bin/gre'), ['/usr/bin/grep'])
    assert.deepEqual(t.complete('/bin/cat'), ['/bin/cat'])
    // Bare command-name completion still works.
    assert.deepEqual(t.complete('gre'), ['grep'])
    // Leading whitespace doesn't change "we're in command position".
    assert.deepEqual(t.complete(' ./'), [])
    assert.deepEqual(t.complete('\t./'), [])
    // After `;` / `&&` / `||`, the next segment is also command
    // position — same suppression, regardless of intervening spaces.
    assert.deepEqual(t.complete('a;./script'), [])
    assert.deepEqual(t.complete('a; ./'), [])
    assert.deepEqual(t.complete('a && /src/f'), [])
    // BUT: if the path is preceded by an already-typed command in
    // the same segment, it's argument position — completion fires.
    assert.ok(t.complete('cat ./').includes('cat ./src/'))
    assert.ok(t.complete('a ; cat ./').includes('a ; cat ./src/'))
    assert.deepEqual(t.complete('cat /src/f'), ['cat /src/foo.js'])
  })

  it('cd suggests only directories (files are not valid `cd` targets)', () => {
    const t = createTerminal({
      'src/foo.js': 'x',
      'src/util/log.js': 'y',
      'README.md': 'z',
      'dist/index.js': 'w',
    })
    // Empty trailing word: cwd dirs only, no files.
    const c = t.complete('cd ')
    assert.ok(c.includes('cd src/'))
    assert.ok(c.includes('cd dist/'))
    assert.ok(!c.includes('cd README.md'))
    // Partial dir name.
    assert.deepEqual(t.complete('cd sr'), ['cd src/'])
    // Subdir — only `util/` survives, no `foo.js`.
    assert.deepEqual(t.complete('cd src/'), ['cd src/util/'])
    // `./` and `/` paths follow the same rule.
    assert.ok(t.complete('cd ./').includes('cd ./src/'))
    assert.ok(!t.complete('cd ./').some((s) => s.endsWith('README.md')))
    assert.ok(t.complete('cd /').includes('cd /src/'))
    assert.ok(!t.complete('cd /').some((s) => s.endsWith('README.md')))
  })

  it('cd via bin prefix (`/usr/bin/cd`) still does dirs-only completion', () => {
    const t = createTerminal({ 'src/foo.js': 'x', 'README.md': 'y' })
    // resolveCommand collapses `/usr/bin/cd` to `cd`, so the
    // per-command rule fires for both spellings.
    for (const cmd of ['/usr/bin/cd', '/bin/cd']) {
      const c = t.complete(cmd + ' ')
      assert.ok(c.includes(cmd + ' src/'), `${cmd} should suggest src/`)
      assert.ok(!c.includes(cmd + ' README.md'), `${cmd} should NOT suggest README.md`)
    }
  })

  it('cd dotfile gating: hidden dirs surface only when partial starts with `.`', () => {
    const t = createTerminal({
      'src/foo.js': 'x',
      '.config/settings.json': 'y',
    })
    // `.config/` is a hidden dir — invisible by default.
    assert.ok(!t.complete('cd ').some((s) => s.includes('.config')))
    // Surfaces once the partial starts with '.'.
    assert.ok(t.complete('cd .').includes('cd .config/'))
  })

  it('cd dirs-only doesn\'t leak into other commands', () => {
    // Regression: cat / grep / etc. still see files as before.
    const t = createTerminal({ 'src/foo.js': 'x', 'README.md': 'y' })
    const c = t.complete('cat ')
    assert.ok(c.includes('cat src/'))
    assert.ok(c.includes('cat README.md'))
    const g = t.complete('grep PATT ')
    assert.ok(g.includes('grep PATT src/'))
    assert.ok(g.includes('grep PATT README.md'))
  })
})

// GNU-match regression guards. Each test pins a behavior our impl
// already shares with GNU but no other test exercised — so a future
// "small refactor" of the affected code path can't silently shift
// the semantic. Expectations verified against `/usr/bin/{grep,head,
// tail,wc,sort,cut,cat}` byte-for-byte before adding.
describe('createTerminal — GNU-match regression guards', () => {
  it('grep -v inverts the match (entire flag was previously untested)', () => {
    // `-v` is listed in SHORT_FLAGS and threaded through grepRun,
    // grepCount, grepListFiles — but no test exercised it. Trivial
    // to break in a future refactor that drops the invert flag.
    const t = createTerminal({ 'f.txt': 'apple\nbanana\ncherry\n' })
    assert.equal(t.run('grep -v banana f.txt').stdout, 'apple\ncherry\n')
    // -v with no match: invert empty = everything.
    assert.equal(t.run('grep -v zzz f.txt').stdout, 'apple\nbanana\ncherry\n')
    // -v that matches everything: invert all = nothing → exit 1.
    const r = t.run('grep -v "" f.txt')
    assert.equal(r.exitCode, 1)
    assert.equal(r.stdout, '')
  })

  it('grep -cv counts non-matching lines (count + invert composition)', () => {
    const t = createTerminal({ 'f.txt': 'apple\nbanana\ncherry\n' })
    assert.equal(t.run('grep -cv banana f.txt').stdout, '2\n')
    // -c without -v counts matches; the inversion flips it.
    assert.equal(t.run('grep -c banana f.txt').stdout, '1\n')
  })

  it('grep -A 0 emits the match and no following context', () => {
    // Boundary: zero context is distinct from "no -A" — both produce
    // the same output, but the code path differs (-A 0 still hits
    // the context-printing branch). GNU verified.
    const t = createTerminal({ 'f.txt': 'one\nbanana\nthree\nfour\n' })
    assert.equal(t.run('grep -A 0 banana f.txt').stdout, 'banana\n')
  })

  it("grep -A N inserts `--` between non-adjacent context groups (single-file, no -n)", () => {
    // The existing test at the `-n`/multi-flag combination didn't
    // exercise the plain single-file separator path. GNU verified:
    // `grep -A1 M f` on a file with two M lines separated by gaps
    // produces `M1\nx\n--\nM2\nx\n` exactly.
    const t = createTerminal({ 'sep.txt': 'M1\nx\ny\nz\nM2\nx\n' })
    assert.equal(t.run('grep -A1 M sep.txt').stdout, 'M1\nx\n--\nM2\nx\n')
  })

  it('head / tail with -n 0 produce empty output and exit 0', () => {
    // Boundary: `-n 0` requests zero lines. GNU exits 0 with no
    // output (not 1, not an error). The tail branch had a guard
    // against `slice(-0)` returning the whole array — confirm
    // the guard is still there.
    const t = createTerminal({ 'f.txt': 'a\nb\nc\n' })
    const h = t.run('head -n 0 f.txt')
    assert.equal(h.exitCode, 0)
    assert.equal(h.stdout, '')
    const tn = t.run('tail -n 0 f.txt')
    assert.equal(tn.exitCode, 0)
    assert.equal(tn.stdout, '')
  })

  it('head / tail default to 10 lines when -n is omitted', () => {
    // The `10` default is GNU's, hardcoded in our impl as the
    // parseNonNegativeInt fallback. Pin it.
    const lines = Array.from({ length: 15 }, (_, i) => String(i + 1)).join('\n') + '\n'
    const t = createTerminal({ 'f.txt': lines })
    assert.equal(t.run('head f.txt').stdout, '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n')
    assert.equal(t.run('tail f.txt').stdout, '6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n')
  })

  it('wc with no flags emits all three columns + total (default behavior)', () => {
    // No test currently exercises the bare `wc` invocation — the
    // default (all three columns) and the multi-file `total` row
    // are both common GNU behaviors that should stay stable.
    // Verified against /usr/bin/wc byte-for-byte: the total row's
    // 16 bytes is the widest count, so adaptive width is 2.
    const t = createTerminal({
      'a.txt': 'a a a\nb\nc\n',    // 3 lines, 5 words, 10 bytes
      'b.txt': 'x\ny\nz\n',         // 3 lines, 3 words,  6 bytes
    })
    assert.equal(
      t.run('wc a.txt b.txt').stdout,
      ' 3  5 10 a.txt\n 3  3  6 b.txt\n 6  8 16 total\n',
    )
  })

  it('sort -ru produces the deduped set in descending order', () => {
    // Combined-flag composition: -u removes duplicates, -r reverses.
    // GNU runs them in that order so the output is the unique values
    // sorted descending. Verified against /usr/bin/sort.
    const t = createTerminal({ 'f.txt': '3\n1\n3\n2\n1\n' })
    assert.equal(t.run('sort -ru f.txt').stdout, '3\n2\n1\n')
  })

  it('cut -c N past the end of a line emits an empty line for that row', () => {
    // Fixed character position past EOL is distinct from open-ended
    // ranges (which the existing test covers): each short line
    // contributes a bare newline. GNU verified.
    const t = createTerminal({ 's.txt': 'ab\ncd\n' })
    assert.equal(t.run('cut -c5 s.txt').stdout, '\n\n')
  })

  it('cut -d X -f N passes through lines that lack the delimiter (matches GNU default)', () => {
    // GNU's default behavior (without `-s`): lines without the
    // delimiter print verbatim. The existing impl comment claims
    // this match; pin it so a future `-s` ("suppress") implementation
    // doesn't accidentally suppress no-delim lines under the default.
    const t = createTerminal({ 'csv.txt': 'a:b:c\nzzz\n' })
    assert.equal(t.run('cut -d: -f3 csv.txt').stdout, 'c\nzzz\n')
  })

  it('cat -n preserves a missing trailing newline (numberLines tracks it explicitly)', () => {
    // Counterpoint to the head/tail/sed `it.todo` items: cat -n
    // explicitly tracks the source's trailing-newline status via the
    // `trailing` local in numberLines, so it doesn't have the bug.
    // Pin this — a refactor that switches to the splitLines/joinLines
    // pattern would silently break it.
    const t = createTerminal({ 'nl.txt': 'foo' })   // no trailing newline
    assert.equal(t.run('cat -n nl.txt').stdout, '     1\tfoo')
  })

  it('pipeline exit code is the LAST stage\'s exit (matches default sh, not pipefail)', () => {
    // `grep zzz | wc -l` — grep exits 1 (no match) but the pipeline
    // exits 0 (wc succeeded). Pin this so a future change toward
    // pipefail-by-default doesn\'t silently shift the semantic and
    // break scripts that rely on `cmd | tee` etc. exiting 0.
    const t = createTerminal({ 'f.txt': 'apple\nbanana\n' })
    const noMatch = t.run('grep zzz f.txt | wc -l')
    assert.equal(noMatch.exitCode, 0)
    assert.equal(noMatch.stdout, '0\n')
    // The reverse: successful grep through failing tail (tail -n 0
    // exits 0 silently, so no failure to test cleanly here) — use
    // an explicit `false` stage instead.
    const tailFails = t.run('cat f.txt | false')
    assert.equal(tailFails.exitCode, 1)
  })

  it('empty input handling across cat/grep/wc/sort/uniq matches GNU', () => {
    // Canonical edge case — empty input is the source of half of
    // off-by-one bugs in stream-processing code. Pin the exit codes
    // and (empty) stdout for each affected command in one place.
    const t = createTerminal({ 'e.txt': '' })
    // cat: empty stdout, exit 0.
    assert.deepEqual(
      { stdout: t.run('cat e.txt').stdout, exitCode: t.run('cat e.txt').exitCode },
      { stdout: '', exitCode: 0 },
    )
    // grep: no match → exit 1, no output. POSIX's "an error didn't
    // occur but nothing matched" status.
    const g = t.run('grep X e.txt')
    assert.equal(g.exitCode, 1)
    assert.equal(g.stdout, '')
    // wc: three zeros, single-char width.
    assert.equal(t.run('wc e.txt').stdout, '0 0 0 e.txt\n')
    // sort / uniq: no input → no output, exit 0.
    assert.equal(t.run('sort e.txt').stdout, '')
    assert.equal(t.run('sort e.txt').exitCode, 0)
    assert.equal(t.run('uniq e.txt').stdout, '')
    assert.equal(t.run('uniq e.txt').exitCode, 0)
  })

  it('echo -e interprets `\\t`, `\\n`, `\\\\`, and `\\0` escapes', () => {
    // The escape table in echo's parser is small and easy to break.
    // Pin each supported escape so a refactor that drops one fails
    // loudly. Bare echo (no -e) keeps the backslashes literal.
    const t = createTerminal({})
    assert.equal(t.run('echo -e a\\tb').stdout, 'a\tb\n')
    assert.equal(t.run('echo -e a\\nb').stdout, 'a\nb\n')
    assert.equal(t.run('echo -e a\\\\b').stdout, 'a\\b\n')
    assert.equal(t.run('echo -e a\\0b').stdout, 'a b\n')
    // -E (or no flag) is the inverse: backslashes pass through.
    assert.equal(t.run('echo -E a\\tb').stdout, 'a\\tb\n')
  })

  it('find -name matches hidden files by default (no special-case skip)', () => {
    // GNU find does NOT skip dotfiles in `-name` matching (only the
    // shell\'s glob expansion does, for argv tokens). `find . -name
    // '.hidden'` matches; `*` matches everything including hidden;
    // pattern starting with `*` matches hidden. Pin all three.
    const t = createTerminal({ '.hidden': '', 'visible': '', 'sub/.deep': '' })
    assert.equal(
      t.run('find . -name .hidden').stdout.split('\n').filter(Boolean).join(','),
      './.hidden',
    )
    // `*hidden` matches `.hidden` because find\'s glob doesn\'t apply
    // the bash dotfile rule.
    assert.equal(
      t.run("find . -name '*hidden'").stdout.split('\n').filter(Boolean).join(','),
      './.hidden',
    )
    // The descendant `.deep` is reached by `-name '.deep'`, confirming
    // hidden-file matching works inside subdirs too.
    assert.match(t.run("find . -name '.deep'").stdout, /\.\/sub\/\.deep/u)
  })

  it('sort -n handles negative numbers and zero correctly', () => {
    // Numeric sort should order `-5 < -1 < 0 < 10 < 100`. A naive
    // string compare would give `-1 -5 0 10 100` (wrong) or
    // `0 10 100 -1 -5` (wrong). Pin the numeric ordering.
    const t = createTerminal({ 'n.txt': '10\n-5\n0\n-1\n100\n' })
    assert.equal(t.run('sort -n n.txt').stdout, '-5\n-1\n0\n10\n100\n')
  })
})

// Known divergences from GNU/POSIX surfaced by the audit pass. Each
// `it.todo` carries a concrete spec body that fails on current
// behavior — when someone fixes the underlying issue, the todo
// starts passing and they flip `it.todo` → `it`. GNU expectations
// pinned by side-by-side runs against `/usr/bin/{find,sed,grep,ls,
// head,tail,wc}` (coreutils 9.x, find 4.9, sed 4.9).
//
// Deferred because each requires changes beyond the file(s) where
// the symptom appears: trailing-newline tracking needs splitLines/
// readInputs to carry the source's terminator status, the `\;`
// idiom needs the shell parser to honor backslash-escapes outside
// quotes, walkTree order is shared by find/grep/ls, etc.
describe('createTerminal — known divergences from GNU (tracked)', () => {
  it.todo('sed preserves the last-line no-trailing-newline (no spurious `\\n` appended)', () => {
    // GNU: `printf 'Y' | sed -n '1p'` → `Y` (1 byte, no newline).
    // Ours always appends `\n` via `out.join('\n') + '\n'`. Same
    // pattern in head/tail/sed/etc. — see the two `it.todo` below.
    const t = createTerminal({ 'b.txt': 'Y' })   // no trailing newline
    assert.equal(t.run("sed -n '1p' b.txt").stdout, 'Y')
  })

  it.todo('head preserves the last-line no-trailing-newline', () => {
    // GNU: `head -n 1` on a single-line file with no trailing nl
    // emits the line as-is. Ours adds `\n`.
    const t = createTerminal({ 'noNl.txt': 'foo' })
    assert.equal(t.run('head -n 1 noNl.txt').stdout, 'foo')
  })

  it.todo('tail preserves the last-line no-trailing-newline', () => {
    // Same as head; same root cause (`splitLines` drops the
    // terminator info, the okWith pipeline re-adds `\n` blindly).
    const t = createTerminal({ 'noNl.txt': 'foo' })
    assert.equal(t.run('tail -n 1 noNl.txt').stdout, 'foo')
  })

  it.todo('find ... -exec CMD \\; works (canonical GNU idiom)', () => {
    // GNU's documented form uses bare `\;` for the terminator. Our
    // shell parser doesn't honor backslash-escapes outside quotes,
    // so `\;` becomes the step separator before find sees it.
    // Workaround `';'` / `";"` works today; this would fail under
    // the same shell parser. Fixing requires honoring `\<char>`
    // escapes in parse.js (project-wide impact on every command).
    const t = createTerminal({ 'src/foo.js': '', 'src/bar.js': '' })
    const r = t.run('find src -type f -exec echo {} \\;')
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout.split('\n').filter(Boolean).sort().join(','), 'src/bar.js,src/foo.js')
  })

  it.todo('find walks DFS so a directory and its subtree are contiguous (matching GNU)', () => {
    // GNU find walks DFS pre-order: a directory's full subtree
    // appears before its next sibling. Our walkTree is BFS-with-
    // sort, so siblings interleave — every immediate child of `/`
    // prints before any grandchild. Knock-on effects: `find … -exec
    // sed -n '1p' {} +` first-file behavior depends on which file
    // leads the batch.
    //
    // Test the property (DFS contiguity), not byte-exact order —
    // GNU's specific tmpfs ordering depends on readdir() return,
    // which varies by FS. Our virtual FS sorts, so post-fix the
    // order would be sorted DFS; either way the contiguity holds.
    const t = createTerminal({
      'a/x.txt': '',
      'a/sub/y.txt': '',
      'b/z.txt': '',
    })
    const lines = t.run('find .').stdout.split('\n').filter(Boolean)
    const aIdx = lines.indexOf('./a')
    const aGrandchild = lines.indexOf('./a/sub/y.txt')
    const bIdx = lines.indexOf('./b')
    assert.ok(
      aIdx < aGrandchild && aGrandchild < bIdx,
      `a's subtree should sit between ./a and ./b under DFS: ${JSON.stringify(lines)}`,
    )
  })

  it('find -name glob accepts backslash-escapes (`\\-foo` matches literal `-foo`)', () => {
    // GNU find escapes the next char as literal: `\-` matches `-`,
    // useful for filenames starting with `-`. Verified against
    // /usr/bin/find 4.9. `compileGlob` consumes the backslash and
    // emits the next char as a literal regex token.
    const t = createTerminal({ '-foo': '' })
    const r = t.run("find . -name '\\-foo'")
    assert.equal(r.stdout.split('\n').filter(Boolean).join(','), './-foo')
  })

  it('find -name glob escapes regex metachars cleanly (`\\*` / `\\?` match literal `*` / `?`)', () => {
    // Regression: an early refactor of compileGlob escaped `\<x>` for
    // ordinary chars but forgot `*` / `?` — patterns like `\*` produced
    // the invalid regex `^*$` and threw. Now they match the literal
    // glob metachar in a filename, matching bash convention.
    const t = createTerminal({ '*': 'x', '?': 'y', 'plain': 'z' })
    assert.equal(
      t.run("find . -name '\\*'").stdout.split('\n').filter(Boolean).join(','),
      './*',
    )
    assert.equal(
      t.run("find . -name '\\?'").stdout.split('\n').filter(Boolean).join(','),
      './?',
    )
    // Unescaped `*` still matches everything (sanity check that the
    // escape branch didn't swallow the wildcard semantics).
    assert.ok(t.run("find . -name '*'").stdout.includes('plain'))
  })

  it.todo('find -name glob supports character classes (`[fb]oo.js` matches `foo.js`)', () => {
    // GNU shell-style glob accepts `[...]` (POSIX too). Our impl
    // only models `*` and `?` (the glob.js header documents this).
    // Silent miss — would benefit from either implementation or
    // explicit rejection so users see "unsupported pattern".
    const t = createTerminal({ 'src/foo.js': '', 'src/boo.js': '', 'src/bar.js': '' })
    const lines = new Set(t.run("find src -name '[fb]oo.js'").stdout.split('\n').filter(Boolean))
    assert.deepEqual(lines, new Set(['src/foo.js', 'src/boo.js']))
  })

  it.todo('grep -r/-R prefixes paths with the user-typed `.` (matches GNU)', () => {
    // GNU: `grep -r foo .` produces `./src/x.js:foo`. Ours strips
    // the leading `./`, producing `src/x.js:foo`. The current code
    // has an explicit comment about this divergence (grep vs find)
    // — flagging here so a future audit can decide whether to align.
    const t = createTerminal({ 'src/a.js': 'foo\n' })
    const r = t.run('grep -r foo .')
    assert.match(r.stdout, /^\.\/src\/a\.js:/u)
  })

  it('ls -a includes `.` and `..` entries (matches GNU)', () => {
    // GNU `ls -a` lists `.` and `..` alongside dotfiles, printed
    // bare (no trailing `/` despite being dirs — they're navigation
    // handles, not browsable subtrees).
    const t = createTerminal({ '.hidden': '', 'visible': '' })
    const r = t.run('ls -a')
    const entries = r.stdout.split('\n').filter(Boolean)
    assert.ok(entries.includes('.'), `expected '.' in ${JSON.stringify(entries)}`)
    assert.ok(entries.includes('..'))
    // `.` and `..` lead the listing, before any other entries.
    assert.equal(entries[0], '.')
    assert.equal(entries[1], '..')
  })

  it('wc adapts column width to the widest count (GNU)', () => {
    // Verified against /usr/bin/wc 9.x:
    //   `wc -l a.txt` (3-line file) → `3 a.txt` (no leading pad)
    //   `wc -l small big` (3 vs 100 lines) → `  3 small\n100 big\n103 total`
    const t = createTerminal({ 'a.txt': 'x\ny\nz\n' })
    assert.equal(t.run('wc -l a.txt').stdout, '3 a.txt\n')
    // Multi-file padding tracks the widest count (including the
    // total row): 3 vs 10 yields width-2 padding.
    const big = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    const t2 = createTerminal({ 'small': 'a\nb\nc\n', 'big': big })
    // 3 + 10 = 13, three rows.
    assert.equal(t2.run('wc -l big small').stdout, '10 big\n 3 small\n13 total\n')
  })

  it.todo('ls / sed exit 2 on missing files (matching GNU), not 1', () => {
    // Our okWith / partial-failure convention uses exit 1 across
    // cat/grep/head/tail/wc/ls/sed. GNU coreutils use 2 for
    // ls / sed and 1 for cat. Aligning would let scripts that check
    // `$?` against GNU coreutils behave the same way.
    const t = createTerminal({ 'a.txt': 'x\n' })
    assert.equal(t.run('ls nope').exitCode, 2)
    assert.equal(t.run("sed -n '1p' nope").exitCode, 2)
  })
})
