import { encodeUtf8 } from '../util.js'
import { UnsupportedError } from '../unsupported.js'

const QUOTE_ESCAPES = new Map([['\0', '0'], ['\u0007', 'a'], ['\b', 'b'], ['\f', 'f'], ['\n', 'n'], ['\r', 'r'], ['\t', 't'], ['\v', 'v']])

// GNU quoteaf keeps printable names shell-quoted and groups nonprinting
// bytes in adjacent ANSI-C quoted spans, so one filename stays one log entry.
export function quoteName(name, ctx) {
  const locale = ctx.vars.get('LC_ALL') || ctx.vars.get('LC_CTYPE') || ctx.vars.get('LANG') || ''
  const byteLocale = locale === 'C' || locale === 'POSIX'
  const units = byteLocale ? Array.from(encodeUtf8(name), (byte) => String.fromCodePoint(byte)) : [...name]
  if (!byteLocale && units.some((char) => char.codePointAt(0) > 127 && /[\p{C}\p{Zl}\p{Zp}]/u.test(char))) {
    throw new UnsupportedError('feature', 'filename quoting', 'quoting nonprinting Unicode filenames is not supported')
  }
  if (name.includes("'") && units.every((char) => /[-a-zA-Z0-9 %+,./:_\]']/u.test(char) || !byteLocale && char.codePointAt(0) > 127)) return '"' + name + '"'
  let escaped = false, out = "'"
  for (const char of units) {
    const code = char.codePointAt(0)
    const escape = QUOTE_ESCAPES.get(char) ?? (code < 32 || code === 127 || byteLocale && code > 127 ? code.toString(8).padStart(3, '0') : null)
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
