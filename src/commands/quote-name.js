import { encodeUtf8, encodeUtf8Loose } from '../bytes.js'
import { UnsupportedError } from '../unsupported.js'
import { byteLocale, classTables } from '../locale.js'

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

const SAFE_CHAR = /^[#%+,\-./0-9@A-Z\]_a-z{}~]$/u

// GNU quotef: the shell-escape style with `:` quoted too, since the name
// stands before one — which is how coreutils names a file in most of what it
// says about one. A name of nothing but what a shell takes as it is, printed
// characters past ASCII among them, goes bare; anything else is quoted as
// quoteName quotes it. A lone brace is a word a shell reads, and so is
// quoted where one inside a name is not.
export function quoteFile(name, ctx) {
  const tables = byteLocale(ctx) ? null : classTables(ctx.locale)
  const bare = name !== '' && name !== '{' && name !== '}' && !'#~'.includes(name[0])
    && [...name].every((char) => SAFE_CHAR.test(char) || (tables !== null && char.codePointAt(0) > 127 && tables.has('print', char.codePointAt(0))))
  return bare ? name : quoteName(name, ctx)
}

// gnulib's quote(), which coreutils names most other operands with: the
// locale's quotation marks — the curly ones in a UTF-8 locale, `'` in C —
// around the text, with a backslash, the closing mark and what would not
// print spelt as C escapes, and in a byte locale every byte past ASCII too.
const LOCALE_ESCAPES = new Map([['\u0007', 'a'], ['\b', 'b'], ['\f', 'f'], ['\n', 'n'], ['\r', 'r'], ['\t', 't'], ['\v', 'v']])

export function quoteLocale(text, ctx) {
  const bytes = byteLocale(ctx)
  const tables = bytes ? null : classTables(ctx.locale)
  const [open, close] = bytes ? ["'", "'"] : ['‘', '’']
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0)
    if (char === '\\' || char === close) out += '\\' + char
    else if (LOCALE_ESCAPES.has(char)) out += '\\' + LOCALE_ESCAPES.get(char)
    else if (code < 128 ? code >= 32 && code < 127 : tables?.has('print', code)) out += char
    else for (const byte of encodeUtf8Loose(char)) out += '\\' + byte.toString(8).padStart(3, '0')
  }
  return open + out + close
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
