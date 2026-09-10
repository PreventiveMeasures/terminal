import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { evaluateArithmetic } from '../src/shell/arithmetic.js'
import { BindingMap } from '../src/shell/bindings.js'
import { unsupportedNote } from '../src/unsupported.js'

// GNU Bash expr.c defines signed integer operations, scalar recursion,
// assignment ordering and noeval behavior for short-circuited branches.
// https://www.gnu.org/software/bash/manual/html_node/Shell-Arithmetic.html
const context = (values = {}) => ({ vars: new BindingMap(Object.entries(values)), cwd: '/', home: '/', user: 'user', lastExit: 0 })
const expected = (stdout) => ({ stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [] })
const cases = [
  ['', 0n], [' \t\n', 0n], ['42', 42n], ['010', 8n], ['0xFf', 255n], ['0Xff', 255n],
  ['2#10101', 21n], ['16#ff', 255n], ['16#FF', 255n], ['36#z', 35n], ['36#Z', 35n],
  ['64#aA@_', 2_772_927n], ['37#A', 36n], ['10#010', 10n], ['0', 0n], ['000', 0n],
  ['9007199254740993 + 2', 9_007_199_254_740_995n],
  ['9223372036854775807 + 1', -9_223_372_036_854_775_808n],
  ['18446744073709551616', 0n], ['0xffffffffffffffff', -1n],
  ['-9223372036854775808 / -1', -9_223_372_036_854_775_808n], ['-9223372036854775808 % -1', 0n],
  ['9223372036854775807 * 2', -2n], ['18446744073709551615 + 3', 2n],
  ['1 + 2 * 3', 7n], ['(1 + 2) * 3', 9n], ['2 ** 3 ** 2', 512n], ['-2 ** 2', 4n],
  ['-(2 ** 2)', -4n], ['0 ** 0', 1n], ['2 ** 63', -9_223_372_036_854_775_808n],
  ['2 ** 9223372036854775807', 0n], ['(-1) ** 9223372036854775807', -1n],
  ['11 / 3', 3n], ['-11 / 3', -3n], ['11 / -3', -3n], ['-11 % 3', -2n], ['11 % -3', 2n],
  ['5 << 2 + 1', 40n], ['-8 >> 2', -2n], ['1 << 63', -9_223_372_036_854_775_808n],
  ['~0', -1n], ['!5', 0n], ['!!5', 1n], ['6 & 3', 2n], ['6 ^ 3', 5n], ['6 | 3', 7n],
  ['1 < 2 < 1', 0n], ['1 == 1 == 1', 1n], ['1 | 2 & 4', 1n], ['1 + 2 << 3', 24n],
  ['3 > 2', 1n], ['3 >= 3', 1n], ['3 <= 2', 0n], ['3 != 2', 1n], ['0 || 5', 1n], ['3 && 7', 1n],
  ['0 ? 10 : 20', 20n], ['1 ? 2 : 3', 2n], ['1 ? 2, 3 : 4', 3n], ['0 ? 1 : 0 ? 2 : 3', 3n],
  ['1 || 1 / 0', 1n], ['0 && 1 % 0', 0n], ['1 ? 5 : 1 / 0', 5n], ['1, 2, 3', 3n],
]

describe('signed 64-bit shell arithmetic', () => {
  for (const [expression, result] of cases) {
    it(expression || 'empty expression', () => assert.equal(evaluateArithmetic(expression, context()), result))
  }
})

