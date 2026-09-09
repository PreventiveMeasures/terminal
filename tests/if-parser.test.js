import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseLine } from '../src/shell/parse.js'
import { unsupportedNote } from '../src/unsupported.js'

const words = (stage) => stage.words.map((word) => word.value)
const command = (steps) => words(steps[0].stages[0])
const conditional = (text) => parseLine(text)[0].stages[0].conditional

describe('if parser structure', () => {
  it('represents condition, body, elif conditions, and else without flattening lists', () => {
    const parsed = conditional('if test -f a; then cat a; elif test -f b; then cat b; elif true; then echo fallback; else false; fi')
    assert.deepEqual(parsed.branches.map(({ condition, body }) => [command(condition), command(body)]), [
      [['test', '-f', 'a'], ['cat', 'a']],
      [['test', '-f', 'b'], ['cat', 'b']],
      [['true'], ['echo', 'fallback']],
    ])
    assert.deepEqual(command(parsed.otherwise), ['false'])
    assert.equal(conditional('if true; then echo yes; fi').otherwise, null)
  })

  it('preserves list gates, pipelines, and conditional stage redirects', () => {
    const parsed = parseLine('! if cat a | grep x && true; then echo yes; else echo no; fi 2>&1 |& cat')
    assert.equal(parsed[0].negate, true)
    const stage = parsed[0].stages[0]
    assert.deepEqual(stage.redirs, [{ fd: 2, op: 'dup', toFd: 1 }, { fd: 2, op: 'dup', toFd: 1 }])
    const condition = stage.conditional.branches[0].condition
    assert.deepEqual(condition.map((step) => [step.gate, step.stages.map(words)]), [
      ['first', [['cat', 'a'], ['grep', 'x']]], ['and', [['true']]],
    ])
    assert.deepEqual(words(parsed[0].stages[1]), ['cat'])
  })

  it('allows newlines and comments after each conditional keyword', () => {
    const parsed = conditional('if\n# condition\nfalse\nthen\necho no\nelif\ntrue\nthen\necho yes\nelse\necho fallback\nfi')
    assert.deepEqual(parsed.branches.map(({ condition, body }) => [command(condition), command(body)]), [
      [['false'], ['echo', 'no']], [['true'], ['echo', 'yes']],
    ])
    assert.deepEqual(command(parsed.otherwise), ['echo', 'fallback'])
  })

  it('nests conditionals in conditions and for-loop bodies', () => {
    const parsed = conditional('if if true; then false; else true; fi; then for f in a b; do if test -f "$f"; then cat "$f"; fi; done; fi')
    assert.equal(parsed.branches[0].condition[0].stages[0].conditional.branches.length, 1)
    const loop = parsed.branches[0].body[0].stages[0].loop
    assert.equal(loop.name, 'f')
    assert.deepEqual(command(loop.body[0].stages[0].conditional.branches[0].condition), ['test', '-f', '${f}'])
  })

  it('keeps subshell isolation and braces around conditional lists', () => {
    const parsed = parseLine('(if { true; }; then (echo yes); else { echo no; }; fi) | cat')
    const subshell = parsed[0].stages[0]
    assert.equal(subshell.isolate, true)
    const branches = subshell.group[0].stages[0].conditional
    assert.equal(branches.branches[0].condition[0].stages[0].isolate, false)
    assert.equal(branches.branches[0].body[0].stages[0].isolate, true)
    assert.equal(branches.otherwise[0].stages[0].isolate, false)
  })

  it('recognizes conditional keywords only when unquoted in command position', () => {
    assert.deepEqual(command(parseLine('echo if then else elif fi')), ['echo', 'if', 'then', 'else', 'elif', 'fi'])
    assert.deepEqual(command(parseLine('"if" argument')), ['if', 'argument'])
    const parsed = conditional('if true; then echo fi; "else"; \\fi; fi')
    assert.deepEqual(parsed.branches[0].body.map((step) => command([step])), [['echo', 'fi'], ['else'], ['fi']])
  })

  it('preserves bare-negation condition lists and redirect-only branch commands', () => {
    const parsed = conditional('if !; then >/dev/null; else !; fi')
    assert.equal(parsed.branches[0].condition[0].negate, true)
    assert.deepEqual(parsed.branches[0].condition[0].stages, [])
    assert.deepEqual(parsed.branches[0].body[0].stages[0].redirs, [{ fd: 1, op: 'to', target: '/dev/null', both: false, append: false, label: '>' }])
    assert.equal(parsed.otherwise[0].negate, true)
  })
})

describe('if parser errors', () => {
  for (const text of [
    'if', 'if true', 'if true; then', 'if true; then echo yes;',
    'if then echo yes; fi', 'if true; then fi', 'if true; then echo yes; else fi',
    'if true; then echo yes; elif then echo no; fi', 'if true; then echo yes; elif false; fi',
    'if true; then echo yes; else echo no; elif true; then echo later; fi',
    'if true; then echo yes; fi extra', 'if true; then echo yes; fi (echo no)',
    'if true &&; then echo yes; fi', 'if true; then echo yes |; fi',
    'if ; true; then echo yes; fi', 'if true; then ; echo yes; fi',
    'if true; then echo yes; else ; echo no; fi',
    'if (true; then echo yes; fi', 'if true; then (echo yes; fi',
    'if true; then echo yes; done', 'if true; then echo yes; fi; fi',
  ]) {
    it(text, () => {
      assert.throws(() => parseLine(text), (error) => {
        assert.equal(unsupportedNote(error), null)
        return true
      })
    })
  }

  it('retains diagnostics for unsupported syntax nested in conditionals', () => {
    assert.throws(() => parseLine('if true; then while true; do echo no; done; fi'), (error) => {
      assert.equal(unsupportedNote(error).detail, 'while')
      return true
    })
  })
})
