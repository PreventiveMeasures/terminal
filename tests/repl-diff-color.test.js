import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { describe, it } from 'node:test'
import { colorizeDiff } from '../bin/diff-color.js'

// The development REPL paints diff output; the library never does. Colour is
// decided by the stream, so both a terminal and a pipe are exercised here.
const terminal = () => Object.assign(new Writable({ write(chunk, encoding, done) { done() } }),
  { isTTY: true, getColorDepth: () => 8 })
const pipe = () => new Writable({ write(chunk, encoding, done) { done() } })
const painted = (text) => colorizeDiff(text, terminal())

const UNIFIED = '--- a.txt\n+++ b.txt\n@@ -1,3 +1,4 @@\n one\n-two\n+2\n three\n+four\n'
const NORMAL = '2c2\n< two\n---\n> 2\n3a4\n> four\n'
const CONTEXT = '*** a.txt\n--- b.txt\n***************\n*** 1,3 ****\n  one\n! two\n--- 1,4 ----\n+ four\n'

describe('the REPL paints a diff it can recognise', () => {
  it('colours a unified diff by role', () => {
    const lines = painted(UNIFIED).split('\n')
    // The file headers are bold rather than red and green, so a `---` header
    // is not mistaken for a removed line.
    assert.match(lines[0], /^\[1m--- a\.txt\[22m$/u)
    assert.match(lines[1], /^\[1m\+\+\+ b\.txt\[22m$/u)
    assert.match(lines[2], /^\[36m@@ /u)
    assert.equal(lines[3], ' one')
    assert.match(lines[4], /^\[31m-two\[39m$/u)
    assert.match(lines[5], /^\[32m\+2\[39m$/u)
  })

  it('colours a normal diff, separator included', () => {
    const lines = painted(NORMAL).split('\n')
    assert.match(lines[0], /^\[36m2c2\[39m$/u)
    assert.match(lines[1], /^\[31m< two\[39m$/u)
    assert.match(lines[2], /^\[90m---\[39m$/u)
    assert.match(lines[3], /^\[32m> 2\[39m$/u)
  })

  it('colours a context diff, changed lines apart from added ones', () => {
    const lines = painted(CONTEXT).split('\n')
    assert.match(lines[0], /^\[1m\*\*\* a\.txt\[22m$/u)
    assert.match(lines[2], /^\[36m\*{15}\[39m$/u)
    assert.match(lines[5], /^\[33m! two\[39m$/u)
    assert.match(lines[7], /^\[32m\+ four\[39m$/u)
  })
})

describe('the REPL leaves alone what is not a diff', () => {
  // `+`, `-` and `---` are ordinary in prose and in code. Without a hunk
  // header, a fence or a change command, none of it is a diff.
  for (const [label, text] of [
    ['a markdown list', 'plain text\n+ a bullet\n- another\n--- a rule\n'],
    ['a source file', 'const a = 1\n-- comment\n+++ nope\n'],
    ['command output', 'a.txt\nsub/b.js\n'],
    ['an empty string', ''],
    ['a lone dash rule', '---\n'],
  ]) {
    it(label, () => assert.equal(painted(text), text))
  }

  it('keeps a piped session plain even for a real diff', () => {
    // styleText writes no escapes for a stream that is not a terminal, which
    // is what keeps `bin/terminal.js … | cat` readable.
    for (const text of [UNIFIED, NORMAL, CONTEXT]) assert.equal(colorizeDiff(text, pipe()), text)
  })

  it('paints only the diff lines when other output surrounds them', () => {
    const mixed = `listing\n${UNIFIED}done\n`
    const out = colorizeDiff(mixed, terminal())
    assert.ok(out.startsWith('listing\n'), 'text before the diff is untouched')
    assert.ok(out.endsWith('done\n'), 'text after the diff is untouched')
    assert.match(out, /\[32m\+2\[39m/u)
  })
})
