import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { finishSedProgram, parseSedScript } from '../src/commands/sed-script.js'
import { unsupportedNote } from '../src/unsupported.js'

// GNU read_label preserves literal bytes until a blank, LF, ;, } or #.
// check_final_program resolves jumps against the last matching definition.
// https://github.com/mirror/sed/blob/v4.9/sed/compile.c
const compile = (...sources) => {
  const state = {}
  return finishSedProgram(sources.flatMap((source) => parseSedScript(source, false, false, state)), state)
}

describe('sed label grammar and program linking', () => {
  for (const label of ['123', 'a-very-long-label-name', 'é😀', 'a\\nb', "'literal'", 'a/b', 'a{b', 'a\rb', 'a\fb', 'a\vb', '__proto__', 'constructor']) {
    it(`preserves the literal label ${JSON.stringify(label)}`, () => {
      const commands = compile(`b${label};:${label};t ${label};T\t${label}`)
      assert.equal(commands[1].label, label)
      for (const index of [0, 2, 3]) assert.equal(commands[index].jump, 1)
    })
  }
  it('does not require semicolons after labels or named branches', () => {
    const commands = compile(':a p; b a p; t a p; T a p')
    assert.equal(commands.map((command) => command.kind).join(''), ':pbptpTp')
    for (const index of [2, 4, 6]) assert.equal(commands[index].jump, 0)
  })
  it('resolves all duplicate references to the final definition, including across sources and blocks', () => {
    const commands = compile('b end;:end;{t end;', ':end};T end')
    assert.equal(commands[0].jump, 4)
    assert.equal(commands[2].jump, 5)
    assert.equal(commands[3].jump, 4)
    assert.equal(commands[6].jump, 4)
  })
  it('branches without a label target the complete program end', () => {
    const commands = compile('b;{t}', 'T\nP')
    for (const index of [0, 2, 4]) assert.equal(commands[index].jump, 6)
  })
  it('retains addresses, ranges and inversion on branch and input commands', () => {
    const commands = compile('1,2!b end;/a/!t end;$T end;2N;1,3n;/x/!P;:end')
    assert.equal(commands[0].start.value, 1)
    assert.equal(commands[0].end.value, 2)
    assert.equal(commands[0].negated, true)
    assert.equal(commands[1].start.type, 'regex')
    assert.equal(commands[2].start.type, 'last')
    assert.equal(commands[3].start.value, 2)
    assert.equal(commands[4].end.value, 3)
    assert.equal(commands[5].negated, true)
    for (const index of [0, 1, 2]) assert.equal(commands[index].jump, 6)
  })
  it('uses the prefix before NUL as the label name without reinterpreting the suffix as commands', () => {
    const commands = compile(':end\0ignored;b end\0other;t end')
    assert.equal(commands.length, 3)
    assert.equal(commands[1].jump, 0)
    assert.equal(commands[2].jump, 0)
  })
  it('recognizes ASCII script whitespace independently of literal label characters', () => {
    const commands = compile('\r\f\v:a;\r\f\vP;ba')
    assert.equal(commands.map((command) => command.kind).join(''), ':Pb')
    assert.equal(commands[2].jump, 0)
  })
})

describe('sed label errors are ordinary compile failures', () => {
  for (const script of [':', ': ', ':\n', ':;', ':\0ignored', '1:x', '1,2:x', '/a/:x', '$:x']) {
    it(`rejects ${JSON.stringify(script)}`, () => {
      assert.throws(() => compile(script), (error) => !unsupportedNote(error) && error.exitCode === undefined && /label|addresses/u.test(error.message))
    })
  }
  for (const command of ['b', 't', 'T']) {
    it(`rejects missing ${command} targets even in an unreachable block`, () => {
      assert.throws(() => compile(`q;99{${command} missing}`), (error) => error.exitCode === 4 && !unsupportedNote(error) && /missing/u.test(error.message))
    })
  }
  it('reports the last unresolved branch first, following GNU final-program validation', () => {
    assert.throws(() => compile('b first;t second;T third'), /jump to `third'/u)
  })
  it('keeps comments diagnosed when a label stops before the comment marker', () => {
    assert.throws(() => compile(':label#comment'), (error) => unsupportedNote(error)?.detail === 'comments')
  })
  for (const command of ['N', 'n', 'P']) {
    it(`rejects operands and missing separators after ${command}`, () => {
      for (const script of [`${command}p`, `${command} text`, `${command}\r\n`]) {
        assert.throws(() => compile(script), (error) => !unsupportedNote(error) && /extra characters/u.test(error.message))
      }
    })
  }
})
