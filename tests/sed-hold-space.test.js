import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU execute.c line_copy/line_append/line_exchange move both text and the
// chomped flag. read_pattern_space resets only hold.length for separate files.
// https://github.com/mirror/sed/blob/v4.9/sed/execute.c
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'"
const result = (stdout = '') => ({ stdout, stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [] })
const run = (script, input, flags = '') => createTerminal({ input }).run(`sed ${flags} ${quote(script)} input`)

describe('sed hold commands copy, append, and exchange complete records', () => {
  const cases = [
    ['g', 'a\nb\n', '\n\n'],
    ['G', 'a\nb\n', 'a\n\nb\n\n'],
    ['h', 'a\nb\n', 'a\nb\n'],
    ['H', 'a\nb\n', 'a\nb\n'],
    ['x', 'a\nb\n', '\na\n'],
    ['x;x', 'a\nb\n', 'a\nb\n'],
    ['h;g', 'a\nb', 'a\nb'],
    ['h;s/a/A/;g', 'a\n', 'a\n'],
    ['h;G', 'a\n', 'a\na\n'],
    ['H;g', 'a\nb\n', '\na\n\na\nb\n'],
    ['g;H;g', 'a\n', '\n\n'],
    ['h;N;g', 'a\nb\n', 'a\n'],
    ['h;n;g', 'a\nb\n', 'a\na\n'],
    ['h;N;x', 'a\nb', 'a\n'],
    ['N;h;g;P', 'a\nb\n', 'a\na\nb\n'],
  ]
  for (const nul of [false, true]) {
    for (const [script, input, stdout] of cases) {
      it(`${nul ? '-z ' : ''}${script}`, () => {
        const convert = (text) => nul ? text.replaceAll('\n', '\0') : text
        assert.deepEqual(run(script, convert(input), nul ? '-z' : ''), result(convert(stdout)))
      })
    }
  }
  for (const kind of ['g', 'G', 'h', 'H', 'x']) {
    it(`${kind} does not write by itself under -n`, () => assert.deepEqual(run(kind, 'a\n', '-n'), result()))
    it(`${kind} does not create a cycle on empty input`, () => assert.deepEqual(run(kind, ''), result()))
  }
})

describe('sed hold buffers carry missing record terminators', () => {
  for (const [script, input, stdout] of [
    ['g', 'a', '\n'],
    ['G', 'a', 'a\n\n'],
    ['h;G', 'a', 'a\na'],
    ['H;g', 'a', '\na'],
    ['x', 'a', '\n'],
    ['x;x', 'a', 'a'],
    ['1h;2g', 'a\nb', 'a\na\n'],
    ['1h;2x', 'a\nb', 'a\na\n'],
    ['1h;2{H;g}', 'a\nb', 'a\na\nb'],
    ['1h;2G', 'a\nb', 'a\nb\na\n'],
    ['h;g;p', 'a', 'a\na'],
  ]) {
    it(script, () => assert.deepEqual(run(script, input), result(stdout)))
  }
  it('appends the NUL delimiter and copies a missing final NUL under -z', () => {
    assert.deepEqual(run('h;G', 'a', '-z'), result('a\0a'))
  })
})

describe('sed hold space participates in addressed blocks and branches', () => {
  for (const [script, flags, stdout] of [
    ['1!G;h;$!d', '', 'gamma\nbeta\nalpha\n'],
    ['1h;1!H;${g;s/\\n/ /g;p}', '-n', 'alpha beta gamma\n'],
    ['1{h;d};g;p', '-n', 'alpha\nalpha\n'],
    ['1h;2,3{g;s/^/saved:/}', '', 'alpha\nsaved:alpha\nsaved:alpha\n'],
    ['1h;1!G', '', 'alpha\nbeta\nalpha\ngamma\nalpha\n'],
    ['1{h;b end};g;:end', '', 'alpha\nalpha\nalpha\n'],
  ]) {
    it(script, () => assert.deepEqual(run(script, 'alpha\nbeta\ngamma\n', flags), result(stdout)))
  }
  for (const kind of ['g', 'G', 'h', 'H', 'x']) {
    it(`${kind} preserves a successful substitution for t`, () => {
      const script = `s/a/A/;${kind};t yes;s/.*/BAD/;b;:yes;s/.*/GOOD/`
      assert.deepEqual(run(script, 'a\n'), result('GOOD\n'))
    })
    it(`${kind} does not create a successful substitution for T`, () => {
      const script = `${kind};T yes;s/.*/BAD/;b;:yes;s/.*/GOOD/`
      assert.deepEqual(run(script, 'a\n'), result('GOOD\n'))
    })
  }
  it('loading held text keeps the successful-substitution flag despite undoing its text', () => {
    assert.deepEqual(run('h;s/a/A/;g;t yes;s/.*/BAD/;:yes', 'a\n'), result('a\n'))
  })
})

describe('sed hold state is local to one invocation and respects separate files', () => {
  const files = { first: 'a\n', empty: '', second: 'b\n' }
  it('retains held text across ordinary file operands', () => {
    assert.deepEqual(createTerminal(files).run("sed '1h;2g' first empty second"), result('a\na\n'))
  })
  it('clears hold contents before each separate file', () => {
    assert.deepEqual(createTerminal(files).run("sed -s '1x' first empty second"), result('\n\n'))
  })
  it('retains only the hold terminator when separate files reset its length', () => {
    const t = createTerminal({ first: 'one', second: 'two\n' })
    assert.deepEqual(t.run("sed -sn '/one/h;/two/{g;s/^/X/;p}' first second"), result('X'))
  })
  it('resets hold contents when files are edited in place', () => {
    const t = createTerminal({}, { mount: '/src/', writable: '/tmp/' })
    t.run("printf 'a\\n' >/tmp/first; printf 'b\\n' >/tmp/second")
    assert.deepEqual(t.run("sed -i '1x' /tmp/first /tmp/second"), result())
    assert.deepEqual(t.run('cat /tmp/first /tmp/second'), result('\n\n'))
  })
  it('preserves the hold terminator across separate in-place executions', () => {
    const t = createTerminal({}, { mount: '/src/', writable: '/tmp/' })
    t.run("printf one >/tmp/first; printf 'two\\n' >/tmp/second")
    assert.deepEqual(t.run("sed -i '/one/h;/two/{g;s/^/X/}' /tmp/first /tmp/second"), result())
    assert.deepEqual(t.run('cat /tmp/first /tmp/second'), result('oneX'))
  })
  it('starts with fresh hold contents and terminator in the next invocation', () => {
    const t = createTerminal({ input: 'a' })
    assert.deepEqual(t.run('sed h input'), result('a'))
    assert.deepEqual(t.run('sed g input'), result('\n'))
  })
})

describe('sed limits both pattern and hold space with unsuppressible diagnostics', () => {
  for (const [script, detail] of [['h;:again;H;b again', 'hold space limit'], ['h;:again;G;h;b again', 'pattern space limit']]) {
    it(detail, () => {
      const t = createTerminal({ input: 'x'.repeat(1024 * 1024) + '\n' })
      const actual = t.run(`sed -n ${quote(script)} input 2>/dev/null | cat`)
      assert.equal(actual.stdout, '')
      assert.equal(actual.stderr, '')
      assert.equal(actual.exitCode, 0)
      assert.deepEqual(actual.unsupported.map((note) => [note.command, note.detail]), [['sed', detail]])
    })
  }
})
