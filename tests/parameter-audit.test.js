import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { parseParameter } from '../src/shell/parameter.js'
import { unsupportedNote } from '../src/unsupported.js'

describe('parameter names require a complete identifier', () => {
  for (const ending of ['\n', '\r', '\u2028', '\u2029']) {
    it(`rejects trailing ${JSON.stringify(ending)} in a length expression`, () => {
      assert.throws(() => parseParameter('#x' + ending), (error) => unsupportedNote(error)?.detail === '${')
      const result = createTerminal({}).run('echo "${#x' + ending + '}"')
      assert.equal(result.stdout, '')
      assert.notEqual(result.exitCode, 0)
      assert.equal(result.unsupported[0]?.detail, '${')
    })
  }

  it('continues to accept an escaped newline at the end of the name', () => {
    const result = createTerminal({}).run('x=abc; echo "${#x\\\n}"')
    assert.equal(result.stdout, '3\n')
    assert.equal(result.stderr, '')
    assert.deepEqual(result.unsupported, [])
  })
})

// Bash's pathexp.c quotes the class opener, while lib/glob/sm_loop.c
// dequotes character-class names before class lookup. Unknown names match
// nothing; they do not turn into an ordinary bracket expression.
describe('parameter patterns preserve POSIX class syntax and quotes', () => {
  for (const [command, stdout] of [
    ["x=1a; printf '%s' \"${x#[[':'digit:]]}\"","1a"],
    ["x=1a; printf '%s' \"${x#[[:'digit':]]}\"","a"],
    ["x=1a; printf '%s' \"${x#[[:digit':']]}\"","a"],
    ["x=1a; p='[[:di\\git:]]'; printf '%s' \"${x#$p}\"","a"],
    ["x='B]rest'; printf '%s' \"${x#[[:BOGUS:]]}\"","B]rest"],
    ["x=abc; printf '%s' \"${x#[[:BOGUS:]a]}\"","bc"],
    ["x=Za; printf '%s' \"${x#[[:ascii:]]}\"","a"],
    ["x='a]tail'; printf '%s' \"${x#[['.'a'.']]}\"","tail"],
    ["x='a]tail'; printf '%s' \"${x#[['='a'=']]}\"","tail"],
    ["x='d]tail'; printf '%s' \"${x#[[':'digit:]]}\"","tail"],
    ["x=abc; p='[[:di\\git:]]'; printf '%s' \"${x#${p}}\"","abc"],
  ]) {
    it(command, () => {
      const result = createTerminal({}).run(command)
      assert.equal(result.stdout, stdout)
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
      assert.deepEqual(result.unsupported, [])
    })
  }
})

describe('parameter evaluation in heredocs and shell state', () => {
  for (const [command, stdout] of [
    ["cat <<EOF\n${x:-\"a b\"}\nEOF","a b\n"],
    ["cat <<EOF\n${x:-'a b'}\nEOF","'a b'\n"],
    ["cat <<EOF\n${x:-a\\}b}\nEOF","a}b\n"],
    ["cat <<EOF\n${x:-$'a\\nb'}\nEOF","a\nb\n"],
    ["x=abc.txt; cat <<EOF\n${x%.txt}\nEOF","abc\n"],
    ["cat <<EOF\n${x:=\"a b\"}|$x\nEOF","a b|a b\n"],
    ["cat <<EOF\n${x:-'a\\\nb'}\nEOF","'ab'\n"],
    ["printf \"<%s>\" \"${IFS+set}\" \"${#IFS}\"","<set><3>"],
    ["unset IFS; printf \"<%s>\" \"${IFS+set}\" \"${IFS-fallback}\"","<><fallback>"],
    ["IFS=; printf \"<%s>\" \"${IFS+set}\" \"${IFS:-fallback}\"","<set><fallback>"],
  ]) {
    it(command, () => {
      const result = createTerminal({}).run(command)
      assert.equal(result.stdout, stdout)
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
      assert.deepEqual(result.unsupported, [])
    })
  }
})

describe('ANSI-C contents that would change quoted parameter boundaries', () => {
  for (const content of ["$'a}b'","$'a\\'b'"]) {
    for (const prefix of ['', 'x=kept; ']) {
      it(`${prefix}quoted default ${content}`, () => {
        const result = createTerminal({}).run(prefix + 'printf "%s" "${x:-' + content + '}"')
        assert.equal(result.stdout, '')
        assert.notEqual(result.exitCode, 0)
        assert.ok(result.unsupported.some((entry) => entry.kind === 'feature'))
      })
    }
  }

  for (const [command, stdout] of [
    ["printf '%s' ${x:-$'a}b'}","a}b"],
    ["printf '%s' ${x:-$'a\\'b'}","a'b"],
    ["x='a}brest'; printf '%s' \"${x#$'a}b'}\"","rest"],
    ["x=\"a'brest\"; printf '%s' \"${x#$'a\\'b'}\"","rest"],
  ]) {
    it(command, () => {
      const result = createTerminal({}).run(command)
      assert.equal(result.stdout, stdout)
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
      assert.deepEqual(result.unsupported, [])
    })
  }
})
