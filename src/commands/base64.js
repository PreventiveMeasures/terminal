import { baseCommand } from './base-coding.js'
import { fromBase64, toBase64 } from '@exodus/bytes/base64.js'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export const base64 = baseCommand('base64', { encode: toBase64, decode: decodeBase64 })

export function decodeBase64(input, ignoreGarbage = false) {
  const text = input.replace(ignoreGarbage ? /[^A-Za-z0-9+/=]/gu : /\n/gu, '')
  try { return { bytes: fromBase64(text), valid: true } } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
    return decodePartial(text)
  }
}

// GNU accepts concatenated padded blocks and emits recoverable bytes even
// from a malformed final block. The strict decoder handles the common case.
function decodePartial(text) {
  const output = new Uint8Array(Math.ceil(text.length / 4) * 3)
  const alphabetRun = /[A-Za-z0-9+/]*/uy
  let length = 0, pos = 0, valid = true
  while (pos < text.length) {
    alphabetRun.lastIndex = pos
    const count = alphabetRun.exec(text)[0].length
    const complete = count - count % 4
    if (complete) {
      const bytes = fromBase64(text.slice(pos, pos + complete))
      output.set(bytes, length)
      length += bytes.length
      pos += complete
    }
    if (pos === text.length) break
    const tail = count % 4
    if (tail < 2) { valid = false; break }
    const a = ALPHABET.indexOf(text[pos]), b = ALPHABET.indexOf(text[pos + 1])
    const c = tail === 3 ? ALPHABET.indexOf(text[pos + 2]) : 0
    output[length++] = a << 2 | b >> 4
    if (tail === 3) output[length++] = b << 4 | c >> 2
    const padding = 4 - tail
    const canonical = (tail === 2 ? b & 15 : c & 3) === 0
    pos += tail
    if (pos === text.length) { valid = canonical; break }
    if (!canonical || text.slice(pos, pos + padding) !== '='.repeat(padding)) { valid = false; break }
    pos += padding
  }
  return { bytes: output.subarray(0, length), valid }
}
