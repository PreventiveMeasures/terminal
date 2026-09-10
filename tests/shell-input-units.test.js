import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { parseLine } from '../src/shell/parse.js'

const terminal = () => createTerminal({ 'dir/file': 'contents\n' }, { mount: '/src', writable: '/tmp/' })

// Bash parse.y accepts a complete inputunit at newline/EOF; eval.c executes it
// before asking the parser for another. Semicolons remain within that unit.
describe('complete shell input units run before later parse failures', () => {
  for (const failure of ['echo )', 'echo "', 'echo `unterminated', 'echo @(bad)', 'echo ${!value}']) {
    it(`retains prior unsupported diagnostics before ${failure}`, () => {
      const result = terminal().run(`set -o errexit\necho before\n${failure}`)
      assert.equal(result.stdout, 'before\n')
      assert.notEqual(result.exitCode, 0)
      assert.ok(result.unsupported.some((note) => note.command === 'set'))
      assert.ok(result.stderr.startsWith('set:'))
    })
  }

  it('preserves completed variable, directory and file changes', () => {
    const t = terminal()
    const result = t.run('value=kept\ncd /src/dir\nprintf written >/tmp/file\necho )')
    assert.equal(result.exitCode, 2)
    assert.equal(result.cwd, '/src/dir')
    assert.equal(t.run('printf "%s:" "$value"; cat /tmp/file').stdout, 'kept:written')
  })

  for (const command of [
    'set -o errexit; echo )',
    'set -o errexit &&\necho )',
    'set -o errexit |\necho )',
    '{ set -o errexit\necho )\n}',
    '(set -o errexit\necho ;;\n)',
    'if true; then\nset -o errexit\necho )\nfi',
    'for f in a; do\nset -o errexit\necho )\ndone',
  ]) {
    it(`does not execute an incomplete or invalid unit: ${command}`, () => {
      const result = terminal().run(command)
      assert.equal(result.stdout, '')
      assert.equal(result.exitCode, 2)
      assert.deepEqual(result.unsupported, [])
    })
  }

  it('does not diagnose runtime commands in skipped branches', () => {
    const result = terminal().run('false && set -o errexit\nif false; then set -u; fi\necho )')
    assert.equal(result.exitCode, 2)
    assert.deepEqual(result.unsupported, [])
  })

  for (const suffix of ['echo "', 'echo )', 'echo `unterminated', 'echo ${value:1}', 'echo $(echo ))']) {
    it(`does not read after exit: ${suffix}`, () => {
      const result = terminal().run('echo before\nexit 7\n' + suffix)
      assert.equal(result.stdout, 'before\n')
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 7)
      assert.deepEqual(result.unsupported, [])
    })
  }

  it('still validates the complete semicolon list before exit', () => {
    const result = terminal().run('exit 7; echo )')
    assert.equal(result.exitCode, 2)
  })
})

describe('input boundaries follow grammar and lexical state', () => {
  for (const [command, stdout] of [
    ['echo one &&\necho two\n', 'one\ntwo\n'],
    ['false ||\necho fallback', 'fallback\n'],
    ['printf "one\\ntwo\\n" |\nhead -1', 'one\n'],
    ['echo "one\ntwo"\necho three', 'one\ntwo\nthree\n'],
    ['echo one\\\ntwo\necho three', 'onetwo\nthree\n'],
    ['{ echo one\necho two; }\necho three', 'one\ntwo\nthree\n'],
    ['(echo one\necho two)\necho three', 'one\ntwo\nthree\n'],
    ['if false\nthen\necho skipped\nelse\necho kept\nfi', 'kept\n'],
    ['for f\nin a do done if then fi\ndo\necho "$f"\ndone', 'a\ndo\ndone\nif\nthen\nfi\n'],
    ['for f in a do\ndo echo "$f"\ndone', 'a\ndo\n'],
    ['cat <<EOF\nset -o errexit\necho )\nEOF\necho after', 'set -o errexit\necho )\nafter\n'],
    ['printf "%s" "$(echo one\necho two)"\necho three', 'one\ntwothree\n'],
    ['echo before; # a comment\n# another\necho after', 'before\nafter\n'],
  ]) {
    it(command, () => {
      const result = terminal().run(command)
      assert.equal(result.stdout, stdout)
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
      assert.deepEqual(result.unsupported, [])
    })
  }

  it('blank and comment-only units preserve the prior status', () => {
    assert.equal(terminal().run('false\n\n# comment\n').exitCode, 1)
  })

  it('checks active substitution syntax even in a skipped command', () => {
    const result = terminal().run('echo before\nfalse && echo $(echo ;)\necho after')
    assert.equal(result.stdout, 'before\nafter\n')
    assert.equal(result.stderr, '')
    assert.deepEqual(result.unsupported, [])
    const malformed = terminal().run('echo before\nfalse && echo $(echo ;;)\necho after')
    assert.equal(malformed.stdout, 'before\n')
    assert.equal(malformed.exitCode, 2)
    assert.deepEqual(malformed.unsupported, [])
  })

  it('syntax validation does not mistake descriptor failures for invalid grammar', () => {
    assert.doesNotThrow(() => parseLine('echo $(echo hi >&3)'))
    assert.doesNotThrow(() => parseLine('echo $(cat 2</missing)'))
    assert.doesNotThrow(() => parseLine('echo $(printf hi >/readonly)'))
  })
})

describe('malformed input boundaries never run a partial unit', () => {
  for (const command of [
    ';',
    'printf changed >/tmp/sentinel; ;',
    'printf changed >/tmp/sentinel &&;',
    'printf changed >/tmp/sentinel |;',
    'printf changed >/tmp/sentinel &&\n# no operand',
    'printf changed >\n/tmp/sentinel',
    'for f; in a; do printf changed >/tmp/sentinel; done',
    'for f;\nin a; do printf changed >/tmp/sentinel; done',
    'if true; then printf changed >/tmp/sentinel; else ; fi',
    'for f in a; do printf changed >/tmp/sentinel; done ||',
  ]) {
    it(command, () => {
      const t = terminal()
      t.run('printf keep >/tmp/sentinel')
      const result = t.run('echo before\n' + command)
      assert.equal(result.stdout, 'before\n')
      assert.equal(result.exitCode, 2)
      assert.deepEqual(result.unsupported, [])
      assert.equal(t.run('cat /tmp/sentinel').stdout, 'keep')
    })
  }

  for (const [command, stdout] of [
    ['echo before # comment at EOF', 'before\n'],
    ['for f\nin a\ndo echo "$f"\ndone\necho after', 'a\nafter\n'],
    ['cat <<A <<B\nfirst\nA\nsecond\nB\necho after', 'second\nafter\n'],
    ['{ cat\ncat\n} <<EOF\nfirst\nsecond\nEOF\necho after', 'first\nsecond\nafter\n'],
    ['cat <<EOF &&\nfirst\nEOF\necho after', 'first\nafter\n'],
    ['cat <<EOF; echo same\nfirst\nEOF\necho next', 'first\nsame\nnext\n'],
  ]) {
    it(command, () => {
      const result = terminal().run(command)
      assert.equal(result.stdout, stdout)
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
      assert.deepEqual(result.unsupported, [])
    })
  }
})