describe('shell arithmetic scalar values and assignment', () => {
  it('evaluates recursive scalar values rather than parsing only their numeric prefix', () => {
    const ctx = context({ a: 'b+1', b: 'c * 2', c: '4' })
    assert.equal(evaluateArithmetic('a', ctx), 9n)
    assert.equal(evaluateArithmetic('missing + empty', context({ empty: '' })), 0n)
  })

  for (const [expression, initial, result, after] of [
    ['a=5', 'bad expression', 5n, '5'], ['a+=3', '2', 5n, '5'], ['a-=3', '2', -1n, '-1'],
    ['a*=3', '2', 6n, '6'], ['a/=3', '8', 2n, '2'], ['a%=3', '8', 2n, '2'],
    ['a<<=3', '2', 16n, '16'], ['a>>=3', '16', 2n, '2'], ['a&=3', '6', 2n, '2'],
    ['a^=3', '6', 5n, '5'], ['a|=3', '6', 7n, '7'],
    ['a++', '2', 2n, '3'], ['a--', '2', 2n, '1'], ['++a', '2', 3n, '3'], ['--a', '2', 1n, '1'],
    ['a++ + a', '2', 5n, '3'], ['a += a++', '2', 4n, '4'], ['a = a++', '2', 2n, '2'],
    ['a++, a*=2, a', '2', 6n, '6'], ['++a', '9223372036854775807', -9_223_372_036_854_775_808n, '-9223372036854775808'],
  ]) {
    it(expression, () => {
      const ctx = context({ a: initial })
      assert.equal(evaluateArithmetic(expression, ctx), result)
      assert.equal(ctx.vars.get('a'), after)
    })
  }

  it('chains assignment from right to left', () => {
    const ctx = context()
    assert.equal(evaluateArithmetic('a=b=7', ctx), 7n)
    assert.equal(ctx.vars.get('a'), '7')
    assert.equal(ctx.vars.get('b'), '7')
  })

  it('runs assignments in variable values', () => {
    const ctx = context({ a: 'b+=2', b: '3' })
    assert.equal(evaluateArithmetic('a + a', ctx), 12n)
    assert.equal(ctx.vars.get('b'), '7')
  })

  it('preserves side effects performed before a runtime error', () => {
    const ctx = context()
    assert.throws(() => evaluateArithmetic('a=3, 1/0', ctx), /division by zero/u)
    assert.equal(ctx.vars.get('a'), '3')
  })

  for (const expression of ['1 || a++', '0 && ++a', '1 ? 5 : (a=9)', '0 ? (a=9) : 5']) {
    it(`suppresses inactive writes: ${expression}`, () => {
      const ctx = context({ a: '4' })
      evaluateArithmetic(expression, ctx)
      assert.equal(ctx.vars.get('a'), '4')
    })
  }

  it('does not evaluate invalid recursive values in skipped branches', () => {
    assert.equal(evaluateArithmetic('1 || a', context({ a: 'a' })), 1n)
    assert.equal(evaluateArithmetic('0 && a', context({ a: 'array[0]' })), 0n)
    assert.equal(evaluateArithmetic('1 || 2 ** a', context({ a: '-1' })), 1n)
  })
})

describe('arithmetic errors always retain unsupported diagnostics', () => {
  const invalid = ['1/0', '1%0', '2**-1', '1 || 2**-1', '08', '0x', '0xGG', '2#2', '1#0', '65#0', '10#', '010#1',
    '1.5', '1e3', '1 +', '()', '1 2', 'a[0]', '1 || a[0]', 'a[0]=1', '1=2', '(a)=2', '++1', 'a++=1',
    'a**=2', '1?2', '1?:2', '1?2:3=4', '1<<64', '1>>-1', 'a()', "'a'", '1;2', '$x', '1\r+2']
  for (const expression of invalid) {
    it(expression, () => {
      assert.throws(() => evaluateArithmetic(expression, context()), (error) => {
        const note = unsupportedNote(error)
        assert.equal(note?.kind, 'feature')
        assert.ok(note.detail.startsWith('arithmetic '), JSON.stringify(note))
        return true
      })
    })
  }

  for (const values of [{ a: 'a' }, { a: 'b', b: 'a' }, { a: 'a+1' }]) {
    it(`bounds variable recursion ${JSON.stringify(values)}`, () => {
      assert.throws(() => evaluateArithmetic('a', context(values)), (error) => unsupportedNote(error)?.detail === 'arithmetic limit')
    })
  }

  for (const expression of ['('.repeat(200) + '1' + ')'.repeat(200), '1+'.repeat(2000) + '1', '9'.repeat(100_001)]) {
    it(`bounds resources for an expression of length ${expression.length}`, () => {
      assert.throws(() => evaluateArithmetic(expression, context()), (error) => unsupportedNote(error)?.detail === 'arithmetic limit')
    })
  }

  for (const expression of ['RANDOM+1', 'SECONDS', 'PATH', 'RANDOM=1', 'UID=1', 'LINENO++']) {
    it(`does not invent special variable values: ${expression}`, () => {
      assert.throws(() => evaluateArithmetic(expression, context()), (error) => unsupportedNote(error)?.detail.startsWith('arithmetic '))
    })
  }
})

