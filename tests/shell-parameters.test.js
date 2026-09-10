import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { evaluateParameter, parseParameter } from '../src/shell/parameter.js'
import { unsupportedNote } from '../src/unsupported.js'

// Expectations follow Bash's Shell Parameter Expansion manual and the
// parameter_brace_expand/remove_pattern implementations in Bash 5.2 subst.c.
function evaluate(content, bindings = {}, expansion) {
  const ctx = { vars: new Map(Object.entries(bindings)) }
  const expanded = []
  const result = evaluateParameter(parseParameter(content), ctx, {
    lookup: (name) => ({ value: ctx.vars.get(name) ?? '', set: ctx.vars.has(name) }),
    expand: (word, options) => {
      expanded.push([word, options])
      return expansion ? expansion(word, options) : { value: word, mask: '0'.repeat(word.length), q: false }
    },
  })
  return { result, vars: ctx.vars, expanded }
}

describe('parameter parser distinguishes supported operators', () => {
  for (const [content, expected] of [
    ['name', { name: 'name', operator: '' }],
    ['_name9', { name: '_name9', operator: '' }],
    ['?', { name: '?', operator: '' }],
    ['#', { name: '#', operator: '' }],
    ['009', { name: '9', operator: '' }],
    ['00', { name: '0', operator: '' }],
    ['#name', { name: 'name', operator: 'length' }],
    ['#009', { name: '9', operator: 'length' }],
    ['##', { name: '#', operator: 'length' }],
    ['#?', { name: '?', operator: 'length' }],
    ['#-', { name: '-', operator: 'length' }],
    ['#@', { name: '@', operator: 'length' }],
    ['#*', { name: '*', operator: 'length' }],
    ['#-fallback', { name: '#', operator: '-', word: 'fallback' }],
    ['#+fallback', { name: '#', operator: '+', word: 'fallback' }],
    ['x:-${y:-z}', { name: 'x', operator: ':-', word: '${y:-z}' }],
    ['x##a#b', { name: 'x', operator: '##', word: 'a#b' }],
    ['x%%a%b', { name: 'x', operator: '%%', word: 'a%b' }],
    ['x:1', { name: 'x', operator: ':', word: '1' }],
    ['x: -1', { name: 'x', operator: ':', word: ' -1' }],
    ['x:1:2', { name: 'x', operator: ':', word: '1:2' }],
    ['x:', { name: 'x', operator: ':', word: '' }],
    ['x/a/b', { name: 'x', operator: '/', word: 'a/b' }],
    ['x//a/b', { name: 'x', operator: '//', word: 'a/b' }],
    ['na\\\nme', { name: 'name', operator: '' }],
    ['#na\\\nme', { name: 'name', operator: 'length' }],
    ['x:\\\n-default', { name: 'x', operator: ':-', word: 'default' }],
    ['x#\\\n#pattern', { name: 'x', operator: '##', word: 'pattern' }],
    ['x:-\'a\\\nb\'', { name: 'x', operator: ':-', word: "'a\\\nb'" }],
    ['x:-\\\nword', { name: 'x', operator: ':-', word: '\\\nword' }],
  ]) it(content, () => { assert.deepEqual(parseParameter(content), expected) })

  for (const operator of ['-', ':-', '+', ':+', '=', ':=', '?', ':?', '#', '##', '%', '%%']) {
    it(`empty word after ${operator}`, () => {
      assert.deepEqual(parseParameter('x' + operator), { name: 'x', operator, word: '' })
    })
  }

  for (const content of ['', ' x', 'x ', 'x y', 'x[0]', 'x[@]', '!name', '!prefix*', '!name[@]', '#x:-word', '#x#p', 'x^', 'x^^', 'x,', 'x,,', 'x@Q', 'x@a', '#%', '#=', '#+', '#/', '#:', '1x', '.']) {
    it(`reports malformed or unimplemented ${content}`, () => {
      assert.throws(() => parseParameter(content), (error) => unsupportedNote(error)?.detail === '${')
    })
  }
})

