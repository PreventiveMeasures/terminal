import { parseArgs } from '../args.js'
import { INT64_MAX } from '../numeric.js'
import { encodeUtf8, err, ok, readInputs, utf8Decoder } from '../util.js'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const DEFAULT_WRAP = 76

export function base64(stdin, tokens, ctx) {
  const { flags, positional, order } = parseArgs(tokens, {
    short: ['d', 'i'], long: ['decode', 'ignore-garbage'], valueShort: ['w'], valueLong: ['wrap'],
  })
  let wrap = DEFAULT_WRAP
  for (const { name, value } of order) {
    if (name !== 'w' && name !== 'wrap') continue
    if (!/^[ \t\n\r\f\v]*[+-]?\d+$/u.test(value) || BigInt(value) < 0n) return err(`base64: invalid wrap size: ${value}`)
    const count = BigInt(value)
    wrap = count > INT64_MAX ? 0 : Number(count)
  }
  if (positional.length > 1) return err(`base64: extra operand: ${positional[1]}`)
  const input = readInputs('base64', positional, stdin, ctx)
  if (input.failed) return err(input.stderr)
  const text = input.inputs[0].content
  if (flags.has('d') || flags.has('decode')) return decode(text, flags.has('i') || flags.has('ignore-garbage'))
  const encoded = encodeBytes(encodeUtf8(text))
  if (!wrap || encoded === '') return ok(encoded)
  const lines = []
  for (let i = 0; i < encoded.length; i += wrap) lines.push(encoded.slice(i, i + wrap))
  return ok(lines.join('\n') + '\n')
}

function encodeBytes(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64()
  // Legacy browsers and Node 24 expose the standard binary-string codec.
  return btoa(Array.from(bytes, (byte) => String.fromCodePoint(byte)).join(''))
}

function decodeBytes(text) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(text)
  return Uint8Array.from(atob(text), (char) => char.codePointAt(0))
}

// GNU accepts concatenated padded blocks, but diagnoses garbage after
// writing all bytes recoverable before the first malformed block.
function decode(input, ignoreGarbage) {
  const text = input.replace(ignoreGarbage ? /[^A-Za-z0-9+/=]/gu : /\n/gu, '')
  const output = new Uint8Array(Math.ceil(text.length / 4) * 3)
  const alphabetRun = /[A-Za-z0-9+/]*/uy
  let length = 0, pos = 0, valid = true
  const append = (part) => {
    const bytes = decodeBytes(part)
    output.set(bytes, length)
    length += bytes.length
  }
  while (pos < text.length) {
    alphabetRun.lastIndex = pos
    const count = alphabetRun.exec(text)[0].length
    const complete = count - count % 4
    if (complete) { append(text.slice(pos, pos + complete)); pos += complete }
    if (pos === text.length) break
    const tail = count % 4
    if (tail < 2) { valid = false; break }
    const part = text.slice(pos, pos + tail)
    append(part)
    const padding = 4 - tail
    const canonical = (ALPHABET.indexOf(part.at(-1)) & (tail === 2 ? 15 : 3)) === 0
    pos += tail
    if (pos === text.length) { valid = canonical; break }
    if (!canonical || text.slice(pos, pos + padding) !== '='.repeat(padding)) { valid = false; break }
    pos += padding
  }
  const stdout = utf8Decoder.decode(output.subarray(0, length))
  if (valid) return ok(stdout)
  const stderr = 'base64: invalid input\n'
  return { stdout, stderr, exitCode: 1, events: [...(stdout ? [{ fd: 1, text: stdout }] : []), { fd: 2, text: stderr }] }
}
