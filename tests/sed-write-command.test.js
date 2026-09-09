import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU sed 4.9 compile.c read_filename/get_openfile and execute.c w/output_line.
// https://github.com/mirror/sed/blob/v4.9/sed/compile.c
// https://github.com/mirror/sed/blob/v4.9/sed/execute.c
const FILES = {
  input: 'a\nb\nc\n', single: 'a\n', empty: '', unterminated: 'a', nul: 'a\0b\0c',
  'scripts/first': 'w out\ns/a/A/w out\n', 'scripts/second': 'w out\n',
}
const terminal = () => createTerminal(FILES, { mount: '/repo/', cwd: '/tmp', writable: '/tmp/' })
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'"
const command = (script, input = '/repo/input', flags = '') => `sed ${flags} ${quote(script)} ${input}`
const expected = (stdout = '', exitCode = 0, stderr = '') => ({ stdout, stderr, exitCode, cwd: '/tmp', unsupported: [] })
const check = (t, text, stdout = '', exitCode = 0, stderr = '') => assert.deepEqual(t.run(text), expected(stdout, exitCode, stderr), text)
const written = (t, name, content) => check(t, `cat ${quote(name)}`, content)

describe('sed standalone w selects the current pattern space', () => {
  for (const [script, stdout, output] of [
    ['w out', FILES.input, FILES.input],
    ['2w out', FILES.input, 'b\n'],
    ['2,3w out', FILES.input, 'b\nc\n'],
    ['/b/w out', FILES.input, 'b\n'],
    ['1,2!w out', FILES.input, 'c\n'],
    ['2{\nw out\n}', FILES.input, 'b\n'],
    ['2!{\nw out\n}', FILES.input, 'a\nc\n'],
    ['1d\nw out', 'b\nc\n', 'b\nc\n'],
    ['2q\nw out', 'a\nb\n', 'a\n'],
    ['/absent/w out', FILES.input, ''],
    ['s/a/A/\nw out\ns/A/Z/', 'Z\nb\nc\n', 'A\nb\nc\n'],
  ]) {
    it(script, () => {
      const t = terminal()
      check(t, command(script), stdout)
      written(t, 'out', output)
    })
  }

  it('writes with automatic output disabled', () => {
    const t = terminal()
    check(t, command('w out', '/repo/input', '-n'))
    written(t, 'out', FILES.input)
  })

  it('treats cp as c with replacement text p', () => {
    const t = terminal()
    check(t, command('cp'), 'p\np\np\n')
    check(t, command('1,2cp', '/repo/input', '-n'), 'p\n')
  })
})

describe('sed standalone w filename parsing and compilation effects', () => {
  for (const [script, name] of [
    ['wout', 'out'], ['w \t out', 'out'], ['w out; p', 'out; p'],
    ['w out#comment', 'out#comment'], ['w out}', 'out}'], ['w out  ', 'out  '],
    ['w out\r\n', 'out\r'], [String.raw`w out\ name`, String.raw`out\ name`],
  ]) {
    it(`retains literal filename ${JSON.stringify(name)}`, () => {
      const t = terminal()
      check(t, command(script, '/repo/single', '-n'))
      written(t, name, 'a\n')
    })
  }

  it('ends the filename at a physical newline', () => {
    const t = terminal()
    check(t, command('w out\np', '/repo/single', '-n'), 'a\n')
    written(t, 'out', 'a\n')
  })

  for (const [script, input, stdout] of [
    ['w out', '/repo/empty', ''], ['20w out', '/repo/single', 'a\n'],
    ['20{\nw out\n}', '/repo/single', 'a\n'], ['q\nw out', '/repo/single', 'a\n'],
  ]) {
    it(`opens the target even without a selected write: ${script}`, () => {
      const t = terminal()
      check(t, 'printf old >out')
      check(t, command(script, input), stdout)
      written(t, 'out', '')
    })
  }

  it('creates the target before an input-open error', () => {
    const t = terminal()
    check(t, command('w out', 'missing'), '', 2, 'sed: missing: no such file or directory\n')
    written(t, 'out', '')
  })

  for (const script of ['w out\n?', '{w out}']) {
    it(`retains earlier opens after a later syntax error: ${script}`, () => {
      const t = terminal()
      const name = script === '{w out}' ? 'out}' : 'out'
      check(t, `printf old >${quote(name)}`)
      const result = t.run(command(script))
      assert.equal(result.stdout, '')
      assert.equal(result.exitCode, 1)
      assert.notEqual(result.stderr, '')
      assert.deepEqual(result.unsupported, [])
      written(t, name, '')
    })
  }

  for (const script of ['w', 'w \t', 'w\nw out']) {
    it(`stops at a missing filename: ${JSON.stringify(script)}`, () => {
      const t = terminal()
      check(t, 'printf old >out')
      const result = t.run(command(script, '/repo/empty'))
      assert.equal(result.exitCode, 1)
      assert.match(result.stderr, /filename/u)
      assert.deepEqual(result.unsupported, [])
      written(t, 'out', 'old')
    })
  }

  it('does not open later targets after the first output-open failure', () => {
    const t = terminal()
    check(t, 'printf old >out')
    const result = t.run(command('w /tmp/missing/out\nw out', '/repo/empty'))
    assert.equal(result.exitCode, 4)
    assert.deepEqual(result.unsupported, [])
    written(t, 'out', 'old')
  })

  it('retains prior truncation and unsupported metadata for a later unimplemented command', () => {
    const t = terminal()
    check(t, 'printf old >out')
    const result = t.run(command('w out\ne') + ' 2>/dev/null | cat')
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.ok(result.unsupported.length > 0)
    written(t, 'out', '')
  })

  it('reports read-only output targets before processing empty input', () => {
    const t = terminal()
    const result = t.run(command('w /repo/single', '/repo/empty') + ' 2>/dev/null | cat')
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.unsupported.map(({ detail }) => detail), ['output file'])
    written(t, '/repo/single', 'a\n')
  })
})