describe('conditional parameter evaluation', () => {
  for (const [bindings, nullness, unset] of [[{}, true, true], [{ x: '' }, true, false], [{ x: 'value' }, false, false]]) {
    for (const colon of ['', ':']) {
      const missing = colon ? nullness : unset
      for (const operator of ['-', '+', '=']) {
        const content = 'x' + colon + operator + 'fallback'
        it(`${JSON.stringify(bindings)} ${content}`, () => {
          const { result, vars, expanded } = evaluate(content, bindings)
          const useWord = operator === '+' ? !missing : missing
          assert.equal(result.value, useWord ? 'fallback' : operator === '+' ? '' : bindings.x)
          assert.equal(expanded.length, Number(useWord))
          assert.equal(vars.get('x'), operator === '=' && useWord ? 'fallback' : bindings.x)
        })
      }
    }
  }

  it('does not evaluate unselected nested expressions', () => {
    const forbidden = () => { throw new Error('unexpected evaluation') }
    for (const content of ['x-default', 'x:-default', 'x=default', 'x:=default', 'x?error', 'x:?error']) {
      assert.equal(evaluate(content, { x: 'value' }, forbidden).result.value, 'value')
    }
    assert.equal(evaluate('x+alternate', {}, forbidden).result.value, '')
    assert.equal(evaluate('x:+alternate', { x: '' }, forbidden).result.value, '')
  })

  it('assignment returns the stored scalar without the operand quote mask', () => {
    const word = { value: 'a b*c', mask: '12210', q: true }
    const { result, vars, expanded } = evaluate('x:=ignored', {}, () => word)
    assert.deepEqual(result, { value: 'a b*c' })
    assert.equal(vars.get('x'), 'a b*c')
    assert.deepEqual(expanded, [['ignored', { assignment: true }]])
  })

  it('rejects assigning an absent positional parameter before expanding its operand', () => {
    assert.throws(() => evaluate('1:=value', {}, () => { throw new Error('unexpected evaluation') }), (error) => {
      assert.equal(error.message, '$1: cannot assign in this way')
      assert.equal(unsupportedNote(error), null)
      return true
    })
  })

  for (const [content, bindings, message] of [
    ['x?', {}, 'x: parameter not set'],
    ['x:?', { x: '' }, 'x: parameter null or not set'],
    ['x:?missing value', {}, 'x: missing value'],
    ['x:?  missing \n value \t ', {}, 'x: missing value'],
  ]) {it(`ordinary required-value error: ${content}`, () => {
    assert.throws(() => evaluate(content, bindings), (error) => {
      assert.equal(error.message, message)
      assert.equal(error.exitCode, 1)
      assert.equal(error.halt, true)
      assert.equal(unsupportedNote(error), null)
      return true
    })
  })}

  it('keeps quoted spaces in a required-value message', () => {
    assert.throws(() => evaluate('x:?word', {}, () => ({ value: ' a  b ', mask: '222222' })), { message: 'x:  a  b ' })
  })

  it('expands a provided error word to empty without inventing a default message', () => {
    assert.throws(() => evaluate('x:?word', {}, () => ({ value: '' })), { message: 'x: ' })
  })

  it('empty quoted message fields survive joining', () => {
    assert.throws(() => evaluate('x:?word', {}, () => ({ value: '  x ', mask: '0000', empty: [0, 1, 4] })), { message: 'x:   x ' })
  })
})

