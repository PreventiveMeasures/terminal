import { baseCommand } from './base-coding.js'
import { fromBase32, toBase32 } from '@exodus/bytes/base32.js'

// RFC 4648 base32, which is what coreutils' base32 writes and reads: five
// bytes to eight characters, padded to eight with `=`. Recorded from base32
// (GNU coreutils) 9.4.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const GROUP = 8
// How many characters of a group carry data. Every other count is a group
// GNU reads as far as it can and then calls invalid.
const WHOLE = Object.freeze([2, 4, 5, 7, 8])

export const base32 = baseCommand('base32', { encode: (bytes) => toBase32(bytes, { padding: true }), decode: decodeBase32 })

// What base32 wrote is what base32 mostly reads, and the runtime's own decoder
// reads that: it is asked first, and answers the whole of it. Asked for the
// padding coreutils insists on, the one thing it still takes that coreutils
// does not is a lowercase alphabet — so what it answers is looked over for
// that alone, which is cheaper than reading the whole input twice to decide
// whether to ask. Anything it will not read goes to the reading below, which
// is coreutils' own: a group at a time, lenient where coreutils is lenient.
const LOWER = /[a-z]/u
export function decodeBase32(input, ignoreGarbage = false) {
  const text = input.replace(ignoreGarbage ? /[^A-Z2-7=]/gu : /\n/gu, '')
  try {
    const bytes = fromBase32(text, { padding: true })
    if (!LOWER.test(text)) return { bytes, valid: true }
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
  }
  return decodeGroups(text)
}

// GNU reads a group of eight at a time and writes the whole bytes it spells,
// so a group that is not its alphabet's stops the reading without taking back
// what earlier groups wrote. A group short of eight — at the end of the
// input, or all that a stray `=` leaves — writes nothing and is invalid: what
// it holds is not a group yet. The bits past the last whole byte are not read
// at all, so a group spelling them differently spells the same bytes.
function decodeGroups(text) {
  const output = new Uint8Array(Math.ceil(text.length / GROUP) * 5)
  let length = 0, pos = 0, valid = true
  while (pos < text.length) {
    if (text.length - pos < GROUP) { valid = false; break }
    const group = text.slice(pos, pos + GROUP)
    const data = /^[A-Z2-7]*/u.exec(group)[0]
    length += whole(group, data, output.subarray(length))
    if (!WHOLE.includes(data.length) || group.slice(data.length) !== '='.repeat(GROUP - data.length)) { valid = false; break }
    pos += GROUP
  }
  return { bytes: output.subarray(0, length), valid }
}

// The bytes a group's data characters spell in full, five bits at a time.
function whole(group, data, into) {
  let bits = 0, held = 0, length = 0
  for (const character of data) {
    held = held << 5 | ALPHABET.indexOf(character)
    bits += 5
    if (bits < 8) continue
    bits -= 8
    into[length++] = held >> bits & 0xff
  }
  return length
}
