import { parseArgs } from '../args.js'
import { INT64_MAX } from '../numeric.js'
import { decodeUtf8, encodeUtf8, err, ok, readInputs } from '../util.js'
import { fromBase64, toBase64 } from '@exodus/bytes/base64.js'

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
  const encoded = toBase64(encodeUtf8(text))
  if (!wrap || encoded === '') return ok(encoded)
  const lines = []
  for (let i = 0; i < encoded.length; i += wrap) lines.push(encoded.slice(i, i + wrap))
  return ok(lines.join('\n') + '\n')
}

function decode(input, ignoreGarbage) {
  const { bytes, valid } = decodeBase64(input, ignoreGarbage)
  const stdout = decodeUtf8(bytes)
  if (valid) return ok(stdout)
  const stderr = 'base64: invalid input\n'
  return { stdout, stderr, exitCode: 1, events: [...(stdout ? [{ fd: 1, text: stdout }] : []), { fd: 2, text: stderr }] }
}

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
