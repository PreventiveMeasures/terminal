import { UnsupportedError } from './unsupported.js'
import { ok, utf8, utf8Decoder } from './util.js'

// bash's `echo` builtin, whose option parsing is its own: a leading
// word is an option only if it is entirely `-` followed by `n`, `e` and
// `E` letters, and anything else — `--`, `-x`, `-n5`, a later `-n` —
// is printed. `-n` drops the trailing newline; `-e` enables
// backslash-escape interpretation and `-E` disables it, last one wins.
export function echo(_stdin, tokens) {
  let i = 0
  let trailingNewline = true
  let escapes = false
  for (; i < tokens.length && /^-[neE]+$/u.test(tokens[i]); i++) {
    for (const c of tokens[i].slice(1)) {
      if (c === 'n') trailingNewline = false
      else escapes = c === 'e'
    }
  }
  let out = tokens.slice(i).join(' ')
  if (escapes) {
    const r = interpretEscapes(out)
    out = r.text
    // `\c` halts output and suppresses the trailing newline.
    if (r.stop) trailingNewline = false
  }
  return ok(trailingNewline ? out + '\n' : out)
}

// Backslash escapes recognized by bash's `echo -e`. `\c` stops all
// further output; octal `\0NNN` (up to 3 digits), hex `\xHH` (up to 2
// digits) and `\uHHHH` / `\UHHHHHHHH` map to the matching code point.
// An unrecognized escape keeps its backslash literal, as bash does.
function interpretEscapes(s) {
  const simple = { a: 7, b: 8, e: 27, E: 27, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92 }
  const bytes = []
  const text = (value) => { for (const b of utf8.encode(value)) bytes.push(b) }
  const result = (stop) => ({ text: utf8Decoder.decode(Uint8Array.from(bytes)), stop })
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\' || i + 1 >= s.length) {
      const ch = String.fromCodePoint(s.codePointAt(i))
      text(ch); i += ch.length - 1; continue
    }
    const c = s[++i]
    if (c === 'c') return result(true)
    if (c in simple) { bytes.push(simple[c]); continue }
    if (c === '0') {
      let digits = ''
      while (digits.length < 3 && /[0-7]/u.test(s[i + 1] ?? '')) digits += s[++i]
      bytes.push(digits === '' ? 0 : parseInt(digits, 8) & 255)
      continue
    }
    const hexLen = c === 'x' ? 2 : c === 'u' ? 4 : c === 'U' ? 8 : 0
    if (hexLen > 0 && /[0-9a-fA-F]/u.test(s[i + 1] ?? '')) {
      let digits = ''
      while (digits.length < hexLen && /[0-9a-fA-F]/u.test(s[i + 1] ?? '')) digits += s[++i]
      const code = parseInt(digits, 16)
      if (c === 'x') bytes.push(code)
      else {
        if (code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) throw new UnsupportedError('feature', 'echo Unicode escape', 'echo: escapes outside Unicode scalar values are not supported')
        text(String.fromCodePoint(code))
      }
      continue
    }
    text('\\' + c)
  }
  return result(false)
}

