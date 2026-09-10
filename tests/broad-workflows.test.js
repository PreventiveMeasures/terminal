import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = { f: '0123456789\n', g: 'abc\n', 'dir/z': 'z\n', '.hidden': '', 'a.js': '', a: '', b: '', '[z-a]': '', binary: 'x\0y\n' }
function check(command, stdout, files = FILES) {
  const r = createTerminal(files).run(command)
  assert.deepEqual([r.stdout, r.stderr, r.exitCode, r.unsupported], [stdout, '', 0, []], command)
}

describe('broad audit — ordered shell output and control flow', () => {
  for (const body of ['{ echo a >&2; echo b; echo c >&2; }', '(echo a >&2; echo b; echo c >&2)', 'for x in a b c; do echo $x >&2; done']) {
    for (const suffix of ['2>&1', '|& cat', '2>&1 | cat']) {
      it(`${body} ${suffix} preserves the order of both streams`, () => check(`${body} ${suffix}`, 'a\nb\nc\n'))
    }
  }
  it('keeps stream redirection order and nested stream identities', () => {
    check('{ echo a >&2; { echo b; echo c >&2; } 2>&1; echo d; } 2>&1', 'a\nb\nc\nd\n')
    check('{ echo a; echo b >&2; } >/dev/null |& cat', '')
    check('{ echo a; echo b >&2; } 2>/dev/null |& cat', 'a\nb\n')
  })
  for (const [command, out] of [
    ['for x in a b; do for y in c d; do echo $x$y; break 2; done; echo wrong; done; echo done', 'ac\ndone\n'],
    ['for x in a b; do for y in c d; do echo $x$y; continue +2; done; echo wrong; done', 'ac\nbc\n'],
    ['x=a; export x+=b y=c; echo $x $y', 'ab c\n'],
    ['x=a; y=b; unset x bad-name y; echo "${x}" "${y}"', ' \n'],
    ['unset -- -name; echo done', 'done\n'],
  ]) it(command, () => check(command, out))
  it('continues export after an invalid identifier', () => {
    const r = createTerminal(FILES).run('export x=one bad-name y=two; echo $x $y')
    assert.deepEqual([r.stdout, r.exitCode, r.unsupported], ['one two\n', 0, []])
    assert.match(r.stderr, /not a valid identifier/u)
  })
  it('preserves explicit unsets across runs and temporary scopes', () => {
    const t = createTerminal(FILES)
    t.run('unset HOME PWD x')
    assert.equal(t.run('cd').stderr, 'cd: HOME not set\n')
    assert.deepEqual(t.run('echo "$HOME$PWD$x"').unsupported, [])
    assert.equal(t.run('cd dir; echo $PWD').stdout, '/dir\n')
    check('x=old; x=tmp unset x; echo $x', 'old\n')
    check('x=old; (unset x); echo $x', 'old\n')
    check('y=tmp unset x; echo "$x"', '\n')
  })
  it('validates loop control arguments and preserves subshell boundaries', () => {
    const t = createTerminal(FILES)
    assert.equal(t.run('exit " 3 "').exitCode, 3)
    const zero = t.run('for x in a b; do for y in c d; do echo $x$y; continue 0; done; echo wrong; done; echo done')
    assert.equal(zero.stdout, 'ac\ndone\n')
    assert.match(zero.stderr, /loop count out of range/u)
    for (const args of ['nope', '1 2']) {
      const r = t.run(`for x in a b; do break ${args}; echo wrong; done; echo wrong`)
      assert.equal(r.stdout, '')
      assert.notEqual(r.exitCode, 0)
    }
    const isolated = t.run('for x in a b; do (break); echo $x; done')
    assert.equal(isolated.stdout, 'a\nb\n')
    assert.match(isolated.stderr, /only meaningful/u)
    assert.equal(t.run('break 0; echo done').stdout, 'done\n')
  })
})

