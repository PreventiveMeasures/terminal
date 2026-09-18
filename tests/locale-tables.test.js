import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { URL } from 'node:url'
import { LOCALE, classTables } from '../src/locale.js'
import { GLIBC } from '../src/locale-data.js'
import { recordTables, render } from './fixtures/locale/record-c-utf8.mjs'

// The C.UTF-8 tables the package carries are glibc's, recorded once from the
// library itself; the case folding read from them is GNU grep's. Both are
// held here to what the real thing answers: the tables to the glibc this
// machine runs where it is the recorded one and a C compiler is at hand, the
// folds to what grep matched, recorded into a fixture.
describe('the C.UTF-8 tables', () => {
  const recorded = recordTables()
  const skip = recorded === null ? 'no gcc or no C.UTF-8 locale here' : recorded.glibc === GLIBC ? false : `glibc ${recorded.glibc} here, ${GLIBC} recorded`
  it(`are glibc ${GLIBC}'s own`, { skip }, () => {
    assert.equal(readFileSync(new URL('../src/locale-data.js', import.meta.url), 'utf8'), render(recorded))
  })

  it('fold case as GNU grep does, for every character with a case', () => {
    const tables = classTables(LOCALE)
    const lines = readFileSync(new URL('./fixtures/locale/grep-folds.txt', import.meta.url), 'utf8').split('\n').filter((line) => line && !line.startsWith('#'))
    assert.ok(lines.length > 2000, `${lines.length} characters recorded`)
    for (const line of lines) {
      const [code, ...set] = line.split(' ').map((hex) => parseInt(hex, 16))
      assert.deepEqual(tables.fold(code), set, `U+${code.toString(16)}`)
    }
  })

  it('give a character with no case itself alone, and the ASCII tables the ASCII fold', () => {
    const tables = classTables(LOCALE)
    for (const code of [0x30, 0x5F, 0x2003, 0x65E5, 0x1F600]) assert.deepEqual(tables.fold(code), [code])
    assert.deepEqual(tables.foldRange(0x61, 0x7B), [[0x41, 0x7B], [0x131, 0x131], [0x17F, 0x17F]])
    assert.equal(tables.foldRange(0x5A, 0x61), null)
    const ascii = classTables('C')
    assert.deepEqual(ascii.fold(0x73), [0x53, 0x73])
    assert.deepEqual(ascii.fold(0xE9), [0xE9])
    assert.deepEqual(ascii.foldRange(0x61, 0x7B), [[0x41, 0x7B]])
  })
})