describe('standalone w and substitution w share cached output descriptors', () => {
  it('retains command order across separate expressions', () => {
    const t = terminal()
    check(t, "sed -n -e 'w out' -e 's/a/A/w out' -e 'w out' /repo/single")
    written(t, 'out', 'a\nA\nA\n')
  })

  it('retains command order across expression and script-file options', () => {
    const t = terminal()
    check(t, "sed -n -e 'w out' -f /repo/scripts/first -f /repo/scripts/second /repo/single")
    written(t, 'out', 'a\na\nA\nA\n')
  })

  it('keeps independent offsets for different spellings of the same path', () => {
    const t = terminal()
    check(t, "sed -n -e 'w out' -e 's/a/A/w ./out' /repo/single")
    written(t, 'out', 'A\n')
  })

  it('truncates a file before loading it as a later script', () => {
    const t = terminal()
    check(t, "printf 's/a/A/\\n' >script")
    check(t, "sed -e 'w script' -f script /repo/single", 'a\n')
    written(t, 'script', 'a\n')
  })

  it('truncates named and redirected input before the first input read', () => {
    for (const operand of ['out', '<out']) {
      const t = terminal()
      check(t, 'cat /repo/single >out')
      check(t, command('w out', operand))
      written(t, 'out', '')
    }
  })
})

describe('sed standalone w record terminators and standard streams', () => {
  for (const [input, flags, output] of [
    ['/repo/unterminated', '-n', 'a'],
    ['/repo/unterminated /repo/unterminated', '-n', 'a\na'],
    ['/repo/nul', '-zn', 'a\0b\0c'],
    ['/repo/nul /repo/unterminated', '-zn', 'a\0b\0c\0a'],
  ]) {
    it(`${flags} ${input}`, () => {
      const t = terminal()
      check(t, command('w out', input, flags))
      written(t, 'out', output)
    })
  }

  it('shares missing-terminator state with substitution writes', () => {
    const t = terminal()
    check(t, "sed -zn -e 'w out' -e 's/a/A/w out' /repo/unterminated")
    written(t, 'out', 'a\0A')
  })

  for (const [script, input, flags, stdout, stderr] of [
    ['w /dev/null', '/repo/single', '-n', '', ''],
    ['w /dev/stdout', '/repo/single', '-n', 'a\n', ''],
    ['w /dev/stdout', '/repo/single', '', 'a\na\n', ''],
    ['w /dev/stderr', '/repo/single', '', 'a\n', 'a\n'],
    ['w /dev/stdout', '/repo/unterminated', '', 'aa', ''],
    ['w /dev/stdout', '/repo/unterminated /repo/unterminated', '', 'aa\na\na', ''],
    ['w /dev/stderr', '/repo/nul', '-zn', '', 'a\0b\0c'],
  ]) {
    it(`${script} ${flags} ${input}`, () => check(terminal(), command(script, input, flags), stdout, 0, stderr))
  }

  it('writes to the inherited stdout descriptor without reopening it', () => {
    const t = terminal()
    check(t, 'printf before >out')
    check(t, command('w /dev/stdout', '/repo/single', '-n') + ' >>out')
    written(t, 'out', 'beforea\n')
  })
})

describe('sed standalone w with in-place editing and delegated execution', () => {
  it('writes explicitly to stdout while in-place editing captures normal output', () => {
    const t = terminal()
    check(t, 'cat /repo/single >work')
    check(t, command('w /dev/stdout\ns/a/A/', 'work', '-i'), 'a\n')
    written(t, 'work', 'A\n')
  })

  it('writes selected lines to a separate file under quiet in-place editing', () => {
    const t = terminal()
    check(t, 'cat /repo/input >work')
    check(t, command('2w out', 'work', '-ni'))
    written(t, 'out', 'b\n')
    written(t, 'work', '')
  })

  it('keeps self-output detection through nested xargs dispatch', () => {
    const t = terminal()
    const result = t.run("printf '/repo/single out' | xargs xargs sed -n 'w out' 2>/dev/null")
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 123)
    assert.ok(result.unsupported.some(({ detail }) => detail === 'streaming self-output'))
    written(t, 'out', 'a\n')
  })
})
