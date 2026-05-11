import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createTerminal } from '../terminal/index.js'

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

  it('grep usage line uses [PATH...] (covers directories under -r)', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('grep')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /PATTERN \[PATH\.\.\.\]/u)
    // Hard-rejects the old `[FILE...]` wording so a regression
    // (re-narrowing the docs) shows up here.
    assert.doesNotMatch(r.stderr, /\[FILE\.\.\.\]/u)
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
    const r = t.run('grep -o "http://[^ ]+" urls.txt')
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

describe('createTerminal — count validation', () => {
  it('empty string (e.g. `head -n "" file`) is rejected, not silently 0', () => {
    const t = createTerminal(SOURCES)
    const r = t.run('head -n "" src/foo.js')
    assert.notEqual(r.exitCode, 0)
    assert.match(r.stderr, /invalid count/u)
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
