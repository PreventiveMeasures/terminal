import { encodeUtf8Loose } from '../util.js'

// diff's headers name files the way quotearg's C style does: a name with
// nothing awkward in it is printed bare; one with a space, a quote, a
// backslash or a control character is double-quoted with C escapes, and in
// a byte locale every byte past ASCII is an octal escape too.
const NAMED = new Map([['', 'a'], ['\b', 'b'], ['\f', 'f'], ['\n', 'n'], ['\r', 'r'], ['\t', 't'], ['\v', 'v'], ['"', '"'], ['\\', '\\']])

export function quoteHeaderName(name, ctx) {
  const locale = ctx.vars.get('LC_ALL') || ctx.vars.get('LC_CTYPE') || ctx.vars.get('LANG') || ''
  const byteLocale = locale === 'C' || locale === 'POSIX'
  let out = ''
  let needed = false
  for (const char of name) {
    const code = char.codePointAt(0)
    const named = NAMED.get(char)
    if (named !== undefined) { out += '\\' + named; needed = true }
    else if (char === ' ') { out += char; needed = true }
    else if (code < 32 || code === 127 || (code > 127 && (byteLocale || /[\p{C}\p{Zl}\p{Zp}]/u.test(char)))) {
      for (const byte of encodeUtf8Loose(char)) out += '\\' + byte.toString(8).padStart(3, '0')
      needed = true
    } else out += char
  }
  return needed ? `"${out}"` : name
}
