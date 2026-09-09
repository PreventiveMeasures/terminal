import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Expected semantics come from GNU sed's manual and source; no native tools:
// https://github.com/mirror/sed/blob/0c1fe22ccacf4887e0be6c11deb4e9c83acc287d/sed/compile.c
// https://github.com/mirror/sed/blob/0c1fe22ccacf4887e0be6c11deb4e9c83acc287d/sed/execute.c
// https://www.gnu.org/software/sed/manual/html_node/Command_002dLine-Options.html
const FILES = {
  input: 'a\nb\na\n',
  first: 'a\nb', second: 'c\nd\n', third: 'e', empty: '',
  left: 'before\nstart\nleft\n', right: 'right\nend\nafter\n',
  restart: 'end\nstart\nagain\nend\ntail\n',
  zero: 'alpha\0\0beta\0tail',
  multiline: 'a\nb\0c\0', zeroFirst: 'a\0b', zeroSecond: 'c\0d\0',
  'scripts/replace': 's/a/A/\n',
  'scripts/chain': 's/A/B/\ns/b/B/',
  'scripts/print': '1p\n$p\n',
  'scripts/empty': '',
  'scripts/broken': 's/a',
  'scripts/unsupported': 'F\n',
  'scripts/dialect': 's/a+/X/',
  dialect: 'a+\naa\n',
  '-z': 's/a/A/',
}

function check(command, stdout, files = FILES) {
  assert.deepEqual(createTerminal(files).run(command), {
    stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [],
  }, command)
}

function ordinaryError(command, exitCode, pattern) {
  const actual = createTerminal(FILES).run(command)
  assert.equal(actual.stdout, '')
  assert.equal(actual.exitCode, exitCode)
  assert.match(actual.stderr, pattern)
  assert.deepEqual(actual.unsupported, [])
}

