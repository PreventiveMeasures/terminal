import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Bash builtin semantics, not coreutils' arbitrary-length external test:
// test.c arithcomp calls general.c legal_number (strtoimax, decimal, int64).
// general.h whitespace permits only space/tab after the parsed integer.
// https://github.com/bminor/bash/blob/bash-5.2/test.c
// https://github.com/bminor/bash/blob/bash-5.2/general.c
// https://github.com/bminor/bash/blob/bash-5.2/general.h
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const OPERATORS = ['-eq', '-ne', '-lt', '-le', '-gt', '-ge']
const COMMANDS = ['test', '[']
const FILES = { lines: 'hit\nmiss\nhit\n' }
const invocation = (name, expression) => `${name} ${expression}${name === '[' ? ' ]' : ''}`
const result = (exitCode, stdout = '', stderr = '', unsupported = [], notes = []) => ({ stdout, stderr, exitCode, cwd: '/', notes, unsupported })

function check(expression, exitCode) {
  for (const name of COMMANDS) {
    const command = invocation(name, expression)
    assert.deepEqual(createTerminal(FILES).run(command), result(exitCode), command)
  }
}

function invalid(expression, operand) {
  for (const name of COMMANDS) {
    const command = invocation(name, expression)
    assert.deepEqual(createTerminal(FILES).run(command), result(2, '', `${name}: ${operand}: integer expression expected\n`), command)
  }
}

describe('test and [ compare signed decimal integers exactly', () => {
  const comparisons = [
    ['0', '0', ['-eq', '-le', '-ge']],
    ['-1', '0', ['-ne', '-lt', '-le']],
    ['0', '-1', ['-ne', '-gt', '-ge']],
    ['-2', '-1', ['-ne', '-lt', '-le']],
    ['17', '3', ['-ne', '-gt', '-ge']],
    ['3', '17', ['-ne', '-lt', '-le']],
    ['9007199254740992', '9007199254740993', ['-ne', '-lt', '-le']],
    ['-9007199254740993', '-9007199254740992', ['-ne', '-lt', '-le']],
    ['9223372036854775807', '9223372036854775807', ['-eq', '-le', '-ge']],
    ['9223372036854775807', '9223372036854775806', ['-ne', '-gt', '-ge']],
    ['-9223372036854775808', '-9223372036854775808', ['-eq', '-le', '-ge']],
    ['-9223372036854775808', '9223372036854775807', ['-ne', '-lt', '-le']],
  ]
  for (const [left, right, trueOperators] of comparisons) {
    for (const operator of OPERATORS) {
      it(`${left} ${operator} ${right}`, () => {
        const expression = `${quote(left)} ${operator} ${quote(right)}`
        const exitCode = trueOperators.includes(operator) ? 0 : 1
        check(expression, exitCode)
        check('! ' + expression, exitCode === 0 ? 1 : 0)
      })
    }
  }
})

