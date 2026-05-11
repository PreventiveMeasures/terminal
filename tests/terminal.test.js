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
