import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { decodeBase64 } from '../src/commands/base64.js'
import corpus from './fixtures/upstream/base64/exodus.json' with { type: 'json' }
import boundaries from './fixtures/upstream/base64/byte-boundaries.json' with { type: 'json' }

// Adapted from ExodusOSS/bytes v1.15.1, c33d586715d461d0c6171e4cf7c71a06eda447ec.
// https://github.com/ExodusOSS/bytes/blob/c33d586715d461d0c6171e4cf7c71a06eda447ec/tests/base64.test.js
// Attribution and scope: fixtures/upstream/base64/{LICENSE,README.md}.
const bytesFromHex = (hex) => Uint8Array.from(hex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16))
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const result = (stdout = '', exitCode = 0, stderr = '', unsupported = []) => ({ stdout, stderr, exitCode, cwd: '/', notes: [], unsupported })
const utf8Gap = [{
  kind: 'feature', command: 'base64', detail: 'partial UTF-8 byte sequence',
  message: 'base64: byte output that is not valid UTF-8 cannot be represented by this string-based terminal',
}]

describe('upstream base64 standard byte vectors', () => {
  for (const { input, hex } of corpus.raw) {
    it(`raw ${hex || 'empty'}`, () => {
      const bytes = bytesFromHex(hex)
      assert.deepEqual(decodeBase64(input), { bytes, valid: true })
      assert.deepEqual(decodeBase64(input.replaceAll('=', '')), { bytes, valid: true })
    })
  }

  // Upstream uses 50 random byte vectors and a reference encoder. These
  // deterministic equivalents pin the expected bytes without a codec oracle.
  for (let i = 0; i < 50; i++) {
    it(`deterministic byte pool ${i}`, () => {
      const tail = [[], [0x7f], [0x80, 0xff]][i % 3]
      const bytes = Uint8Array.from([...Array.from({ length: i }, () => [0, 1, 2]).flat(), ...tail])
      const input = 'AAEC'.repeat(i) + ['', 'fw==', 'gP8='][i % 3]
      assert.deepEqual(decodeBase64(input), { bytes, valid: true })
      assert.deepEqual(decodeBase64(input.replaceAll('=', '')), { bytes, valid: true })
    })
  }

  it('retains NUL and control bytes through the command interface', () => {
    for (const { input, hex } of corpus.raw.slice(0, 3)) {
      const text = String.fromCodePoint(...bytesFromHex(hex))
      const t = createTerminal({ input, text })
      assert.deepEqual(t.run('base64 -d input'), result(text))
      assert.deepEqual(t.run('base64 -w0 text'), result(input))
    }
  })

  it('diagnoses the upstream 0xff vector instead of corrupting its output', () => {
    const t = createTerminal({ input: '/w==' })
    assert.deepEqual(t.run('base64 -d input'), result('', 1, utf8Gap[0].message + '\n', utf8Gap))
    assert.deepEqual(t.run('base64 -d input 2>/dev/null | cat'), result('', 0, '', utf8Gap))
  })
})

describe('all upstream string rejection vectors with GNU decoding expectations', () => {
  it('pins the full string corpus, including its repeated padding vector', () => {
    assert.equal(corpus.rejected.length, 58)
    assert.equal(new Set(corpus.rejected.map(({ input }) => input)).size, 57)
    assert.equal(corpus.rejected.filter(({ valid }) => valid).length, 6)
  })

  for (const [index, { input, hex, valid }] of corpus.rejected.entries()) {
    it(`${index}: ${JSON.stringify(input)}`, () => {
      assert.deepEqual(decodeBase64(input), { bytes: bytesFromHex(hex), valid })
    })
  }

  it('preserves recoverable bytes even though the strict codec rejects the entire input', () => {
    const t = createTerminal({ input: 'aa==' })
    assert.deepEqual(t.run('base64 -d input'), result('i', 1, 'base64: invalid input\n'))
    assert.deepEqual(t.run('base64 -d input 2>&1'), result('ibase64: invalid input\n', 1))
  })

  it('keeps the UTF-8 diagnostic when rejected input has a binary decoded prefix', () => {
    const t = createTerminal({ input: 'aaa#' })
    assert.deepEqual(t.run('base64 -d input'), result('', 1, utf8Gap[0].message + '\n', utf8Gap))
  })
})

describe('GNU stream rules around the strict base64 codec', () => {
  const cases = [
    ['\nY\nW\nJ\nj\n', false, [97, 98, 99], true],
    ['YWJj\r\n', false, [97, 98, 99], false],
    ['Y W\tJ\rj\u00A0', false, [], false],
    ['Y W\tJ\rj\u00A0', true, [97, 98, 99], true],
    ['YQ==Yg==Yw==', false, [97, 98, 99], true],
    ['YQ==Yg==Yw', false, [97, 98, 99], true],
    ['YQ==Yg==Yw=', false, [97, 98, 99], false],
    ['YQ==Yg==Yx==', false, [97, 98, 99], false],
    ['YQ==Yg==Y!', false, [97, 98], false],
    ['YQ==Yg==Y!w==', true, [97, 98, 99], true],
    ['YQ=! =Yg==', true, [97, 98], true],
    ['YQ===Yg==', true, [97], false],
  ]
  for (const [input, ignoreGarbage, bytes, valid] of cases) {
    it(`${JSON.stringify(input)}, ignore garbage ${ignoreGarbage}`, () => {
      assert.deepEqual(decodeBase64(input, ignoreGarbage), { bytes: Uint8Array.from(bytes), valid })
      const command = 'base64 -d' + (ignoreGarbage ? 'i' : '') + ' input'
      assert.deepEqual(createTerminal({ input }).run(command), result(
        String.fromCodePoint(...bytes), valid ? 0 : 1, valid ? '' : 'base64: invalid input\n',
      ))
    })
  }

  it('reassembles UTF-8 across padded blocks before validating text', () => {
    const t = createTerminal({ input: '8A==nw==mA==gw==' })
    assert.deepEqual(t.run('base64 -d input'), result('😃'))
  })
})

describe('base64 byte boundaries preserve all payload bits', () => {
  it('decodes all 256 byte values and the complete base64 alphabet', () => {
    const { input, hex } = boundaries.allBytes
    assert.deepEqual(decodeBase64(input), { bytes: bytesFromHex(hex), valid: true })
    assert.deepEqual(decodeBase64(input.replaceAll('=', '')), { bytes: bytesFromHex(hex), valid: true })
  })

  for (const { input, hex } of boundaries.boundary) {
    it(hex, () => {
      const bytes = bytesFromHex(hex)
      const plain = input.replaceAll('=', '')
      assert.deepEqual(decodeBase64(input), { bytes, valid: true })
      assert.deepEqual(decodeBase64(plain), { bytes, valid: true })
      // Alter only discarded bits: GNU rejects the group after emitting
      // its payload. A strict-decoder failure must not lose those bytes.
      const padding = '='.repeat(4 - plain.length)
      const last = alphabet.indexOf(plain.at(-1))
      for (let bits = 1; bits < (bytes.length === 1 ? 16 : 4); bits++) {
        const malformed = plain.slice(0, -1) + alphabet[last | bits]
        for (const suffix of ['', padding]) {
          assert.deepEqual(decodeBase64(malformed + suffix), { bytes, valid: false }, malformed + suffix)
        }
      }
    })
  }
})
