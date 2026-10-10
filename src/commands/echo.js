import { UnsupportedError, unsupported } from '../unsupported.js'
import { decodeUtf8, encodeUtf8Loose, ok } from '../util.js'
import { isUnicodeScalar, stepAt } from '../unicode.js'

// Only leading -[neE]+ words are options; -- and other spellings are literal.
// The last -e/-E wins, while any -n suppresses the final newline.
export function echo(_stdin, tokens) {
  return runEcho(tokens, false)
}

// coreutils' echo, which a path, xargs and find -exec run: the same options,
// but `--help` or `--version` alone is a question it answers, and its `-e`
// reads `\NNN` as octal without the leading zero and has no `\E`, `\u` or
// `\U`, writing those back out as they stand.
export function echoProgram(_stdin, tokens, _ctx, name = 'echo') {
  if (tokens.length === 1 && (tokens[0] === '--help' || tokens[0] === '--version')) {
    return unsupported('option', 'echo', tokens[0], `${name}: ${tokens[0]} is not supported`)
  }
  return runEcho(tokens, true)
}

function runEcho(tokens, coreutils) {
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
    const r = interpretEscapes(out, coreutils)
    out = r.text
    // `\c` halts output and suppresses the trailing newline.
    if (r.stop) trailingNewline = false
  }
  return ok(trailingNewline ? out + '\n' : out)
}

const BASH_SIMPLE = { a: 7, b: 8, e: 27, E: 27, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92 }
const COREUTILS_SIMPLE = { a: 7, b: 8, e: 27, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92 }

// Octal and hex escapes emit bytes; Unicode escapes emit encoded code points.
// Unknown escapes remain literal, and \c stops all further output.
function interpretEscapes(s, coreutils) {
  const simple = coreutils ? COREUTILS_SIMPLE : BASH_SIMPLE
  const bytes = []
  const text = (value) => { for (const b of encodeUtf8Loose(value)) bytes.push(b) }
  const result = (stop) => ({ text: decodeUtf8(Uint8Array.from(bytes)), stop })
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\' || i + 1 >= s.length) {
      const next = s.indexOf('\\', i + 1)
      const end = next < 0 ? s.length : next
      text(s.slice(i, end)); i = end - 1; continue
    }
    const c = s[++i]
    if (c === 'c') return result(true)
    if (c in simple) { bytes.push(simple[c]); continue }
    // `\0` takes up to three octal digits after it; coreutils also reads
    // `\1` to `\7` as the first of up to three.
    if (c === '0' || (coreutils && /[1-7]/u.test(c))) {
      let digits = c === '0' ? '' : c
      while (digits.length < 3 && /[0-7]/u.test(s[i + 1] ?? '')) digits += s[++i]
      bytes.push(digits === '' ? 0 : parseInt(digits, 8) & 255)
      continue
    }
    const hexLen = c === 'x' ? 2 : coreutils ? 0 : c === 'u' ? 4 : c === 'U' ? 8 : 0
    if (hexLen > 0 && /[0-9a-fA-F]/u.test(s[i + 1] ?? '')) {
      let digits = ''
      while (digits.length < hexLen && /[0-9a-fA-F]/u.test(s[i + 1] ?? '')) digits += s[++i]
      const code = parseInt(digits, 16)
      if (c === 'x') bytes.push(code)
      else {
        if (!isUnicodeScalar(code)) throw new UnsupportedError('feature', 'echo Unicode escape', 'echo: escapes outside Unicode scalar values are not supported')
        text(String.fromCodePoint(code))
      }
      continue
    }
    const end = i + stepAt(s, i)
    text('\\' + s.slice(i, end))
    i = end - 1
  }
  return result(false)
}
