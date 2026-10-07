// A name as bash prints it in a message of its own, where the name could hide
// in, or break up, the line it is printed on: as it is where every character
// prints, and otherwise spelt as an ANSI-C string — bash's printable_filename
// and ansic_quote, which it applies to a `cd` operand, a name it cannot find
// as a command, and the token a syntax error stops at. What prints is glibc's
// C.UTF-8 `print` class.

import { LOCALE, classTables } from '../locale.js'
import { encodeUtf8Loose } from '../bytes.js'
import { nearMessage } from './substitution.js'

const NAMED = { 0x1B: 'E', 0x07: 'a', 0x0B: 'v', 0x08: 'b', 0x0C: 'f', 0x0A: 'n', 0x0D: 'r', 0x09: 't', 0x5C: '\\', 0x27: "'" }

const prints = (code) => (code < 0x80 ? code >= 0x20 && code < 0x7F : classTables(LOCALE).has('print', code))

export function printableName(text) {
  if ([...text].every((ch) => prints(ch.codePointAt(0)))) return text
  let out = "$'"
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (NAMED[code] !== undefined) out += '\\' + NAMED[code]
    else if (prints(code)) out += ch
    // A character that does not print is each of its bytes, in octal.
    else for (const byte of encodeUtf8Loose(ch)) out += '\\' + byte.toString(8).padStart(3, '0')
  }
  return out + "'"
}

// Bash's messages for an error, the token a syntax error stopped at named as
// bash names it. The parser keeps the token as it was read, which is what a
// reader of the parse wants; only printing it spells it.
export function bashMessages(e, message = e?.message) {
  const said = e?.messages ?? [message]
  if (e?.token === undefined) return said
  const raw = nearMessage(e.token)
  return said.map((m) => (m === raw ? nearMessage(printableName(e.token)) : m))
}