describe('broad audit — readers preserve shared input', () => {
  for (const cmd of ['head -n0', 'head -c0', 'tail -n0', 'tail -c0']) {
    it(`${cmd} leaves shared input untouched`, () => check(`{ ${cmd}; cat; } < f`, FILES.f))
  }
  for (const cmd of ['od -N1', 'xxd -l1', 'hexdump -n1']) {
    it(`${cmd} leaves unread bytes for cat`, () => {
      const t = createTerminal(FILES)
      const first = t.run(`${cmd} < f`)
      const both = t.run(`{ ${cmd}; cat; } < f`)
      assert.deepEqual([both.stdout, both.stderr, both.unsupported], [first.stdout + FILES.f.slice(1), '', []])
    })
  }
  for (const cmd of ['tr a', 'xargs -n0', 'sort missing', 'od -Nbad']) {
    it(`${cmd} validates before consuming input`, () => {
      const r = createTerminal(FILES).run(`{ ${cmd}; cat; } < f`)
      assert.equal(r.stdout, FILES.f)
      assert.notEqual(r.stderr, '')
      assert.deepEqual(r.unsupported, [])
    })
  }
  it('does not open operands beyond a satisfied byte limit', () => {
    const t = createTerminal(FILES)
    assert.deepEqual(t.run('od -N1 f missing'), t.run('od -N1 f'))
    assert.deepEqual(t.run('hexdump -n1 f missing'), t.run('hexdump -n1 f'))
    assert.deepEqual(t.run('head -n0 dir'), { stdout: '', stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [] })
  })
  it('distinguishes absolute xxd/hexdump seeks from relative od skips', () => {
    const t = createTerminal(FILES)
    for (const [cmd, rest] of [['xxd -s1 -l2', FILES.f.slice(3)], ['hexdump -s1 -n2', FILES.f.slice(3)]]) {
      const first = t.run(`${cmd} f`)
      const both = t.run(`{ head -c2; ${cmd}; cat; } < f`)
      assert.deepEqual([both.stdout, both.stderr, both.unsupported], ['01' + first.stdout + rest, '', []])
    }
    const r = t.run('echo abc | hexdump -s1')
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /Illegal seek/u)
    assert.notEqual(r.exitCode, 0)
  })
  it('stops tail from-start mode at an unreadable directory', () => {
    const r = createTerminal(FILES).run('tail -n+1 f dir g')
    assert.equal(r.stdout, '==> f <==\n0123456789\n\n==> dir <==\n')
    assert.match(r.stderr, /is a directory/u)
    assert.equal(r.exitCode, 1)
  })
  it('a failed hexdump seek does not consume pipe input', () => {
    const r = createTerminal(FILES).run('cat f | { hexdump -s1; cat; }')
    assert.equal(r.stdout, FILES.f)
    assert.match(r.stderr, /Illegal seek/u)
    assert.deepEqual(r.unsupported, [])
  })
})

