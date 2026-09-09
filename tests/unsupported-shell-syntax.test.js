import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Independently expressed regressions informed by GNU Bash parse.y and Oils:
// https://github.com/oils-for-unix/oils/tree/f5bd5d9c8dfe625e73aa47f5ce7993060e70a2c1/spec
// alias.test.sh's LEFT='(' example requires alias expansion during parsing.
const terminal = (commands) => createTerminal({ 'a.cc': '', 'b.h': '' }, { commands })
const details = (result) => result.unsupported.map(({ kind, detail }) => [kind, detail])

function gap(line, detail) {
  const result = terminal().run(line)
  assert.deepEqual(details(result), [['feature', detail]], line)
  return result
}

describe('unsupported extended glob syntax', () => {
  for (const pattern of ['@(.cc|.h)', '!(*.h)', '+(a|b)', '?(a|b)', '*(a|b)', 'src/@(a|+(b|c)).h']) {
    for (const command of [
      `echo ${pattern}`,
      `for path in ${pattern}; do echo "$path"; done`,
      `cat < ${pattern}`,
      `echo ${pattern} 2>/dev/null | head`,
      `echo "$(echo ${pattern})" 2>/dev/null | head`,
    ]) {
      it(command, () => { gap(command, 'extglob') })
    }
  }

  it('recognizes line continuations without treating quoted fragments as glob operators', () => {
    gap('echo @\\\n(a|b)', 'extglob')
    gap('echo ""@(a|b)', 'extglob')
    gap('echo "prefix"@(a|b)', 'extglob')
    for (const command of [String.raw`echo \@(a|b)`, 'echo "@"(a|b)', 'echo @""(a|b)', 'echo @ (a|b)']) {
      const result = terminal().run(command)
      assert.equal(result.exitCode, 2, command)
      assert.deepEqual(result.unsupported, [], command)
    }
  })

  it('leaves quoted patterns, here-document text, and ordinary subshells alone', () => {
    for (const command of [
      `echo '@(a|b)'`, `echo "@(a|b)"`, String.raw`echo @\(a\|b\)`,
      `cat <<'END'\n@(a|b)\nEND`, `cat <<END\n@(a|b)\nEND`,
    ]) {
      const result = terminal().run(command)
      assert.equal(result.stdout, '@(a|b)\n', command)
      assert.equal(result.exitCode, 0, command)
      assert.deepEqual(result.unsupported, [], command)
    }
    assert.equal(terminal().run('! (false)').exitCode, 0)
    assert.equal(terminal().run('echo "$(echo ok)"').stdout, 'ok\n')
    assert.deepEqual(terminal().run('false && echo "$(echo @(a|b))"').unsupported, [])
  })
})

describe('unsupported compound array assignments', () => {
  for (const command of [
    'a=(one two)', 'a+=(one two)', 'prefix=x a=(one two)',
    'declare -A a=([k1]=foo)', 'declare -a x=()', 'declare -a -r x=(one two)',
    'typeset -a -r x=(one two)', 'readonly a=(1 2)', 'readonly -a a=(1 2)',
    'export a=(one two)', 'local -a a=(one two)', 'eval a=(one two)', 'let a=(one two)',
    'declare -a x=() y=(one)', 'declare -a x+=(one)', 'declare -- x=(one)',
    'declare -a x=\\\n(one two)',
  ]) {
    for (const line of [command, `${command} 2>/dev/null | head`]) {
      it(line, () => { gap(line, 'array assignment') })
    }
  }

  it('reports the array construct from an executed command substitution', () => {
    gap('echo "$(declare -A a=([key]=value))" 2>/dev/null | head', 'array assignment')
  })

  it('preserves ordinary invalid syntax and literal assignment text', () => {
    for (const command of ['echo a=(one two)', 'a= (one two)', 'a"="(one two)', 'a=""(one two)', '1a=(one two)']) {
      const result = terminal().run(command)
      assert.equal(result.exitCode, 2, command)
      assert.deepEqual(result.unsupported, [], command)
    }
    const result = terminal().run(`echo 'declare -A a=([k1]=foo)'`)
    assert.equal(result.stdout, 'declare -A a=([k1]=foo)\n')
    assert.deepEqual(result.unsupported, [])
    gap('typeset -a -r x', 'typeset')
  })
})

describe('alias expansion and whole-input parsing', () => {
  for (const command of [
    "shopt -s expand_aliases\nalias LEFT='('\nLEFT echo one; echo two )",
    "alias LEFT='('\nLEFT echo one ) 2>/dev/null | head",
    "alias RIGHT=')'\n( echo one; RIGHT",
    "alias 'LEFT=('\nLEFT echo one )",
    "alias LEFT='echo one; ('\nX=1 LEFT echo two )",
  ]) {
    it(command, () => { gap(command, 'alias expansion') })
  }

  it('keeps dispatch-time diagnostics and skipped commands for parseable alias invocations', () => {
    gap("alias LEFT='('", 'alias')
    assert.deepEqual(terminal().run("false && alias LEFT='('").unsupported, [])
    const result = terminal({ alias: ({ args }) => args.join(' ') }).run("alias LEFT='('")
    assert.equal(result.stdout, 'LEFT=(')
    assert.deepEqual(result.unsupported, [])
  })

  it('does not infer alias expansion from argument text or registered commands', () => {
    const command = "alias LEFT='('\nLEFT echo one )"
    const result = terminal({ alias: () => '' }).run(command)
    assert.equal(result.exitCode, 2)
    assert.deepEqual(result.unsupported, [])
    for (const line of ["echo alias LEFT='('\nLEFT echo one )", "alias LEFT='('\necho LEFT )", "alias LEFT='('\n'LEFT' echo one )"]) {
      const failed = terminal().run(line)
      assert.equal(failed.exitCode, 2, line)
      assert.deepEqual(failed.unsupported, [], line)
    }
  })

  it('does not retain aliases removed or declared in an isolated scope', () => {
    for (const line of [
      "(alias LEFT='(')\nLEFT echo one )",
      "alias LEFT='(' | cat\nLEFT echo one )",
      "echo input | alias LEFT='('\nLEFT echo one )",
      "alias LEFT='('\nunalias LEFT\nLEFT echo one )",
      "alias LEFT='('\nunalias -a\nLEFT echo one )",
    ]) {
      const failed = terminal().run(line)
      assert.equal(failed.exitCode, 2, line)
      assert.deepEqual(failed.unsupported, [], line)
    }
  })
})
