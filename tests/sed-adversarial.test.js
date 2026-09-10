import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU compile.c rejects unmatched closing braces while compiling, before
// later w opens. execute.c reports input errors before opening later files.
// https://github.com/mirror/sed/blob/v4.9/sed/compile.c
// https://github.com/mirror/sed/blob/v4.9/sed/execute.c
const result = (stdout = '', exitCode = 0, stderr = '', cwd = '/') => ({ stdout, stderr, exitCode, cwd, notes: [], unsupported: [] })
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'"
const terminal = () => createTerminal({ input: 'a\nb\n', single: 'a\n' }, { mount: '/src/', writable: '/tmp/' })
const diagnostic = 'sed: /tmp/missing: no such file or directory\n'

describe('sed in-place input failures happen before later file reads', () => {
  it('retains stderr when its file is a later edited operand', () => {
    const t = terminal()
    assert.deepEqual(t.run("sed -i '' /tmp/missing /tmp/errors 2>/tmp/errors"), result('', 2))
    assert.deepEqual(t.run('cat /tmp/errors'), result(diagnostic))
  })
  it('backs up the diagnostic and transforms the later input', () => {
    const t = terminal()
    assert.deepEqual(t.run("sed -i.bak s/sed:/SEEN:/ /tmp/missing /tmp/errors 2>/tmp/errors"), result('', 2))
    assert.deepEqual(t.run('cat /tmp/errors /tmp/errors.bak'), result(diagnostic.replace('sed:', 'SEEN:') + diagnostic))
  })
  it('writes a second missing-input error to the backup inode after replacement', () => {
    const t = terminal()
    assert.deepEqual(t.run("sed -i.bak s/sed:/SEEN:/ /tmp/missing /tmp/errors /tmp/missing 2>/tmp/errors"), result('', 2))
    assert.deepEqual(t.run('cat /tmp/errors /tmp/errors.bak'), result(diagnostic.replace('sed:', 'SEEN:') + diagnostic.repeat(2)))
  })
  it('keeps error status when a later transformed input quits successfully', () => {
    const t = terminal()
    assert.deepEqual(t.run("sed -i.bak q /tmp/missing /tmp/errors 2>/tmp/errors"), result('', 2))
    assert.deepEqual(t.run('cat /tmp/errors /tmp/errors.bak'), result(diagnostic.repeat(2)))
  })
  it('preserves mixed diagnostic and explicit output ordering', () => {
    const t = terminal()
    t.run('cat /src/input >/tmp/input')
    const script = 's/a/A/w /dev/stdout'
    assert.deepEqual(t.run(`sed -i ${quote(script)} /tmp/missing /tmp/input 2>&1`), result(diagnostic + 'A\n', 2))
    assert.deepEqual(t.run('cat /tmp/input'), result('A\nb\n'))
  })
})

describe('sed compile-time failures cannot truncate later write targets', () => {
  for (const scripts of [
    "-e '}' -e 's/a/A/w /tmp/out'",
    "-e '{};}' -e 's/a/A/w /tmp/out'",
    "-e '1};s/a/A/w /tmp/out'",
    `-e ${quote('};s/a/A/w /tmp/out')}`,
  ]) {
    it(scripts, () => {
      const t = terminal()
      t.run('printf KEEP >/tmp/out')
      const actual = t.run(`sed ${scripts} /src/input`)
      assert.equal(actual.exitCode, 1)
      assert.equal(actual.stdout, '')
      assert.deepEqual(actual.unsupported, [])
      assert.match(actual.stderr, /unexpected '\}'/u)
      assert.deepEqual(t.run('cat /tmp/out'), result('KEEP'))
    })
  }
  it('keeps earlier write-open side effects before a closing-brace error', () => {
    const t = terminal()
    t.run('printf OLD >/tmp/first; printf KEEP >/tmp/later')
    const actual = t.run("sed -e 's/a/A/w /tmp/first' -e '}' -e 's/a/A/w /tmp/later' /src/input")
    assert.equal(actual.exitCode, 1)
    assert.deepEqual(actual.unsupported, [])
    assert.deepEqual(t.run('cat /tmp/first /tmp/later'), result('KEEP'))
  })
  it('allows blocks to continue across sources while linking branch labels', () => {
    const t = terminal()
    assert.deepEqual(t.run("sed -e '1{' -e 's/a/A/;b end' -e '};:end' /src/input"), result('A\nb\n'))
  })
  it('detects an unmatched opening brace after all compile-time write opens', () => {
    const t = terminal()
    t.run('printf KEEP >/tmp/out')
    const actual = t.run("sed -e '{' -e 's/a/A/w /tmp/out' /src/input")
    assert.equal(actual.exitCode, 1)
    assert.deepEqual(actual.unsupported, [])
    assert.match(actual.stderr, /unmatched/u)
    assert.deepEqual(t.run('cat /tmp/out'), result())
  })
})

describe('sed quit integer conversions retain the actual low-byte status', () => {
  // int_arg is signed int; -1 is the default-status sentinel. The process
  // exit status keeps the low eight bits of every other converted value.
  for (const [number, status] of [
    ['2147483647', 255], ['2147483648', 0], ['2147483649', 1],
    ['4294967294', 254], ['4294967295', 0], ['4294967296', 0], ['4294967297', 1],
    ['18446744073709551615', 0], ['18446744073709551616', 0], ['18446744073709551617', 1],
  ]) {
    it(number, () => {
      assert.deepEqual(terminal().run(`sed q${number} /src/input`), result('a\n', status))
    })
  }
  it('applies the same conversion to in-place quit before leaving later files untouched', () => {
    const t = terminal()
    t.run('cat /src/input >/tmp/first; cat /src/input >/tmp/second')
    assert.deepEqual(t.run('sed -i q2147483649 /tmp/first /tmp/second'), result('', 1))
    assert.deepEqual(t.run('cat /tmp/first /tmp/second'), result('a\na\nb\n'))
  })
})

describe('sed refuses input mutation exposed by last-line lookahead', () => {
  for (const leading of ['$p;', '$!p;', 'N;']) {
    it(leading, () => {
      const t = terminal()
      const script = leading + 's/a/A/w /tmp/later'
      const actual = t.run(`sed -n ${quote(script)} /src/single /tmp/later 2>/dev/null | cat`)
      assert.equal(actual.exitCode, 0)
      assert.equal(actual.stderr, '')
      if (leading === 'N;') {
        assert.deepEqual(actual.unsupported, [])
        assert.equal(actual.stdout, '')
      } else {
        assert.deepEqual(actual.unsupported.map(({ detail }) => detail), ['streaming self-output'])
      }
      assert.deepEqual(t.run('cat /tmp/later'), result())
    })
  }
})