describe('arithmetic expansion integrates with shell words and state', () => {
  for (const [command, stdout] of [
    ['n=1; echo $((n++ + $n)); echo "$n"', '2\n2\n'],
    ['n=1; echo $((n++ + $((n++)))); echo "$n"', '3\n3\n'],
    ['n=1; echo $n$((n++))$n', '112\n'],
    ['n=1; echo $((n=2))$(printf "$n")', '22\n'],
    ['unset n; echo $((1 || ${n:=1/0})); echo "$n"', '1\n1/0\n'],
    ['echo $((1 + $(printf 2)))', '3\n'],
    ['echo $(( ${missing:-2} + 3 ))', '5\n'],
    ['echo pre$((1))"$((2))"post', 'pre12post\n'],
    ['echo $((1 + \\\n2))', '3\n'],
    ["n='1 + 2'; echo $((n))", '3\n'],
    ['n=1; [[ n++ -eq $((n++)) ]]; echo "$? $n"', '1 3\n'],
    ['n=1; [[ $((n++)) -eq n++ ]]; echo "$? $n"', '1 3\n'],
    ['[[ "1+2" -eq 3 ]]; echo "$?"', '0\n'],
  ]) {
    it(`preserves expansion order: ${command}`, () => {
      assert.deepEqual(createTerminal({}).run(command), expected(stdout))
    })
  }

  it('keeps large integers exact through expansion and assignment', () => {
    const terminal = createTerminal({})
    assert.deepEqual(terminal.run('n=9007199254740993; printf "%s\\n" "$((n + 2))"'), expected('9007199254740995\n'))
    assert.deepEqual(terminal.run('n=$((n+1)); printf "%s\\n" "$n"'), expected('9007199254740994\n'))
  })

  it('applies increments left to right without changing quoting', () => {
    const terminal = createTerminal({})
    assert.deepEqual(terminal.run('n=1; printf "%s\\n" "$((n++)):$((++n)):$n"'), expected('1:3:3\n'))
    assert.deepEqual(terminal.run("printf '%s\\n' '$((n++))'"), expected('$((n++))\n'))
    assert.deepEqual(terminal.run('printf "%s\\n" "$n"'), expected('3\n'))
  })

  for (const expression of ['1/0', 'a[0]', '1 || a[0]', '1<<64', 'RANDOM']) {
    it(`survives stderr suppression and pipeline status: ${expression}`, () => {
      const result = createTerminal({}).run(`echo $(( ${expression} )) 2>/dev/null | cat`)
      assert.equal(result.stdout, '')
      assert.ok(result.unsupported.some(({ detail }) => detail.startsWith('arithmetic ')), JSON.stringify(result))
    })
  }

  for (const expression of ['1/0', 'a', '1<<64']) {
    it(`halts the current input after failed expansion: ${expression}`, () => {
      const terminal = createTerminal({})
      terminal.run('a=a')
      const result = terminal.run(`echo before; echo $(( ${expression} )); echo after`)
      assert.equal(result.stdout, 'before\n')
      assert.equal(result.exitCode, 1)
      assert.equal(result.unsupported.length, 1)
      assert.deepEqual(terminal.run('echo fresh'), expected('fresh\n'))
    })
  }

  for (const [command, stdout] of [
    ['(echo before; echo $((1/0)); echo lost); echo outer', 'before\nouter\n'],
    ['echo "$(echo before; echo $((1/0)); echo lost)"; echo outer', 'before\nouter\n'],
    ['echo before; echo $((1/0)) | cat; echo after', 'before\nafter\n'],
  ]) {
    it(`isolates failed arithmetic expansion: ${command}`, () => {
      const result = createTerminal({}).run(command)
      assert.equal(result.stdout, stdout)
      assert.equal(result.exitCode, 0)
      assert.ok(result.unsupported.some(({ detail }) => detail === 'arithmetic division'))
    })
  }

  it('does not reinterpret quotes supplied by an expanded variable as expression quoting', () => {
    const result = createTerminal({}).run("n='\"1\"'; echo $(( $n ))")
    assert.equal(result.stdout, '')
    assert.equal(result.exitCode, 1)
    assert.ok(result.unsupported.some(({ detail }) => detail === 'arithmetic syntax'))
  })

  for (const expression of ['"1"+2', "'1'+2"]) {
    it(`keeps excluded literal quoting visible: ${expression}`, () => {
      const result = createTerminal({}).run(`echo $(( ${expression} ))`)
      assert.equal(result.stdout, '')
      assert.notEqual(result.exitCode, 0)
      assert.ok(result.unsupported.length > 0)
    })
  }
})
