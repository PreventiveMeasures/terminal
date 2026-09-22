import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// tr reads its sets as characters, ranges, and the classes the locale names.
// What a class holds here is the ASCII of it, which is what this terminal
// reads its input as, and it holds them in code point order — the order a
// translation pairs the two sets off in. Every answer below was recorded from
// GNU coreutils 9.4 over the same bytes.
const IN = 'aB3 x_\n'
const out = async (command, input = IN) => (await createTerminal({ in: input }).run(`${command} < in`)).stdout
const fails = async (command, stderr) => {
  assert.deepEqual(await createTerminal({ in: IN }).run(`${command} < in`), {
    stdout: '', stderr, exitCode: 1, cwd: '/', notes: [], unsupported: [],
  }, command)
}

describe('tr reads the classes the locale names', () => {
  it('translates a class onto the one it pairs with', async () => {
    assert.equal(await out("tr '[:upper:]' '[:lower:]'"), 'ab3 x_\n')
    assert.equal(await out("tr '[:lower:]' '[:upper:]'"), 'AB3 X_\n')
    // Either set may carry more than the class, so long as the two line up.
    assert.equal(await out("tr 'x[:lower:]' 'y[:upper:]z'"), 'AB3 X_\n')
    assert.equal(await out("tr '[:lower:][:upper:]' '[:upper:][:lower:]'"), 'Ab3 X_\n')
  })

  it('pads a shorter second set with its last character, as it does any set', async () => {
    assert.equal(await out("tr '[:alpha:]' ."), '..3 ._\n')
    assert.equal(await out("tr '[:digit:]' D"), 'aBD x_\n')
  })

  it('deletes and squeezes by a class', async () => {
    assert.equal(await out("tr -d '[:digit:]'"), 'aB x_\n')
    assert.equal(await out("tr -d '[:alpha:]'"), '3 _\n')
    assert.equal(await out("tr -s '[:space:]'", 'a  b\n\n\nc\n'), 'a b\nc\n')
    assert.equal(await out("tr -s '[:lower:]'", 'aa bb\n'), 'a b\n')
  })

  it('complements a class, which is every character it does not name', async () => {
    assert.equal(await out("tr -c '[:alpha:]' ."), 'aB..x..')
    assert.equal(await out("tr -dc '[:alpha:]'"), 'aBx')
    assert.equal(await out("tr -sc '[:alpha:]'", 'a12  b\n'), 'a12 b\n')
  })

  it('takes every class the locale has, and no name it does not', async () => {
    assert.equal(await out("tr '[:alnum:]' -"), '--- -_\n')
    assert.equal(await out("tr '[:punct:]' P"), 'aB3 xP\n')
    assert.equal(await out("tr '[:blank:]' _"), 'aB3_x_\n')
    assert.equal(await out("tr '[:xdigit:]' h"), 'hhh x_\n')
    assert.equal(await out("tr '[:graph:]' g"), 'ggg gg\n')
    assert.equal(await out("tr '[:print:]' p"), 'pppppp\n')
    assert.equal(await out("tr '[:cntrl:]' C", 'a\tb\n'), 'aCbC')
    // `word` is GNU's own class for its regexes, and no class tr will take.
    await fails("tr '[:word:]' y", "tr: invalid character class 'word'\n")
    await fails("tr '[:foo:]' y", "tr: invalid character class 'foo'\n")
    await fails("tr '[::]' x", "tr: missing character class name '[::]'\n")
  })

  it('reads a bracket that begins no whole class as the bracket itself', async () => {
    assert.equal(await out("tr '[abc]' x", 'a]c\n'), 'xxx\n')
    assert.equal(await out("tr '[:]' x"), 'aB3 x_\n')
    assert.equal(await out("tr -s '[:l]'", 'helloo\n'), 'heloo\n')
  })

  it('says what GNU says of a second set no first set can pair with', async () => {
    await fails("tr '[:digit:]' '[:digit:]'", "tr: when translating, the only character classes that may appear in\nstring2 are 'upper' and 'lower'\n")
    await fails("tr 'ab' '[:upper:]'", 'tr: misaligned [:upper:] and/or [:lower:] construct\n')
    await fails("tr '[:alnum:]' '[:lower:]'", 'tr: misaligned [:upper:] and/or [:lower:] construct\n')
    await fails("tr '[:upper:]ab' '[:lower:]'", 'tr: when translating with string1 longer than string2,\nthe latter string must not end with a character class\n')
    await fails("tr -c '[:lower:]' '[:upper:]'", 'tr: when translating with string1 longer than string2,\nthe latter string must not end with a character class\n')
    await fails("tr -c '[:lower:]' 'xy'", 'tr: when translating with complemented character classes,\nstring2 must map all characters in the domain to one\n')
  })

  it('still says what it cannot read a set as', async () => {
    const gap = async (command, detail) => {
      const r = await createTerminal({ in: IN }).run(`${command} < in`)
      assert.deepEqual(r.unsupported.map((u) => u.detail), [detail], command)
      assert.notEqual(r.exitCode, 0, command)
    }
    await gap("tr '[=a=]' x", 'set expressions')
    await gap("tr 'abc' '[x*]'", 'repeat expressions')
  })
})
