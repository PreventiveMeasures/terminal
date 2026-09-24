// What `base64` and `base32` have in common, which is everything above the
// alphabet: the operands coreutils takes, the wrap it applies, the file it
// reads as it is held, and what it does with what it decoded.

import { parseArgs } from '../args.js'
import { INT64_MAX } from '../numeric.js'
import { decodeUtf8Loose, decodeUtf8Maybe, encodeUtf8, err, ok, readInputs } from '../util.js'

const DEFAULT_WRAP = 76

export function baseCommand(name, { encode, decode }) {
  return (stdin, tokens, ctx) => {
    const { flags, positional, order } = parseArgs(tokens, {
      short: ['d', 'i'], long: ['decode', 'ignore-garbage'], valueShort: ['w'], valueLong: ['wrap'],
    })
    let wrap = DEFAULT_WRAP
    for (const { name: option, value } of order) {
      if (option !== 'w' && option !== 'wrap') continue
      if (!/^[ \t\n\r\f\v]*[+-]?\d+$/u.test(value) || BigInt(value) < 0n) return err(`${name}: invalid wrap size: ${value}`)
      const count = BigInt(value)
      wrap = count > INT64_MAX ? 0 : Number(count)
    }
    if (positional.length > 1) return err(`${name}: extra operand: ${positional[1]}`)
    // The file as it is held: this is what bytes look like as text, so a file
    // this terminal cannot spell as text has an encoding all the same, while
    // text a pipe carried is encoded from the text it is rather than read twice.
    const input = readInputs(name, positional, stdin, ctx, { read: 'as-held' })
    if (input.failed) return err(input.stderr)
    const { content, bytes } = input.inputs[0]
    // Decoding reads the encoding itself, which is text; a byte that spells no
    // character spells none of its alphabet either, which is the invalid input
    // GNU reports.
    if (flags.has('d') || flags.has('decode')) {
      return decoded(name, decode(content ?? decodeUtf8Loose(bytes), flags.has('i') || flags.has('ignore-garbage')))
    }
    return wrapped(encode(bytes ?? encodeUtf8(content)), wrap)
  }
}

function wrapped(encoded, wrap) {
  if (!wrap || encoded === '') return ok(encoded)
  const lines = []
  for (let i = 0; i < encoded.length; i += wrap) lines.push(encoded.slice(i, i + wrap))
  return ok(lines.join('\n') + '\n')
}

// What was encoded was bytes, so what comes back out of it is bytes: handed
// on as they are where they spell no text, which a pipe and a file both take
// and a terminal carrying a string does not. GNU writes what it recovered
// before saying the rest was not its alphabet, so a failure carries output.
function decoded(name, { bytes, valid }) {
  const text = decodeUtf8Maybe(bytes)
  const stderr = valid ? '' : `${name}: invalid input\n`
  if (text !== undefined && valid) return ok(text)
  const written = text === undefined ? { fd: 1, bytes } : { fd: 1, text }
  return {
    stdout: text ?? '', stderr, exitCode: valid ? 0 : 1,
    events: [...(bytes.length ? [written] : []), ...(stderr ? [{ fd: 2, text: stderr }] : [])],
  }
}
