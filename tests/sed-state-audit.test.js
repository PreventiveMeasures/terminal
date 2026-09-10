import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU execute.c keeps range state, the current input line and substitution
// state through D. Hold buffers and each output stream retain terminators.
// https://github.com/mirror/sed/blob/v4.9/sed/execute.c
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'"
const result = (stdout = '') => ({ stdout, stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [] })
const run = (script, input, flags = '-n') => createTerminal({ input }).run(`sed ${flags} ${quote(script)} input`)

describe('sed restart state survives addressed blocks and held pattern spaces', () => {
  for (const [purpose, script, input, stdout] of [
    ['a closed numeric range stays closed on the same input line',
      '1N;2,2{s/^/range:/;P;D};p', 'a\nb\nc\n', 'range:a\nb\nc\n'],
    ['an active regex range checks its end after a D restart',
      '/^a/N;/a/,/b/{s/^/R/;P;D};p', 'a\nb\nc\n', 'Ra\nRb\nc\n'],
    ['an initially active zero range stays closed after matching its end',
      '1N;0,/b/{s/^/R/;P;D};p', 'a\nb\nc\n', 'Ra\nb\nc\n'],
    ['the last evaluated regex remains usable after held text is restored',
      '/^a/{N;h;D};g;s//X/;p', 'a\nb\n', 'X\nb\n'],
    ['a branch into a block can bypass its address without resetting hold',
      '1h;b inside;99{:inside;g;p}', 'a\nb\n', 'a\na\n'],
    ['hold survives a skipped cycle and a later read followed by restart',
      '1{h;d};/^b/{H;N;D};g;p', 'a\nb\nc\n', 'a\nb\n'],
    ['a read after restart updates the last-record address',
      'N;/^a/D;$p;p', 'a\nb\nc\n', 'b\nc\nb\nc\n'],
  ]) {
    it(purpose, () => assert.deepEqual(run(script, input), result(stdout)))
  }
  it('preserves Unicode and embedded NUL bytes through copies and exchanges', () => {
    const input = 'é😀\0z\n'
    assert.deepEqual(run('h;G;x;G;p', input), result(input.slice(0, -1) + '\n' + input.slice(0, -1) + '\n' + input))
  })
})

describe('sed terminator metadata survives empty held text and output aliases', () => {
  it('an empty held unterminated record separates the following printed record', () => {
    const t = createTerminal({ first: 'one', second: 'two\nthree\n' })
    assert.deepEqual(t.run("sed -sn '/one/h;/two/{g;p};/three/p' first second"), result('\nthree\n'))
  })
  it('retains the same empty-record behavior under NUL separation', () => {
    const t = createTerminal({ first: 'one', second: 'two\0three\0' })
    assert.deepEqual(t.run("sed -zsn '/one/h;/two/{g;p};/three/p' first second"), result('\0three\0'))
  })
  for (const [flags, stdout] of [['', 'aa\n'], ['-n', 'a']]) {
    it(`q flushes only automatic output's missing terminator with ${flags || 'default output'}`, () => {
      assert.deepEqual(run('h;g;w /dev/stdout\nq', 'a', flags), result(stdout))
    })
  }
})

describe('sed writes do not change restart or substitution state', () => {
  const writable = () => createTerminal({ input: 'a\nb' }, { mount: '/src/', writable: '/tmp/' })
  it('writing a substituted pattern does not clear t after restoring held text', () => {
    const t = writable()
    const script = 'h;s/a/A/;w /tmp/out\ng;t yes;s/.*/BAD/;b;:yes;p;q'
    assert.deepEqual(t.run(`sed -n ${quote(script)} /src/input`), result('a\n'))
    assert.deepEqual(t.run('cat /tmp/out'), result('A\n'))
  })
  it('writes a range only once when D revisits its numeric start line', () => {
    const t = writable()
    const script = '1N;2,2{w /tmp/out\nD};p'
    assert.deepEqual(t.run(`sed -n ${quote(script)} /src/input`), result('b'))
    assert.deepEqual(t.run('cat /tmp/out'), result('a\nb'))
  })
})