describe('sed script files preserve source order and script boundaries', () => {
  const cases = [
    ['sed -f scripts/replace input', 'A\nb\nA\n'],
    ['sed -fscripts/replace input', 'A\nb\nA\n'],
    ['sed --file=scripts/replace input', 'A\nb\nA\n'],
    ['sed --file scripts/replace input', 'A\nb\nA\n'],
    ['sed -f scripts/replace -f scripts/chain input', 'B\nB\nB\n'],
    ['sed -f scripts/chain -f scripts/replace input', 'A\nB\nA\n'],
    ["sed -e 's/a/A/' --file=scripts/chain -e 's/B/C/' input", 'C\nC\nC\n'],
    ["sed -f scripts/replace --expression='s/A/C/' -f scripts/chain input", 'C\nB\nC\n'],
    ['sed input -f scripts/replace -f scripts/chain', 'B\nB\nB\n'],
    ['sed -nf scripts/print input', 'a\na\n'],
    ['sed --quiet -f scripts/print input', 'a\na\n'],
    ['sed --silent --file=scripts/print input', 'a\na\n'],
    ['sed -f scripts/empty input', FILES.input],
    ['sed -f scripts/empty -f scripts/replace -f scripts/empty input', 'A\nb\nA\n'],
    ['sed -nf scripts/empty input', ''],
    ['sed -f scripts/dialect -E dialect', 'X\naa\n'],
    ['sed -E -f scripts/dialect dialect', 'X+\nX\n'],
    ["sed -f scripts/dialect -E -e 's/a+/Y/' dialect", 'X\nY\n'],
    ['sed -f -z input', 'A\nb\nA\n'],
    ['sed -f scripts/replace -- input', 'A\nb\nA\n'],
  ]
  for (const [command, stdout] of cases) it(command, () => check(command, stdout))

  for (const path of ['missing-script', 'scripts']) {
    it(`script read failure aborts before processing input: ${path}`, () => {
      ordinaryError(`sed -f scripts/replace -f ${path} input`, 4, new RegExp(path, 'u'))
    })
  }
  it('keeps malformed script contents an ordinary syntax error', () => {
    ordinaryError('sed -f scripts/broken input', 1, /unterminated/u)
  })
  it('does not combine incomplete commands across script sources', () => {
    ordinaryError("sed -f scripts/broken -e '/A/' input", 1, /unterminated/u)
  })
  for (const option of ['-f', '--file']) {
    it(`missing ${option} argument is an ordinary option error`, () => {
      ordinaryError('sed ' + option, 1, /requires an argument/u)
    })
  }
  for (const option of ['--null-data=value', '--separate=value', '--quiet=value']) {
    it(`rejects an argument supplied to ${option}`, () => {
      ordinaryError(`sed ${option} -f scripts/replace input`, 1, /doesn't allow an argument/u)
    })
  }
  it('attributes unsupported script contents to sed rather than -f', () => {
    const terminal = createTerminal(FILES)
    const actual = terminal.run('sed -f scripts/unsupported input')
    assert.equal(actual.exitCode, 1)
    assert.equal(actual.stdout, '')
    assert.deepEqual(actual.unsupported.map(({ kind, command, detail }) => ({ kind, command, detail })), [
      { kind: 'feature', command: 'sed', detail: 'script' },
    ])
    assert.equal(actual.stderr, actual.unsupported[0].message + '\n')
    const hidden = terminal.run('sed -f scripts/unsupported input 2>/dev/null | cat')
    assert.equal(hidden.stderr, '')
    assert.equal(hidden.exitCode, 0)
    assert.deepEqual(hidden.unsupported, actual.unsupported)
  })
})

describe('sed script files supplied through standard input', () => {
  const cases = [
    ["printf 's/a/A/\\n' | sed -f - input", 'A\nb\nA\n'],
    ["printf 's/a/A/\\n' | sed -f- input", 'A\nb\nA\n'],
    ["printf 's/a/A/\\n' | sed --file=- input", 'A\nb\nA\n'],
    ["printf 's/a/A/\\n' | sed -f - -f scripts/chain input", 'B\nB\nB\n'],
    ["printf 's/a/A/\\n' | sed -f - -f - input", 'A\nb\nA\n'],
    ["printf 's/a/A/\\n' | sed -f -", ''],
    ["printf 's/a/A/\\n' | sed -f - -", ''],
    ["printf 's/a/A/\\n' | sed -f - - input", 'A\nb\nA\n'],
    ["printf 's/a/A/\\n' | { sed -f - input; cat; }", 'A\nb\nA\n'],
    ["printf '' | sed -f - input", FILES.input],
    ["printf 'a\\nb\\n' | sed -f scripts/replace", 'A\nb\n'],
    ['{ sed -f - input; cat; } < scripts/replace', 'A\nb\nA\n'],
  ]
  for (const [command, stdout] of cases) it(command, () => check(command, stdout))
})

describe('sed NUL-terminated records', () => {
  const cases = [
    ["sed -z '' zero", FILES.zero],
    ["sed --null-data '' zero", FILES.zero],
    ["sed --zero-terminated '' zero", FILES.zero],
    ["sed -zn '1p' zero", 'alpha\0'],
    ["sed -zn '2p' zero", '\0'],
    ["sed -zn '$p' zero", 'tail'],
    ["sed -zn '2,3p' zero", '\0beta\0'],
    ["sed -z 's/^/P:/' zero", 'P:alpha\0P:\0P:beta\0P:tail'],
    ["sed -z 'p' zero", 'alpha\0alpha\0\0\0beta\0beta\0tail\0tail'],
    ["sed -zn '1p' multiline", 'a\nb\0'],
    ["sed -zn '/^a$/p' multiline", ''],
    ["sed -zn '/^a.*b$/p' multiline", 'a\nb\0'],
    ["sed -z 's/./X/g' multiline", 'XXX\0X\0'],
    [String.raw`sed -z 's/\n/:/g' multiline`, 'a:b\0c\0'],
    ['sed -zn -f scripts/print zero', 'alpha\0tail'],
    ['sed --null-data --quiet -f scripts/print multiline', 'a\nb\0c\0'],
    ["sed -z '' zeroFirst empty zeroSecond", 'a\0b\0c\0d\0'],
    ["sed -zn '$p' zeroFirst empty zeroSecond", 'd\0'],
    ["sed -z '' empty", ''],
    ["sed -zn '1p' empty", ''],
    ["printf 'a\\0b\\0' | sed -z 's/b/B/'", 'a\0B\0'],
  ]
  for (const [command, stdout] of cases) it(command, () => check(command, stdout))
})

describe('sed separates file addresses and active ranges', () => {
  const cases = [
    ["sed -sn '1p' first empty second third", 'a\nc\ne'],
    ["sed --separate -n '1p' first empty second third", 'a\nc\ne'],
    ["sed -sn '$p' first empty second third", 'b\nd\ne'],
    ["sed -n '$p' first empty second third", 'e'],
    ["sed -sn '2p' first empty second third", 'b\nd\n'],
    ["sed -sn '2,+2p' first empty second third", 'b\nd\n'],
    ["sed -n '2,+2p' first empty second third", 'b\nc\nd\n'],
    ["sed -sn '2,1p' first empty second", 'b\nd\n'],
    ["sed -s 's/^/X/' first empty second", 'Xa\nXb\nXc\nXd\n'],
    ["sed -sn '/start/,/end/p' left empty right", 'start\nleft\n'],
    ["sed -n '/start/,/end/p' left empty right", 'start\nleft\nright\nend\n'],
    ["sed -sn '/start/,/end/p' left empty restart", 'start\nleft\nstart\nagain\nend\n'],
    ["sed -sn '0,/end/p' left empty restart", 'before\nstart\nleft\nend\n'],
    ["sed -sn '1,/end/p' left empty restart", 'before\nstart\nleft\nend\nstart\nagain\nend\n'],
    ["sed -sn '$s/^/last:/p' first empty second third", 'last:b\nlast:d\nlast:e'],
    ['sed -sn -f scripts/print first empty second third', 'a\nb\nc\nd\ne\ne'],
    ["sed -zsn '1p;$p' zeroFirst empty zeroSecond", 'a\0b\0c\0d\0'],
    ["sed --separate --null-data --silent -e '$p' zeroFirst empty zeroSecond", 'b\0d\0'],
    ["printf 'u\\nv\\n' | sed -sn '$p' - first -", 'v\nb'],
  ]
  for (const [command, stdout] of cases) it(command, () => check(command, stdout))

  it('does not lose per-file state resets when an input cannot be opened', () => {
    const actual = createTerminal(FILES).run("sed -sn '$p' first missing second")
    assert.equal(actual.stdout, 'b\nd\n')
    assert.equal(actual.exitCode, 2)
    assert.match(actual.stderr, /missing: no such file or directory/u)
    assert.deepEqual(actual.unsupported, [])
  })
})
