import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU sed compiles -e expressions in option order and uses positional script
// text only when no expression option was supplied:
// https://github.com/mirror/sed/blob/0c1fe22ccacf4887e0be6c11deb4e9c83acc287d/sed/sed.c
// https://github.com/mirror/sed/blob/0c1fe22ccacf4887e0be6c11deb4e9c83acc287d/sed/compile.c
const FILES = {
  input: 'a\nb\na\n', first: 'a\n', second: 'b\na\n',
  dialect: 'a+\naa\n', '1p': 'one\ntwo\n', '-e': 'a\n',
}
const result = (stdout, exitCode = 0, stderr = '', unsupported = []) => ({ stdout, stderr, exitCode, cwd: '/', unsupported })

function check(command, stdout) {
  assert.deepEqual(createTerminal(FILES).run(command), result(stdout), command)
}

describe('sed expression option spellings and ordering', () => {
  const cases = [
    ["sed -e 's/a/A/' input", 'A\nb\nA\n'],
    ["sed -e's/a/A/' input", 'A\nb\nA\n'],
    ['sed -es/a/A/ input', 'A\nb\nA\n'],
    ["sed --expression='s/a/A/' input", 'A\nb\nA\n'],
    ["sed --expression 's/a/A/' input", 'A\nb\nA\n'],
    ["sed -e 's/a/b/' -e 's/b/c/' input", 'c\nc\nc\n'],
    ["sed --expression='s/a/b/' -e 's/b/c/' --expression 's/c/d/' input", 'd\nd\nd\n'],
    ["sed -e 's/b/c/' --expression='s/a/b/' input", 'b\nc\nb\n'],
    ["sed first -e 's/a/A/' second", 'A\nb\nA\n'],
    ["sed first --expression='s/a/A/' -e 's/b/B/' second", 'A\nB\nA\n'],
    ["sed -e 's/a/A/;s/b/B/' input", 'A\nB\nA\n'],
    ["sed -e 's/a/A/\ns/b/B/' input", 'A\nB\nA\n'],
    ["sed -e 's/a/b/;' -e 's/b/c/' input", 'c\nc\nc\n'],
    ["sed -ne '1p' input", 'a\n'],
    ["sed -ne1p input", 'a\n'],
    ["sed -e '1p' input -n", 'a\n'],
    ["sed -n -e '1,2p' -e '2,3p' input", 'a\nb\nb\na\n'],
    ["sed -n -e '1p' -e '$p' first second", 'a\na\n'],
    ["sed -n -e 2p 1p", 'two\n'],
    ["sed -e 's/a/A/' -- -e", 'A\n'],
    ["sed -n -- 1p input", 'a\n'],
  ]
  for (const [command, stdout] of cases) it(command, () => check(command, stdout))
})

describe('sed empty expressions and standard input', () => {
  const cases = [
    ["sed -e '' input", FILES.input],
    ['sed --expression= input', FILES.input],
    ["sed -e '' -e '' input", FILES.input],
    ["sed -e '' -e 's/a/A/' --expression= input", 'A\nb\nA\n'],
    ["sed -ne '' input", ''],
    ["printf 'a\\nb\\n' | sed -e 's/a/A/'", 'A\nb\n'],
    ["printf 'a\\nb\\n' | sed -ne1p", 'a\n'],
    ["printf 'a\\n' | sed -e ''", 'a\n'],
    ["printf 'a\\n' | sed --expression= --", 'a\n'],
    ["printf 'a\\n' | sed -e 's/a/A/' -", 'A\n'],
    ["printf 'a\\n' | sed -e 's/a/A/' - first", 'A\nA\n'],
  ]
  for (const [command, stdout] of cases) it(command, () => check(command, stdout))
})

describe('sed expression regex dialect follows option order', () => {
  const cases = [
    ["sed -E -e 's/a+/X/' dialect", 'X+\nX\n'],
    ["sed -e 's/a+/X/' -E dialect", 'X\naa\n'],
    ["sed -e 's/a+/first/' -E -e 's/a+/second/' dialect", 'first\nsecond\n'],
    ["sed -e 's/a+/first/' -r --expression='s/a+/second/' dialect", 'first\nsecond\n'],
    ["sed -e 's/a+/first/' --regexp-extended -e 's/a+/second/' dialect", 'first\nsecond\n'],
    ["sed -Ee 's/a+/X/' dialect", 'X+\nX\n'],
    ["sed 's/a+/X/' dialect -E", 'X+\nX\n'],
  ]
  for (const [command, stdout] of cases) it(command, () => check(command, stdout))
})

describe('sed reports expression argument and option errors precisely', () => {
  for (const option of ['-e', '--expression']) {
    for (const prefix of ['sed ', "sed -e 's/a/A/' input "]) {
      it(`missing ${option} argument after ${prefix}`, () => {
        assert.deepEqual(createTerminal(FILES).run(prefix + option), result('', 1, `sed: ${option} requires an argument\n`))
      })
    }
  }
  for (const [args, detail] of [
    ['-i', '-i'], ['--in-place', '--in-place'], ['--in-place=backup', '--in-place'],
    ['--posix', '--posix'], ['--not-a-sed-option', '--not-a-sed-option'],
  ]) {
    it(`identifies ${detail} instead of blaming script syntax`, () => {
      const command = `sed ${args} -e 's/a/A/' input`
      const message = `sed: unknown option: ${detail}`
      const diagnostics = [{ kind: 'option', command: 'sed', detail, message }]
      const terminal = createTerminal(FILES)
      assert.deepEqual(terminal.run(command), result('', 1, message + '\n', diagnostics))
      assert.deepEqual(terminal.run(command + ' 2>/dev/null | cat'), result('', 0, '', diagnostics))
    })
  }
  for (const command of [
    "sed -e 's/a' -e '/A/' input",
    "sed -e 's/a/A' --expression='/' input",
    "sed -Ee 's/(/X/' input",
    "sed -e 's/a/A/' -e 's/b/\\1/' input",
    "sed --regexp-extended=value -e 's/a/A/' input",
  ]) {
    it(`keeps ordinary expression/argument failures off diagnostics: ${command}`, () => {
      const actual = createTerminal(FILES).run(command)
      assert.equal(actual.stdout, '')
      assert.equal(actual.exitCode, 1)
      assert.notEqual(actual.stderr, '')
      assert.deepEqual(actual.unsupported, [])
    })
  }
  for (const command of ["sed -e d input", "sed -e -n input", "sed -e -- input"]) {
    it(`attributes unsupported command text to the script: ${command}`, () => {
      const actual = createTerminal(FILES).run(command)
      assert.equal(actual.exitCode, 1)
      assert.equal(actual.unsupported.length, 1)
      assert.deepEqual(actual.unsupported[0], {
        kind: 'feature', command: 'sed', detail: 'script',
        message: 'sed: only addressed p and s/regexp/replacement/[gp] scripts are supported',
      })
      assert.equal(actual.stderr, actual.unsupported[0].message + '\n')
    })
  }
  it('retains successful output beside an ordinary missing input error', () => {
    const actual = createTerminal(FILES).run("sed -e 's/a/A/' missing first")
    assert.equal(actual.stdout, 'A\n')
    assert.equal(actual.exitCode, 2)
    assert.match(actual.stderr, /missing: no such file or directory/u)
    assert.deepEqual(actual.unsupported, [])
  })
})