describe('test integer signs, decimal zeros and whitespace', () => {
  const cases = [
    ['+0', '0'], ['-0', '+0'], ['0000', '-0000'], ['+00017', '17'],
    ['-00017', '-17'], ['010', '10'], ['08', '8'], ['09', '9'],
    ['  +12', '12'], ['\t-12', '-12'], ['\n12', '12'], ['\r12', '12'],
    ['\f12', '12'], ['\v12', '12'], ['12 ', '12'], ['12\t', '12'],
    [' \t\n\r\f\v+0012\t ', '12'],
    ['0009223372036854775807', '9223372036854775807'],
    ['-0009223372036854775808', '-9223372036854775808'],
    ['0'.repeat(1000) + '9', '9'],
    ['-' + '0'.repeat(1000), '0'],
  ]
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input.length > 80 ? input.slice(0, 40) + '…' : input)} equals ${expected}`, () => {
      check(`${quote(input)} -eq ${quote(expected)}`, 0)
      check(`${quote(expected)} -ne ${quote(input)}`, 1)
    })
  }
})

describe('invalid test integers are ordinary errors, including overflow', () => {
  const operands = [
    '', ' ', '\t', '+', '-', '++1', '--1', '+-1', '-+1', '+ 1',
    '1 2', '1\t2', '0x10', '0X10', '2#10', '1+1', '1.0', '1e3',
    'NaN', 'inf', 'Infinity', 'name', '١', '１２', '\u00A01', '1\u00A0',
    '1\n', '1\r', '1\f', '1\v', '1 \t\n',
    '9223372036854775808', '+9223372036854775808', '-9223372036854775809',
    '18446744073709551615', '0009223372036854775808', '-0009223372036854775809',
    '9'.repeat(1000),
  ]
  for (const operand of operands) {
    it(`rejects ${JSON.stringify(operand.length > 80 ? operand.slice(0, 40) + '…' : operand)}`, () => {
      invalid(`${quote(operand)} -eq 0`, operand)
      invalid(`0 -eq ${quote(operand)}`, operand)
    })
  }
  for (const operator of OPERATORS) {
    it(`${operator} validates both operands before comparison or negation`, () => {
      invalid(`bad ${operator} worse`, 'bad')
      invalid(`1 ${operator} worse`, 'worse')
      invalid(`! bad ${operator} 0`, 'bad')
    })
  }
})

describe('integer predicates respect test argument-count precedence', () => {
  for (const [expression, exitCode] of [
    ['-eq', 0], ['-ne', 0], ['0', 0], ['-1', 0], ['! -eq', 1],
    ['-eq = -eq', 0], ['-lt = -gt', 1], ['! = !', 0],
    ['! 0 -ne 0', 0], ['! 0 -eq 0', 1], ['! ! -eq', 0],
  ]) it(expression, () => check(expression, exitCode))

  it('a three-argument binary comparison takes precedence over !', () => {
    invalid('! -eq 0', '!')
    invalid('-n -eq 0', '-n')
  })
  for (const command of ['test 1 -eq', '[ 1 -eq ]', '[ 1 -eq 1', 'test -- 1 -eq 1']) {
    it(`retains ordinary expression syntax errors: ${command}`, () => {
      const actual = createTerminal(FILES).run(command)
      assert.equal(actual.exitCode, 2)
      assert.notEqual(actual.stderr, '')
      assert.deepEqual(actual.unsupported, [])
    })
  }
})

describe('integer comparisons in shell control flow and status checks', () => {
  const cases = [
    ['false; if [ $? -ne 0 ]; then echo failed; else echo ok; fi', 'failed\n'],
    ['true; if [ $? -ne 0 ]; then echo failed; else echo ok; fi', 'ok\n'],
    ['false; if test $? -eq 1; then echo failed; else echo wrong; fi', 'failed\n'],
    ['true; [ $? -eq 0 ] && echo ok', 'ok\n'],
    ['false; [ "$?" -ne 0 ] && echo failed', 'failed\n'],
    ['[ 1 -gt 2 ]; echo $?', '1\n'],
    ['[ 2 -ge 2 ]; echo $?', '0\n'],
    ['grep missing lines; if [ $? -eq 1 ]; then echo absent; fi', 'absent\n'],
    ['grep hit missing 2>/dev/null; if [ $? -eq 2 ]; then echo unreadable; fi', 'unreadable\n',
      ["grep: no such file or directory: \"missing\"."]],
    ['c=$(grep -c hit lines); if [ "$c" -ge 2 ]; then echo repeated; fi', 'repeated\n'],
    ['for n in 0 1 2; do if [ "$n" -lt 2 ]; then echo "$n"; fi; done', '0\n1\n'],
    ['[ nope -eq 0 ] 2>/dev/null; if [ $? -eq 2 ]; then echo invalid; fi', 'invalid\n'],
    ['{ [ 1 -eq 1 ]; cat; } < lines', FILES.lines],
    ['/usr/bin/test 1 -eq 1 && /bin/[ 2 -gt 1 ] && echo aliases', 'aliases\n'],
  ]
  for (const [command, stdout, notes = []] of cases) {
    it(command, () => assert.deepEqual(createTerminal(FILES).run(command), result(0, stdout, '', [], notes)))
  }
})

describe('unimplemented test operations still reach diagnostics', () => {
  for (const [expression, detail] of [
    ['lines -nt lines', '-nt'], ['lines -ot lines', '-ot'], ['lines -ef lines', '-ef'],
    ["a '<' b", '<'], ["a '>' b", '>'],
    ['1 -eq 1 -a 2 -eq 2', 'compound expressions'],
    [String.raw`\( 1 -eq 1 \)`, 'compound expressions'],
  ]) {
    for (const name of COMMANDS) {
      const command = invocation(name, expression)
      it(command, () => {
        const terminal = createTerminal(FILES)
        const message = `${name}: ${detail} is not supported`
        const unsupported = [{ kind: 'feature', command: name, detail, message }]
        assert.deepEqual(terminal.run(command), result(2, '', message + '\n', unsupported))
        assert.deepEqual(terminal.run(command + ' 2>/dev/null | cat'), result(0, '', '', unsupported))
      })
    }
  }
})
