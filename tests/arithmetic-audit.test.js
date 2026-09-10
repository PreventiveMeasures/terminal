import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { evaluateArithmetic } from '../src/shell/arithmetic.js'
import { BindingMap } from '../src/shell/bindings.js'
import { unsupportedNote } from '../src/unsupported.js'

const context = (values = {}) => ({ vars: new BindingMap(Object.entries(values)), cwd: '/', home: '/', user: 'user', lastExit: 0 })

// Bash expr.c evaluates compound lvalues before the right operand, and
// recursively evaluates a scalar's text on each read, including side effects.
describe('arithmetic recursive values and lvalue ordering', () => {
  for (const [expression, initial, value, after] of [
    ['i += j += k', { i: '1', j: '2', k: '3' }, 6n, { i: '6', j: '5', k: '3' }],
    ['a += (a = 8)', { a: '2' }, 10n, { a: '10' }],
    ['a = b = a++', { a: '2' }, 2n, { a: '2', b: '2' }],
    ['a = (b += 2), a + b', { a: 'broken expression', b: '3' }, 10n, { a: '5', b: '5' }],
    ['a += (b = 9)', { a: 'b++', b: '2' }, 11n, { a: '11', b: '9' }],
    ['a + a', { a: 'b++', b: '2' }, 5n, { a: 'b++', b: '4' }],
    ['++a', { a: 'b++', b: '2' }, 3n, { a: '3', b: '3' }],
    ['a++', { a: 'b++', b: '2' }, 2n, { a: '3', b: '3' }],
    ['a = b', { a: 'a', b: '7' }, 7n, { a: '7', b: '7' }],
    ['1 ? a=3, b=4 : 5', {}, 4n, { a: '3', b: '4' }],
    ['0 ? a=3 : (b=4)', {}, 4n, { b: '4' }],
  ]) {
    it(expression + ' with ' + JSON.stringify(initial), () => {
      const ctx = context(initial)
      assert.equal(evaluateArithmetic(expression, ctx), value)
      assert.deepEqual(Object.fromEntries(ctx.vars), after)
    })
  }

  it('keeps earlier recursive side effects when a later operand fails', () => {
    const ctx = context({ a: 'b++', b: '2' })
    assert.throws(() => evaluateArithmetic('a + 1/0', ctx), /division by zero/u)
    assert.equal(ctx.vars.get('b'), '3')
    assert.equal(ctx.vars.get('a'), 'b++')
  })
})

// expr.c's noeval suppresses variable lookup and writes, but still computes
// literal operands. Negative exponents therefore differ from division by zero.
describe('arithmetic skipped-branch evaluation', () => {
  for (const expression of ['1 || (a/=0)', '1 || (a%=0)', '1 || 2**(a=1,a)', '1 ? 1 : (a+=2)', '1 || a']) {
    it(expression, () => {
      const ctx = context({ a: 'b++', b: '2' })
      assert.equal(evaluateArithmetic(expression, ctx), 1n)
      assert.deepEqual(Object.fromEntries(ctx.vars), { a: 'b++', b: '2' })
    })
  }

  for (const expression of ['1 || 2**--a', '1 || 2**-(a=3)', '1 || 2**(a-=1)', '0 && 2**(-1/0)', '1 ? 1 : 2**-1']) {
    it('preserves the negative-exponent error: ' + expression, () => {
      const ctx = context({ a: '7' })
      assert.throws(() => evaluateArithmetic(expression, ctx), (error) => unsupportedNote(error)?.detail === 'arithmetic exponent')
      assert.equal(ctx.vars.get('a'), '7')
    })
  }

  for (const expression of ['1 || a[0]', '1 ? 2 : a[1]=3', '1 || 08', '1 || (a=)', '1 ? 2 : 3=4']) {
    it('does not conceal excluded syntax: ' + expression, () => {
      const result = createTerminal({}).run(`echo $(( ${expression} )) 2>/dev/null | cat`)
      assert.equal(result.stdout, '')
      assert.ok(result.unsupported.some(({ detail }) => detail.startsWith('arithmetic ')), JSON.stringify(result))
    })
  }
})

describe('arithmetic source-defined boundaries', () => {
  for (const [expression, value] of [
    ['0XdeadBEEF', 3_735_928_559n], ['36#zZ', 1295n], ['64#Z_@', 253_950n],
    ['18446744073709551618#10', 2n], ['-9223372036854775808 * -1', -9_223_372_036_854_775_808n],
    ['-9223372036854775808 + -1', 9_223_372_036_854_775_807n], ['!!+-+-~0', 1n],
  ]) {
    it(expression, () => assert.equal(evaluateArithmetic(expression, context()), value))
  }

  for (const expression of ['++7', '--7', '4+++a', '4---a', '+--+!!0', '1<<-1', '1>>64']) {
    it('diagnoses intentionally excluded Bash syntax or platform-dependent shifts: ' + expression, () => {
      const result = createTerminal({}).run(`echo $(( ${expression} ))`)
      assert.equal(result.stdout, '')
      assert.notEqual(result.exitCode, 0)
      assert.ok(result.unsupported.some(({ detail }) => detail.startsWith('arithmetic ')))
    })
  }
})

describe('unmodeled Bash state cannot silently become zero or unset', () => {
  const names = ['SHLVL', 'SHELL', 'TERM', 'PS4', 'OPTERR', 'HISTCMD', 'BASH_EXECUTION_STRING', 'BASH_LOADABLES_PATH', 'COMP_WORDBREAKS']
  for (const name of names) {
    for (const [command, detail] of [
      [`echo $(( ${name} ))`, 'arithmetic variable'],
      ['echo ${' + name + ':-fallback}', '$' + name],
      [`[[ -v ${name} ]]`, '$' + name],
    ]) {
      it(command, () => {
        const result = createTerminal({}).run(command)
        assert.equal(result.stdout, '')
        assert.notEqual(result.exitCode, 0)
        assert.ok(result.stderr.includes(name))
        assert.equal(result.unsupported.length, 1)
        assert.equal(result.unsupported[0].kind, 'feature')
        assert.equal(result.unsupported[0].detail, detail)
        assert.ok(result.unsupported[0].message.includes(name))
      })
    }
  }

  for (const [command, detail] of [
    ['{ echo $((OPTERR)); } 2>/dev/null | cat', 'arithmetic variable'],
    ['{ echo ${SHLVL:-0}; } 2>/dev/null | cat', '$SHLVL'],
    ['[[ -v HISTCMD ]] 2>/dev/null | cat', '$HISTCMD'],
  ]) {
    it('keeps diagnostics after hidden stderr and successful pipeline: ' + command, () => {
      const result = createTerminal({}).run(command)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
      assert.equal(result.unsupported.length, 1)
      assert.equal(result.unsupported[0].detail, detail)
    })
  }
})
