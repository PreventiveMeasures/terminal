import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { decodeUtf8, encodeUtf8, encodeUtf8Loose } from '../src/util.js'
import { unsupportedNote } from '../src/unsupported.js'

// The codec's strict APIs preserve BOMs and reject invalid Unicode. Its loose
// encoder retains TextEncoder's replacement behavior for existing byte readers.
// https://github.com/ExodusOSS/bytes#exodusbytesutf8js
const partialMessage = 'byte output that is not valid UTF-8 cannot be represented by this string-based terminal'
const surrogateMessage = 'unpaired UTF-16 surrogates cannot be encoded as UTF-8'
const result = (stdout = '', exitCode = 0, stderr = '', unsupported = [], notes = []) => ({ stdout, stderr, exitCode, cwd: '/', notes, unsupported })
// A writable overlay needs a mount away from `/`, and cwd follows the mount.
const mounted = (...args) => ({ ...result(...args), cwd: '/repo' })
const vectors = [
  ['', []], ['\0', [0]], ['\u007F', [0x7F]], ['\u0080', [0xC2, 0x80]],
  ['\u07FF', [0xDF, 0xBF]], ['\u0800', [0xE0, 0xA0, 0x80]],
  ['\uD7FF', [0xED, 0x9F, 0xBF]], ['\uE000', [0xEE, 0x80, 0x80]],
  ['\uFEFF', [0xEF, 0xBB, 0xBF]], ['\uFFFD', [0xEF, 0xBF, 0xBD]],
  ['\uFFFF', [0xEF, 0xBF, 0xBF]], ['\u{10000}', [0xF0, 0x90, 0x80, 0x80]],
  ['\u{10FFFF}', [0xF4, 0x8F, 0xBF, 0xBF]],
]

function gap(fn, detail, message) {
  assert.throws(fn, (error) => {
    assert.equal(error.message, message)
    assert.deepEqual(unsupportedNote(error), { kind: 'feature', command: null, detail, message })
    return true
  })
}

describe('UTF-8 codec preserves scalar boundaries and exact byte views', () => {
  for (const [text, bytes] of vectors) {
    it(JSON.stringify(text), () => {
      assert.deepEqual([...encodeUtf8(text)], bytes)
      assert.deepEqual([...encodeUtf8Loose(text)], bytes)
      assert.equal(decodeUtf8(Uint8Array.from(bytes)), text)
    })
  }

  it('honors a subarray byte offset and length without reading neighboring bytes', () => {
    const bytes = Uint8Array.from([0xFF, 0xEF, 0xBB, 0xBF, 0xC3, 0xA9, 0xFF])
    assert.equal(decodeUtf8(bytes.subarray(1, -1)), '\uFEFFé')
    assert.equal(decodeUtf8(bytes.subarray(3, 3)), '')
    assert.deepEqual([...bytes], [0xFF, 0xEF, 0xBB, 0xBF, 0xC3, 0xA9, 0xFF])
  })

  it('retains a leading BOM on every independent decode', () => {
    const bytes = Uint8Array.from([0xEF, 0xBB, 0xBF, 0xEF, 0xBB, 0xBF, 0])
    for (let i = 0; i < 3; i++) assert.equal(decodeUtf8(bytes), '\uFEFF\uFEFF\0')
  })

  it('keeps long ASCII prefixes and adjacent multibyte characters exact', () => {
    const prefix = 'a'.repeat(16_383)
    const text = prefix + 'é😀\uFEFF\0'
    const bytes = encodeUtf8(text)
    assert.equal(bytes.length, prefix.length + 10)
    assert.deepEqual([...bytes.subarray(prefix.length)], [0xC3, 0xA9, 0xF0, 0x9F, 0x98, 0x80, 0xEF, 0xBB, 0xBF, 0])
    assert.equal(decodeUtf8(bytes), text)
  })
})

describe('strict UTF-8 decoding rejects corrupt or incomplete sequences', () => {
  const invalid = [
    [0x80], [0xBF], [0xFF], [0xC0, 0x80], [0xC1, 0xBF], [0xC2], [0xC2, 0x41],
    [0xE0, 0x80, 0xAF], [0xE2, 0x82], [0xED, 0xA0, 0x80], [0xED, 0xBF, 0xBF],
    [0xEF, 0xBB], [0xF0, 0x80, 0x80, 0x80], [0xF0, 0x9F, 0x98],
    [0xF4, 0x90, 0x80, 0x80], [0xF5, 0x80, 0x80, 0x80], [0xF8, 0x88, 0x80, 0x80, 0x80],
  ]
  for (const bytes of invalid) {
    it(bytes.map((byte) => byte.toString(16)).join(' '), () => {
      gap(() => decodeUtf8(Uint8Array.from(bytes)), 'partial UTF-8 byte sequence', partialMessage)
    })
  }

  it('does not reuse decoder state after a failed call', () => {
    gap(() => decodeUtf8(Uint8Array.of(0xC3)), 'partial UTF-8 byte sequence', partialMessage)
    gap(() => decodeUtf8(Uint8Array.of(0xA9)), 'partial UTF-8 byte sequence', partialMessage)
    assert.equal(decodeUtf8(Uint8Array.of(0xC3, 0xA9)), 'é')
    assert.equal(decodeUtf8(Uint8Array.of(0xEF, 0xBB, 0xBF)), '\uFEFF')
  })

  it('validates the tail of a large input without returning its valid prefix', () => {
    const bytes = new Uint8Array(100_003).fill(0x61)
    bytes.set([0xED, 0xA0, 0x80], 100_000)
    gap(() => decodeUtf8(bytes), 'partial UTF-8 byte sequence', partialMessage)
  })
})

