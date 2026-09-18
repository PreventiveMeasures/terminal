import { encodeUtf8, encodeUtf8Loose } from '../util.js'
import { UnsupportedError } from '../unsupported.js'
import { byteLocale } from '../locale.js'

const QUOTE_ESCAPES = new Map([['\0', '0'], ['\u0007', 'a'], ['\b', 'b'], ['\f', 'f'], ['\n', 'n'], ['\r', 'r'], ['\t', 't'], ['\v', 'v']])

// GNU quoteaf keeps printable names shell-quoted and groups nonprinting
// bytes in adjacent ANSI-C quoted spans, so one filename stays one log entry.
export function quoteName(name, ctx) {
  const bytes = byteLocale(ctx)
  const units = bytes ? Array.from(encodeUtf8(name), (byte) => String.fromCodePoint(byte)) : [...name]
  if (!bytes && units.some((char) => char.codePointAt(0) > 127 && /[\p{C}\p{Zl}\p{Zp}]/u.test(char))) {
    throw new UnsupportedError('feature', 'filename quoting', 'quoting nonprinting Unicode filenames is not supported')
  }
  if (name.includes("'") && units.every((char) => /[-a-zA-Z0-9 %+,./:_\]']/u.test(char) || !bytes && char.codePointAt(0) > 127)) return '"' + name + '"'
  let escaped = false, out = "'"
  for (const char of units) {
    const code = char.codePointAt(0)
    const escape = QUOTE_ESCAPES.get(char) ?? (code < 32 || code === 127 || bytes && code > 127 ? code.toString(8).padStart(3, '0') : null)
    if (escape !== null) {
      if (!escaped) out += "'$'"
      escaped = true
      out += '\\' + escape
    } else if (char === "'") {
      out += "'\\''"
      escaped = false
    } else {
      if (escaped) out += "''"
      escaped = false
      out += char
    }
  }
  return out + "'"
}

// GNU quotearg's shell-escape style, which realpath uses: the same quoting as
// quoteaf, but omitted entirely when the name needs none. `#` and `~` are safe
// only away from the front, where a shell would read them as comment and tilde.
const SHELL_SAFE = /^[#%+,\-./0-9@A-Z\]_a-z{}~]+$/u

export function quoteShell(name, ctx) {
  if (SHELL_SAFE.test(name) && !'#~'.includes(name[0])) return name
  return quoteName(name, ctx)
}

// GNU quotearg's C style, which diff's headers name files in: a name with
// nothing awkward in it is printed bare; one with a space, a quote, a
// backslash or a control character is double-quoted with C escapes, and in
// a byte locale every byte past ASCII is an octal escape too.
const HEADER_ESCAPES = new Map([['', 'a'], ['\b', 'b'], ['\f', 'f'], ['\n', 'n'], ['\r', 'r'], ['\t', 't'], ['\v', 'v'], ['"', '"'], ['\\', '\\']])

export function quoteHeaderName(name, ctx) {
  const bytes = byteLocale(ctx)
  let out = ''
  let needed = false
  for (const char of name) {
    const code = char.codePointAt(0)
    const named = HEADER_ESCAPES.get(char)
    if (named !== undefined) { out += '\\' + named; needed = true }
    else if (char === ' ') { out += char; needed = true }
    else if (code < 32 || code === 127 || (code > 127 && (bytes || /[\p{C}\p{Zl}\p{Zp}]/u.test(char)))) {
      for (const byte of encodeUtf8Loose(char)) out += '\\' + byte.toString(8).padStart(3, '0')
      needed = true
    } else out += char
  }
  return needed ? `"${out}"` : name
}