describe('broad audit — fields, names and traversal', () => {
  it('preserves repeated slashes and dot components in expanded paths', () => {
    check('echo dir//* ././*.js', 'dir//z ././a.js\n')
    check('echo .//dir///', './/dir///\n')
    check('echo .//dir//*/', './/dir//*/\n')
  })
  it('reversed glob ranges match an empty set, including within negation', () => {
    check("find . -name '[z-a]'", '')
    check("find . -maxdepth 1 -name '[!z-a]'", '.\n./a\n./b\n./f\n./g\n')
    check('echo [!z-a]', 'a b f g\n')
  })
  it('handles repeated find negation and leading --', () => {
    check("find -- . ! ! -name 'a.js'", './a.js\n')
    const r = createTerminal(FILES).run('find . -name a -- dir')
    assert.notEqual(r.exitCode, 0)
    assert.equal(r.stdout, '')
    assert.notEqual(createTerminal(FILES).run('find . ! !').exitCode, 0)
    assert.notEqual(createTerminal(FILES).run('find . -- -maxdepth 0').exitCode, 0)
  })
  it('counts words with GNU Unicode separators and honors explicit C locale', () => {
    check('wc -w f', '2 f\n', { f: 'a\u2060b\n' })
    check('wc -w f', '1 f\n', { f: 'a\uFEFFb\n' })
    check('LC_ALL=C wc -wm f', '1 6 f\n', { f: 'a\u2060b\n' })
  })
  it('uses newline/NUL delimiters and blank-separated cut lists', () => {
    check("cut -d '\n' -f2 f", 'b\n', { f: 'a\nb\n' })
    check("cut -d '' -f2 f", 'b\n', { f: 'a\0b\n' })
    check("cut -c '1 3' f", '02\n')
    assert.notEqual(createTerminal(FILES).run("cut -d é -f1 f").exitCode, 0)
    assert.notEqual(createTerminal(FILES).run("sort -t é f").exitCode, 0)
  })
  it('prints tree defaults, hidden files, directory suffixes and totals', () => {
    const files = { '.hidden': '', a: '', 'b/q': '', 'z/k': '' }
    check('tree', '.\n├── a\n├── b\n│   └── q\n└── z\n    └── k\n\n3 directories, 3 files\n', files)
    check('tree -d b', 'b\n\n0 directories\n', files)
    check('tree -FaL1 --noreport', './\n├── .hidden\n├── a\n├── b/\n└── z/\n', files)
    check('tree', '.\n\n0 directories, 0 files\n', {})
  })
  it('xargs discards a trailing escape and treats NUL separators literally with -0', () => {
    check('cat f | xargs echo pre', 'pre a\n', { f: 'a\\' })
    check('cat f | xargs -0 -n1 echo pre', 'pre \npre \n', { f: '\0\0' })
  })
  it('date recognizes literal percent sequences and a configured UTC timezone', () => {
    check("TZ=UTC date '+%%N %%q %Z %z'", '%N %q UTC +0000\n')
  })
})

describe('broad audit — unsupported constructs remain visible to agents', () => {
  const cases = [
    ['cat f missing 2>&1', 'combined output ordering'],
    ["find . -name '?'", 'non-ASCII glob matching'],
    ['xxd -s-2 f', '-s -2'],
    ['od f 10', 'legacy offset operand'],
    ['od -j1 dir f', 'skip across unreadable input'],
    ['hexdump -s010 f', '-s 010'],
    ['hexdump -s9007199254740992', 'large byte count'],
    ['hexdump -n1 -', 'hyphen input operand'],
    ["tr '\\' x </dev/null", 'trailing backslash'],
    ['cat binary | xargs -I{} echo {}', 'NUL input'],
    ['echo dir | xargs cd', 'cd'],
    ['find . -exec exit \\; </dev/null', 'exit'],
    ['PATH=/tmp echo hello', 'PATH'],
    ['TZ=Europe/London date', 'TZ'],
    ['RANDOM=1; echo $RANDOM', 'RANDOM'],
    ['tree', 'filename escaping'],
    ['od -N1; cat', 'partial UTF-8 byte sequence'],
  ]
  for (const [command, detail] of cases) {
    it(`${command} mirrors its limitation with stderr hidden`, () => {
      const files = { ...FILES, 'é': '', 'back\\name': '', input: 'é' }
      const run = (s) => createTerminal(files).run(s)
      const visible = run(`{ ${command}; } < input`)
      assert.ok(visible.unsupported.some((note) => note.detail === detail), JSON.stringify(visible))
      assert.notEqual(visible.stderr + visible.stdout, '')
      const hidden = run(`{ ${command}; } < input 2>/dev/null | cat`)
      assert.ok(hidden.unsupported.some((note) => note.detail === detail), JSON.stringify(hidden))
      assert.equal(hidden.stderr, '')
    })
  }
  it('retains the unsupported marker when grep prepends an earlier error', () => {
    const r = createTerminal(FILES).run('grep -q x missing binary 2>/dev/null | cat')
    assert.ok(r.unsupported.length > 0)
    assert.equal(r.stderr, '')
  })
})
