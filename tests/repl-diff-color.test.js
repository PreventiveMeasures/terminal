import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { describe, it } from 'node:test'
import { colorizeDiff } from '../bin/diff-color.js'

// The development REPL paints diff output; the library never does. Which
// lines take which style is @preventive/diff/color.js's answer and is
// checked there; what is left here is the painting, which is all this REPL
// adds: the style names become escapes, and only for a terminal.

const terminal = () => Object.assign(new Writable({ write(chunk, encoding, done) { done() } }),
  { isTTY: true, getColorDepth: () => 8 })
const pipe = () => new Writable({ write(chunk, encoding, done) { done() } })
const painted = (text) => colorizeDiff(text, terminal())

const UNIFIED = '--- a.txt\n+++ b.txt\n@@ -1,3 +1,4 @@\n one\n-two\n+2\n three\n+four\n'
const NORMAL = '2c2\n< two\n---\n> 2\n3a4\n> four\n'
const CONTEXT = '*** a.txt\n--- b.txt\n***************\n*** 1,3 ****\n  one\n! two\n--- 1,4 ----\n+ four\n'

describe('the REPL paints a diff it can recognise', () => {
  it('turns each style name into the escapes for it', () => {
    const lines = painted(UNIFIED).split('\n')
    assert.match(lines[0], /^\[1m--- a\.txt\[22m$/u)
    assert.match(lines[2], /^\[36m@@ /u)
    assert.equal(lines[3], ' one', 'a line with no style is handed back as it was')
    assert.match(lines[4], /^\[31m-two\[39m$/u)
    assert.match(lines[5], /^\[32m\+2\[39m$/u)
  })
  it('paints the other two styles as well', () => {
    assert.match(painted(NORMAL).split('\n')[2], /^\[90m---\[39m$/u)
    assert.match(painted(CONTEXT).split('\n')[5], /^\[33m! two\[39m$/u)
  })
  it('paints only the diff lines when other output surrounds them', () => {
    const out = painted(`listing\n${UNIFIED}done\n`)
    assert.ok(out.startsWith('listing\n'), 'text before the diff is untouched')
    assert.ok(out.endsWith('done\n'), 'text after the diff is untouched')
    assert.match(out, /\[32m\+2\[39m/u)
  })
})

describe('the REPL leaves alone what it should', () => {
  it('hands back what is not a diff, untouched', () => {
    // `+`, `-` and `---` are ordinary in prose and in code.
    for (const text of ['plain text\n+ a bullet\n- another\n--- a rule\n', 'a.txt\nsub/b.js\n', '']) assert.equal(painted(text), text)
  })
  it('keeps a piped session plain even for a real diff', () => {
    // styleText writes no escapes for a stream that is not a terminal, which
    // is what keeps `bin/terminal.js … | cat` readable.
    for (const text of [UNIFIED, NORMAL, CONTEXT]) assert.equal(colorizeDiff(text, pipe()), text)
  })
})