describe('parameter length and pattern removal', () => {
  for (const [content, bindings, expected] of [
    ['#x', {}, '0'], ['#x', { x: '' }, '0'], ['#x', { x: 'a\nb\t' }, '4'],
    ['x#*/', { x: 'a/b/c.txt' }, 'b/c.txt'], ['x##*/', { x: 'a/b/c.txt' }, 'c.txt'],
    ['x%/*', { x: 'a/b/c.txt' }, 'a/b'], ['x%%/*', { x: 'a/b/c.txt' }, 'a'],
    ['x%.*', { x: 'a.b.c' }, 'a.b'], ['x%%.*', { x: 'a.b.c' }, 'a'],
    ['x#*', { x: 'abc' }, 'abc'], ['x##*', { x: 'abc' }, ''],
    ['x%*', { x: 'abc' }, 'abc'], ['x%%*', { x: 'abc' }, ''],
    ['x#?', { x: 'abc' }, 'bc'], ['x%?', { x: 'abc' }, 'ab'],
    ['x#[[:digit:]]', { x: '1ab' }, 'ab'], ['x#[![:digit:]]', { x: 'a1' }, '1'],
    ['x#z*', { x: 'abc' }, 'abc'], ['x%z*', { x: 'abc' }, 'abc'],
    ['x#a', { x: 'a\n' }, '\n'], ['x%a', { x: 'a\n' }, 'a\n'],
    ['x%[a]', { x: 'a\n' }, 'a\n'], ['x#[a]', { x: 'a\n' }, '\n'],
    ['x%%a*', { x: 'a\nb\n' }, ''], ['x##*b', { x: 'a\nb\n' }, '\n'],
    ['x#é', { x: 'é😀' }, '😀'], ['x%😀', { x: 'é😀' }, 'é'],
    ['x##*é', { x: '😀é🦄' }, '🦄'], ['x%é*', { x: '😀é🦄' }, '😀'],
    ['x#\\*', { x: '*a' }, 'a'], ['x#\\', { x: '\\a' }, 'a'],
  ]) {it(`${content} on ${JSON.stringify(bindings.x)}`, () => {
    assert.equal(evaluate(content, bindings).result.value, expected)
  })}

  it('a quote mask makes wildcard and bracket syntax literal', () => {
    for (const literal of ['*', '?', '[ab]', '[[:digit:]]', '\\']) {
      const result = evaluate('x#pattern', { x: literal + 'rest' }, () => ({ value: literal, mask: '1'.repeat(literal.length) }))
      assert.equal(result.result.value, 'rest')
    }
  })

  it('skips pattern expansion when the source or raw pattern is empty', () => {
    for (const [content, bindings] of [['x#word', {}], ['x%%word', { x: '' }], ['x##', { x: 'abc' }]]) {
      assert.equal(evaluate(content, bindings, () => { throw new Error('unexpected expansion') }).expanded.length, 0)
    }
  })

  it('reports locale-dependent non-ASCII length', () => {
    assert.throws(() => evaluate('#x', { x: 'é' }), (error) => unsupportedNote(error)?.detail === '${')
  })

  for (const pattern of ['@(a|b)', '+(a)', '*(a)', '?(a)', '!(a)', '[@(a)', '[[:alpha:]]@(a)', '[]]@(a)']) {
    it(`reports dynamically produced extglob ${pattern}`, () => {
      assert.throws(() => evaluate('x#word', { x: 'abc' }, () => ({ value: pattern })), (error) => unsupportedNote(error)?.detail === '${')
    })
  }

  it('literal and quoted parentheses are supported', () => {
    assert.equal(evaluate('x#(a)', { x: '(a)b' }).result.value, 'b')
    assert.equal(evaluate('x#word', { x: '@(a)b' }, () => ({ value: '@(a)', mask: '1111' })).result.value, 'b')
    assert.equal(evaluate('x#[+(]', { x: '+a' }).result.value, 'a')
    assert.equal(evaluate('x#[[:alpha:]+(]', { x: '+a' }).result.value, 'a')
  })

  it('bounds an expensive unmatched removal rather than returning an approximation', () => {
    assert.throws(() => evaluate('x#?z', { x: 'a'.repeat(10_000) }), (error) => unsupportedNote(error)?.detail === '${')
  })
})

describe('shell parameter integration', () => {
  for (const [command, stdout] of [
    ['printf "<%s>" "${missing:-fallback}"', '<fallback>'],
    ['x=; printf "<%s>" "${x-default}" "${x:-default}"', '<><default>'],
    ['printf "<%s>" "${x:=a b}" "$x"', '<a b><a b>'],
    ['printf "<%s>" ${x:="a b"} "$x"', '<a><b><a b>'],
    ['printf "<%s>" ${x:-"a b"} ${x+unexpected}', '<a b>'],
    ['x=a/b/c.txt; printf "<%s>" "${x#*/}" "${x##*/}" "${x%/*}" "${x%%/*}"', '<b/c.txt><c.txt><a/b><a>'],
    ['x=abc; printf "<%s>" "${#x}" "${#missing}" "${#@}" "${##}"', '<3><0><0><1>'],
    ['x=yes; printf "<%s>" "${x:-$(cat absent)}" "${missing+$(cat absent)}"', '<yes><>'],
    ['printf "<%s>" ${missing:-"a b" c}', '<a b><c>'],
    ['printf "<%s>" ${missing:-a b}', '<a><b>'],
    ['x="*abc"; printf "<%s>" "${x#"*"}"', '<abc>'],
    ['printf "<%s>" "${x:-${y:-nested}}"', '<nested>'],
    ['printf "<%s>" "${x:-${y:=nested}}" "$y"', '<nested><nested>'],
    ['x=; printf "<%s>" "${x#${y:=unused}}" "${y-missing}"', '<><missing>'],
    ['x=aa; printf "<%s>" "${x#$(printf a)}" "${x%$(printf a)}"', '<a><a>'],
    ['x=abc; p="*"; printf "<%s>" "${x#$p}" "${x##$p}" "${x#\'$p\'}"', '<abc><><abc>'],
    ["printf '<%s>' \"${x:-'a b'}\"","<'a b'>"],
    ["printf '<%s>' \"${x:-'}'}\"","<'}'>"],
    ["printf '<%s>' \"${x:-a\\}b}\"","<a}b>"],
    ["printf '<%s>' \"${x:-$'a\\nb'}\"","<a\nb>"],
    ["printf '<%s>' \"${x:-\\a}\"","<\\a>"],
    ['HOME=/home/agent; printf "<%s>" ${x:-~} "${x:-~}"', '</home/agent><~>'],
    ['HOME=/home/agent; printf "<%s>" ${x:=~/a:~/b} "$x"', '</home/agent/a:~/b></home/agent/a:~/b>'],
    ['HOME=/home/agent; printf "<%s>" ${x:=NAME=~/a} "$x"', '<NAME=~/a><NAME=~/a>'],
    ['HOME=/home/agent; printf "<%s>" ${x:-NAME=~/a}', '<NAME=~/a>'],
  ]) {it(command, () => {
    const result = createTerminal({}).run(command)
    assert.equal(result.stdout, stdout)
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.unsupported, [])
  })}
})

