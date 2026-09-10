import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const files = { 'X=one': '', 'X=two': '', 'X=alpha-end': '', 'X=beta-end': '' }
const success = (stdout) => ({ stdout, stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [] })

// Bash execute_cmd.c fix_assignment_words recognizes the original command
// spelling, before substitutions and quote removal can produce its name.
describe('declaration arguments use the original command syntax', () => {
  for (const command of [
    '$cmd', '$(printf export)', '${cmd}', '${missing:-export}',
    '"export"', "'export'", 'ex"port"', '\\export', 'export""', "$'export'",
  ]) {
    it(`splits an unquoted assignment argument of ${command}`, () => {
      const result = createTerminal({}).run(`cmd=export; value='a b'; ${command} X=$value; printf '<%s>' "$X"`)
      assert.deepEqual(result, success('<a>'))
    })
  }

  for (const command of ['export', 'ex\\\nport']) {
    it(`retains assignment expansion for ${JSON.stringify(command)}`, () => {
      const result = createTerminal({}).run(`value='a b'; ${command} X=$value; printf '<%s>' "$X"`)
      assert.deepEqual(result, success('<a b>'))
    })
  }

  for (const [command, stdout] of [
    ['cmd=export; $cmd X=t*; printf "%s" "$X"', 'two'],
    ['export X=t*; printf "%s" "$X"', 't*'],
    ['cmd=export; $cmd X="a b"; printf "%s" "$X"', 'a b'],
    ['unset missing; ${missing-} export X=${value:-a b}; printf "%s" "$X"', 'a'],
    ['cmd=export; $cmd X=${value:=a b}; printf "<%s><%s>" "$X" "$value"', '<a><a b>'],
    ['export X=${value:=a b}; printf "<%s><%s>" "$X" "$value"', '<a b><a b>'],
  ]) {
    it(command, () => {
      assert.deepEqual(createTerminal(files).run(command), success(stdout))
    })
  }
})

// subst.c brace_expand_word_list restores only ordinary word flags after
// changing a word, so even an original assignment loses NOSPLIT/NOGLOB.
describe('brace expansion removes declaration assignment flags', () => {
  for (const [command, stdout] of [
    ['value="a b"; export {X,Y}=$value; printf "<%s><%s>" "$X" "$Y"', '<a><a>'],
    ['value="b c"; export X={a,b}$value; printf "%s" "$X"', 'bb'],
    ['export X={alpha,beta}*; printf "%s" "$X"', 'beta-end'],
    ['export X={unmatched}; printf "%s" "$X"', '{unmatched}'],
    ['value="a b"; export X={unmatched}$value; printf "%s" "$X"', '{unmatched}a b'],
    ['value="a b"; export X="{one,two}"$value; printf "%s" "$X"', '{one,two}a b'],
    ['value="a b"; export X={one,two}"$value"; printf "%s" "$X"', 'twoa b'],
    ['n=0; export X={a,b}$((n++)); printf "<%s><%s>" "$X" "$n"', '<b1><2>'],
    ['export X={a,b}${value:=c d}; printf "<%s><%s>" "$X" "$value"', '<bc><c d>'],
    ['export X={one,two}:~; printf "%s" "$X"', 'two:~'],
    ['export {X,Y}=~; printf "<%s><%s>" "$X" "$Y"', '<~><~>'],
    ['export X={unmatched}:~; printf "%s" "$X"', '{unmatched}:/'],
    ['echo X={one,two}:~', 'X=one:~ X=two:~\n'],
    ['echo ~/{one,two}', '/one /two\n'],
  ]) {
    it(command, () => {
      assert.deepEqual(createTerminal(files).run(command), success(stdout))
    })
  }

  it('uses the same brace and tilde order for a single redirect target', () => {
    const t = createTerminal({}, { mount: '/src', writable: '/tmp/' })
    const actual = t.run('cd /tmp; printf kept >X={1..1}:~; cat "X=1:~"')
    assert.deepEqual(actual, { ...success('kept'), cwd: '/tmp' })
  })
})
