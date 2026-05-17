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

  it('grep -r errors on a missing starting path', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('grep -r TODO nope')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /no such file or directory/u)
  })

  it('grep -r combines with -i and -n', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('grep -irn todo src')
    assert.equal(r.exitCode, 0)
    assert.match(r.stdout, /^src\/foo\.js:2:\/\/ TODO: fix$/mu)
    assert.match(r.stdout, /^src\/bar\.js:2:\/\/ TODO: doc this$/mu)
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

  it('uniq -c counts CONSECUTIVE runs (not totals — matches coreutils)', () => {
    // GNU `uniq` only collapses adjacent duplicates; non-adjacent
    // dupes keep separate count rows. Width 7 + space + value.
    const t = createTerminal({ 'f.txt': 'a\na\nb\na\n' })
    assert.equal(t.run('cat f.txt | uniq -c').stdout, '      2 a\n      1 b\n      1 a\n')
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

  it('wc -l counts lines from a pipe', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('cat src/foo.js | wc -l')
    assert.match(r.stdout, /^\s+3\s*$/u)
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
      "sed -n '1,5p;10,15p' big.txt",       // multiple scripts
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
      ["sed -n '1,2p' big.txt other.txt", /at most one input file/u],
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
    // plus the total. Each line has a 7-wide right-aligned count.
    assert.match(r.stdout, /\b2\b.*dir\/bar\.js/u)
    assert.match(r.stdout, /\b3\b.*dir\/foo\.js/u)
    assert.match(r.stdout, /\b5\b.*total/u)
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