describe('parameter quote masks and empty field boundaries', () => {
  for (const [command, expected] of [
    ["argv ${x:-\"\" \"\"}",["",""]],
    ["argv ${x:-a\"\" b''}",["a","b"]],
    ["argv ${x:-\"\"}x",["x"]],
    ["argv x${x:-\" \"}y",["x y"]],
    ["argv x${x:- }y",["x","y"]],
    ["argv ${x:=\"\" \"\"}",[]],
    ["argv \"${x:=\"\" \"\"}\"",[" "]],
    ["argv ${x:-\"$@\"}",[]],
    ["argv \"${x:-\"$@\"}\"",[""]],
    ["argv ${x:+\"$@\"}",[]],
    ["argv \"${x:+$@}\"",[""]],
    ["argv ${@:-}",[]],
    ["argv \"${@:-}\"",[""]],
    ["argv \"${@#x}\"",[]],
    ["argv \"${@+x}\"",[]],
    ["argv \"${@:+x}\"",[]],
    ["argv \"${@:+x}\"\"\"",[""]],
    ["argv a\"${@:+x}\"b",["ab"]],
    ["x=\" a b \"; argv a${x}b",["a","a","b","b"]],
    ["x=\" a b \"; argv a\"${x}\"b",["a a b b"]],
    ["x=\"a b\"; argv ${x#?}",["b"]],
    ["x=\"a b\"; argv \"${x#?}\"",[" b"]],
    ["argv ${x:-'a\\\nb'}",["a\\\nb"]],
    ["argv \"${x:-'a\\\nb'}\"",["'ab'"]],
    ["na\\\nme=ok; argv ${na\\\nme}",["ok"]],
    ["argv ${x:\\\n-fallback}",["fallback"]],
  ]) {
    it(command, () => {
      const terminal = createTerminal({}, { commands: { argv: (io) => JSON.stringify(io.args) } })
      const result = terminal.run(command)
      assert.equal(result.stdout, JSON.stringify(expected))
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
      assert.deepEqual(result.unsupported, [])
    })
  }
})

describe('parameter pathname expansion and failures', () => {
  for (const [command, expected] of [
    ["argv ${x:-'*.txt'} ${y:='*.txt'}",["*.txt","a.txt","b.txt"]],
    ["x=\"*.txt\"; p=\"*\"; argv ${x#\"$p\"} \"${x#\"$p\"}\" ${x#$p}",[".txt",".txt","a.txt","b.txt"]],
    ["x=\"*.txt\"; argv \"${x:-*.txt}\" ${x:+*.txt}",["*.txt","a.txt","b.txt"]],
  ]) {
    it(command, () => {
      const terminal = createTerminal({ 'a.txt': '', 'b.txt': '' }, { commands: { argv: (io) => JSON.stringify(io.args) } })
      const result = terminal.run(command)
      assert.equal(result.stdout, JSON.stringify(expected))
      assert.equal(result.stderr, '')
      assert.deepEqual(result.unsupported, [])
    })
  }

  for (const content of ['x^^', 'x@Q', '!x', 'x[@]', '#x:-word', '']) {
    it(`diagnoses unsupported ${content} through the public shell`, () => {
      const result = createTerminal({}).run('echo "${' + content + '}" 2>/dev/null | cat')
      assert.equal(result.stdout, '')
      assert.equal(result.unsupported[0]?.kind, 'feature')
      assert.equal(result.unsupported[0]?.detail, '${')
    })
  }

  for (const command of ['echo "${x:?required}"; echo unexpected', 'echo "${1:=value}"; echo unexpected']) {
    it(`ordinary expansion failures stop the command list: ${command}`, () => {
      const result = createTerminal({}).run(command)
      assert.equal(result.stdout, '')
      assert.equal(result.exitCode, 1)
      assert.notEqual(result.stderr, '')
      assert.deepEqual(result.unsupported, [])
    })
  }
})