describe('loose encoding and strict file bytes retain their distinct contracts', () => {
  for (const [text, repaired] of [
    ['\uD800', '\uFFFD'], ['\uDC00', '\uFFFD'], ['\uD800\uD800', '\uFFFD\uFFFD'],
    ['\uDC00\uD800', '\uFFFD\uFFFD'], ['\uD800😀\uDC00', '\uFFFD😀\uFFFD'],
    ['before\uD800after', 'before\uFFFDafter'],
  ]) {
    it(JSON.stringify(text), () => {
      gap(() => encodeUtf8(text), 'unpaired surrogate', surrogateMessage)
      assert.deepEqual([...encodeUtf8Loose(text)], [...encodeUtf8(repaired)])
    })
  }

  it('preserves existing loose byte-reader behavior while strict encoders diagnose it', () => {
    const t = createTerminal({ input: '\uD800x' })
    assert.deepEqual(t.run('head -c3 input'), result('\uFFFD', 0, '', [], ['head: selected 3 of 4 bytes from "/input".']))
    assert.deepEqual(t.run('wc -c input'), result('4 input\n'))
    const failed = t.run('base64 input')
    assert.equal(failed.stdout, '')
    assert.equal(failed.exitCode, 1)
    assert.deepEqual(failed.unsupported.map(({ detail }) => detail), ['unpaired surrogate'])
  })

  it('does not corrupt a writable file when strict encoding rejects an append', () => {
    const t = createTerminal({ valid: '\uFEFFé😀', bad: '\uD800' }, { mount: '/repo', writable: '/tmp/' })
    assert.deepEqual(t.run('cat /repo/valid >/tmp/file'), mounted())
    const failed = t.run('cat /repo/bad >>/tmp/file 2>/dev/null | cat')
    assert.equal(failed.stdout, '')
    assert.equal(failed.stderr, '')
    assert.equal(failed.exitCode, 0)
    assert.deepEqual(failed.unsupported.map(({ detail }) => detail), ['unpaired surrogate'])
    assert.deepEqual(t.run('cat /tmp/file'), mounted('\uFEFFé😀'))
  })
})

describe('shell byte operations retain BOMs and UTF-8 diagnostics', () => {
  const text = '\uFEFFAé😀\0'
  for (const [command, stdout, notes] of [
    ['base64 -w0 input', '77u/QcOp8J+YgAA='],
    ['base64 input | base64 -d', text], ['base64 -d encoded', text],
    ['head -c3 input', '\uFEFF', ['head: selected 3 of 11 bytes from "/input".']],
    ['tail -c+4 input', 'Aé😀\0', ['tail: selected 8 of 11 bytes from "/input".']],
    ['cut -c1-3 input', '\uFEFF\n'], ['cut -c4-6 input', 'Aé\n'],
    ['wc -c input', '11 input\n'],
    [String.raw`printf '%b%b%b' '\357' '\273' '\277'`, '\uFEFF'],
    [String.raw`echo -en '\xEF\xBB\xBF'`, '\uFEFF'],
    [String.raw`printf '%s' $'\xEF\xBB\xBF'`, '\uFEFF'],
    [String.raw`awk 'BEGIN {printf "\357\273\277"}'`, '\uFEFF'],
    [String.raw`printf x | sed 'y/x/\xEF\xBB\xBF/'`, '\uFEFF'],
  ]) {
    it(command, () => {
      const t = createTerminal({ input: text, encoded: '77u/QcOp8J+YgAA=' })
      assert.deepEqual(t.run(command), result(stdout, 0, '', [], notes))
    })
  }

  for (const command of [
    'head -c2 input', 'cut -c2 input', 'base64 -d invalid',
    String.raw`printf '\377'`, String.raw`echo -en '\xFF'`,
    String.raw`awk 'BEGIN {printf "\377"}'`, String.raw`printf x | sed 'y/x/\xFF/'`,
  ]) {
    it(`keeps the diagnostic after stderr suppression: ${command}`, () => {
      const t = createTerminal({ input: text, invalid: '/w==' })
      const failed = t.run(command + ' 2>/dev/null | cat')
      assert.equal(failed.stdout, '')
      assert.equal(failed.stderr, '')
      assert.equal(failed.exitCode, 0)
      assert.deepEqual(failed.unsupported.map(({ detail }) => detail), ['partial UTF-8 byte sequence'])
    })
  }
})
