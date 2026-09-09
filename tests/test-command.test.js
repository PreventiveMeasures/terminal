import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = { 'a.txt': 'hello\n', empty: '', 'src/main.js': '', 'src/name with spaces.js': '', 'src/[x].js': '' }
const run = (command) => createTerminal(FILES).run(command)

function check(command, code) {
  const result = run(command)
  assert.deepEqual([result.stdout, result.stderr, result.exitCode, result.unsupported], ['', '', code, []], command)
}

describe('test and [ file predicates', () => {
  for (const [expression, code] of [
    ['-f a.txt', 0], ['-f empty', 0], ['-f /src/main.js', 0],
    ['-f src', 1], ['-f /', 1], ['-f missing', 1], ['-f ""', 1],
    ['-f a.txt/', 1], ['-f a.txt/../empty', 1], ['-f missing/../empty', 1],
    ['-f src/../empty', 0], ['-f src/./main.js', 0], ['-f src//main.js', 0],
    ['-f "src/name with spaces.js"', 0], [String.raw`-f src/\[x\].js`, 0],
    ['-e a.txt', 0], ['-e src', 0], ['-e missing', 1], ['-a a.txt', 0],
    ['-d src', 0], ['-d src/', 0], ['-d .', 0], ['-d /', 0], ['-d a.txt', 1],
    ['! -f empty', 1], ['! -f missing', 0], ['! -f a.txt/../empty', 0],
    ['-f /dev/null', 1], ['-e /dev/null', 0], ['-d /dev/null', 1],
    ['-f /dev/./null', 1], ['-f /dev/null/../empty', 1], ['-e /dev/null/', 1],
  ]) {
    it(expression, () => {
      check('test ' + expression, code)
      check('[ ' + expression + ' ]', code)
    })
  }

  it('resolves relative paths from cwd and reports the status to control flow', () => {
    assert.equal(run('cd src && test -f main.js && echo yes').stdout, 'yes\n')
    assert.equal(run('test -f missing || echo absent').stdout, 'absent\n')
    assert.equal(run('[ -f a.txt ] && cat a.txt').stdout, FILES['a.txt'])
    assert.equal(run('test -f missing; echo $?').stdout, '1\n')
  })

  it('leaves shared input untouched', () => {
    const result = run('{ test -f a.txt; [ -f missing ]; cat; } < a.txt')
    assert.deepEqual([result.stdout, result.stderr, result.exitCode, result.unsupported], [FILES['a.txt'], '', 0, []])
  })

  it('works through executable aliases and nested dispatch', () => {
    check('/usr/bin/test -f a.txt', 0)
    check('/bin/[ -f a.txt ]', 0)
    check('echo a.txt | xargs test -f', 0)
    assert.equal(run(String.raw`find . -type f -exec test -f {} \; -print`).stdout, './a.txt\n./empty\n./src/[x].js\n./src/main.js\n./src/name with spaces.js\n')
  })

  it('is discoverable as a command while [ stays hidden', () => {
    const terminal = createTerminal(FILES)
    assert.deepEqual(terminal.complete('tes'), ['test'])
    assert.deepEqual(terminal.complete('['), [])
    assert.equal(terminal.run('which test').stdout, '/usr/bin/test\n')
  })
})

describe('test expression argument rules', () => {
  for (const [expression, code] of [
    ['', 1], ['""', 1], ['value', 0], ['-f', 0], ['!', 0], ['--', 0], ['--anything', 0],
    ['! ""', 0], ['! value', 1], ['! !', 1], ['-n ""', 1], ['-z ""', 0],
    ['-n value', 0], ['-z value', 1], ['a = a', 0], ['a == a', 0], ['a != a', 1],
    ['a != b', 0], ['a = b', 1], ['! = !', 0], ['! a = b', 0],
    [String.raw`\( value \)`, 0], [String.raw`\( -f a.txt \)`, 0],
  ]) {
    it(expression || 'no expression', () => {
      check('test ' + expression, code)
      check('[ ' + expression + ' ]', code)
    })
  }

  for (const command of ['[', '[ -f a.txt', '[ -f a.txt ] extra', 'test -- -f a.txt', 'test -f a.txt extra', 'test a b', 'test -Q a.txt']) {
    it(command + ' reports an ordinary syntax error', () => {
      const result = run(command)
      assert.equal(result.stdout, '')
      assert.equal(result.exitCode, 2)
      assert.notEqual(result.stderr, '')
      assert.deepEqual(result.unsupported, [])
    })
  }
})

describe('test unavailable predicates remain diagnostic', () => {
  for (const [expression, detail] of [
    ['-r a.txt', '-r'], ['-w a.txt', '-w'], ['-x a.txt', '-x'], ['-s src', '-s'],
    ['-L a.txt', '-L'], ['-t 1', '-t'], ['-v HOME', '-v'], ['-o errexit', '-o'],
    ['a.txt -nt empty', '-nt'], ['a.txt -ef a.txt', '-ef'],
    ['! -r a.txt', '-r'], ['-f a.txt -a -f empty', 'compound expressions'],
    ['"" -o value', 'compound expressions'], ['-f /dev/stdin', 'stream device metadata'],
    ['-e /dev/stdout', 'stream device metadata'],
    ['-f /dev/fd/0', 'stream device metadata'],
  ]) {
    for (const [prefix, suffix] of [['test ', ''], ['[ ', ' ]']]) {
      const command = prefix + expression + suffix
      it(command, () => {
        const direct = run(command)
        const hidden = run(command + ' 2>/dev/null | cat')
        assert.equal(direct.exitCode, 2)
        assert.notEqual(direct.stderr, '')
        assert.deepEqual(direct.unsupported.map((note) => note.detail), [detail])
        assert.deepEqual(hidden.unsupported, direct.unsupported)
        assert.equal(hidden.stderr, '')
      })
    }
  }
})
