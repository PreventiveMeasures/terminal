// GNU sed's reader of a script (compile.c): a character at a time, pushing
// one back where it looked ahead, so that a fault is reported where GNU's
// reader stood — `-e expression #N, char M`, counting the bytes of that
// expression read so far, or `file F line L` for a script file. Faults
// found once every script is read are at char 0 of the last expression,
// since GNU's reader has let go of it by then.

import { encodeUtf8 } from '../util.js'
import { panic, scriptGap } from './sed-common.js'
import { compileRegex } from './sed-regex.js'

export const MESSAGES = {
  BAD_BANG: "multiple `!'s",
  BAD_COMMA: "unexpected `,'",
  BAD_STEP: 'invalid usage of +N or ~N as first address',
  EXCESS_OPEN_BRACE: "unmatched `{'",
  EXCESS_CLOSE_BRACE: "unexpected `}'",
  EXCESS_JUNK: 'extra characters after command',
  EXPECTED_SLASH: "expected \\ after `a', `c' or `i'",
  NO_CLOSE_BRACE_ADDR: "`}' doesn't want any addresses",
  NO_COLON_ADDR: ": doesn't want any addresses",
  NO_SHARP_ADDR: "comments don't accept any addresses",
  NO_COMMAND: 'missing command',
  ONE_ADDR: 'command only uses one address',
  UNTERM_ADDR_RE: 'unterminated address regex',
  UNTERM_S_CMD: "unterminated `s' command",
  UNTERM_Y_CMD: "unterminated `y' command",
  UNKNOWN_S_OPT: "unknown option to `s'",
  EXCESS_P_OPT: "multiple `p' options to `s' command",
  EXCESS_G_OPT: "multiple `g' options to `s' command",
  EXCESS_N_OPT: "multiple number options to `s' command",
  ZERO_N_OPT: "number option to `s' command may not be zero",
  Y_CMD_LEN: "strings for `y' command are different lengths",
  BAD_DELIM: 'delimiter character is not a single-byte character',
  ANCIENT_VERSION: 'expected newer version of sed',
  INVALID_LINE_0: 'invalid usage of line address 0',
  COLON_LACKS_LABEL: '":" lacks a label',
  RECURSIVE_ESCAPE_C: 'recursive escaping after \\c not allowed',
  DISALLOWED: 'e/r/w commands disabled in sandbox mode',
  MISSING_FILENAME: 'missing filename in r/R/w/W commands',
  BAD_MODIF: 'cannot specify modifiers on empty regexp',
}

export const EOF = undefined
export const isBlank = (c) => c === ' ' || c === '\t'
export const isSpace = (c) => isBlank(c) || c === '\n' || c === '\v' || c === '\f' || c === '\r'
export const isDigit = (c) => c !== EOF && c >= '0' && c <= '9'
export const ascii = (c) => c.codePointAt(0) <= 0x7f

// Where the reader is: a byte offset into an expression, or a line of a file.
// `partial` is the middle of a character, of which GNU had read one byte.
export function where(src, partial = false) {
  const read = src.done ? src.text : src.text.slice(0, src.i)
  if (src.name !== null) return { name: src.name, line: read.split('\n').length }
  if (src.done) return { expression: src.expression, char: 0 }
  return { expression: src.expression, char: partial ? encodeUtf8(read.slice(0, -1)).length + 1 : encodeUtf8(read).length }
}

export function located(at, why) {
  const prefix = at.name === undefined ? `-e expression #${at.expression}, char ${at.char}` : `file ${at.name} line ${at.line}`
  return Object.assign(new Error(`${prefix}: ${why}`), { exitCode: 1 })
}

export function bad(c, why, partial = false) { throw located(where(c.src, partial), why) }

// A fault in the character just read: GNU has read one byte of it.
export function badHere(c, why) {
  const { text, i } = c.src
  bad(c, why, i > 0 && !ascii(text[i - 1]))
}

export const inchar = (src) => (src.i < src.text.length ? src.text[src.i++] : EOF)
export const savchar = (src, ch) => { if (ch !== EOF) src.i-- }

export function inNonblank(src) {
  let ch
  do ch = inchar(src); while (isBlank(ch))
  return ch
}

// in_integer, into GNU's unsigned long.
export function inInteger(src, first) {
  let num = 0n
  let ch = first
  while (isDigit(ch)) {
    num = BigInt.asUintN(64, num * 10n + BigInt(ch.codePointAt(0) - 48))
    ch = inchar(src)
  }
  savchar(src, ch)
  return num
}

export function safeNumber(n, detail) {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) scriptGap(detail)
  return Number(n)
}

export function readEndOfCmd(c) {
  const ch = inNonblank(c.src)
  if (ch === '}' || ch === '#') savchar(c.src, ch)
  else if (ch !== EOF && ch !== '\n' && ch !== ';') badHere(c, MESSAGES.EXCESS_JUNK)
}

export function readLabel(src) {
  let label = ''
  let ch = inNonblank(src)
  while (ch !== EOF && ch !== '\n' && !isBlank(ch) && ch !== ';' && ch !== '}' && ch !== '#') {
    label += ch
    ch = inchar(src)
  }
  savchar(src, ch)
  // Labels are C strings: a NUL ends one.
  return label.split('\0', 1)[0]
}

export function readFilename(c) {
  if (c.sandbox) bad(c, MESSAGES.DISALLOWED)
  let name = ''
  let ch = inNonblank(c.src)
  while (ch !== EOF && ch !== '\n') {
    name += ch
    ch = inchar(c.src)
  }
  return name.split('\0', 1)[0]
}

export function openFile(c, mode) {
  const name = readFilename(c)
  if (!name) bad(c, MESSAGES.MISSING_FILENAME)
  return mode === 'write' ? c.openWrite(name) : c.openRead(name)
}

// match_slash: the text up to an unescaped delimiter, which a bracket in a
// regex does not end. `\` before the delimiter or a newline is dropped, and
// in a regex `\n` stays for the regex reader; anything else keeps its `\`.
export function matchSlash(c, slash, regex) {
  const src = c.src
  if (slash !== EOF && !ascii(slash)) bad(c, MESSAGES.BAD_DELIM, true)
  let text = ''
  let ch
  while ((ch = inchar(src)) !== EOF && ch !== '\n') {
    if (ascii(ch)) {
      if (ch === slash) return text
      if (ch === '\\') {
        ch = inchar(src)
        if (ch === EOF) break
        if (ch !== '\n' && (ch !== slash || (!regex && ch === '&'))) text += '\\'
      } else if (ch === '[' && regex) {
        const bracket = snarfCharClass(src)
        text += ch + bracket.text
        ch = bracket.end
        if (ch !== ']') break
      }
    }
    text += ch
  }
  if (ch === '\n') savchar(src, ch)
  return null
}

// snarf_char_class: a bracket's members up to its `]`, `[:`, `[.` and `[=`
// elements whole. A backslash is a member like any other.
function snarfCharClass(src) {
  let text = ''
  let ch = inchar(src)
  if (ch === '^') { text += ch; ch = inchar(src) }
  if (ch === ']') { text += ch; ch = inchar(src) }
  let delim, state = 0
  for (;; text += ch, ch = inchar(src)) {
    if (ch === EOF || ch === '\n') return { text, end: ch }
    if (ch === '.' || ch === ':' || ch === '=') {
      if (state === 1) { delim = ch; state = 2; continue }
      if (state === 2 && ch === delim) { state = 3; continue }
    } else if (ch === '[') {
      if (state === 0) state = 1
      continue
    } else if (ch === ']') {
      if (state === 0 || state === 1) return { text, end: ch }
      if (state === 3) state = 0
    }
    state &= ~1
  }
}

// compile_regex: an empty regex is the last one used, and takes no flags.
export function compileRegexHere(c, pattern, flags, neededSub) {
  if (pattern === '') {
    if (flags.icase || flags.multiline) bad(c, MESSAGES.BAD_MODIF)
    return null
  }
  const result = compileRegex(pattern, {
    extended: c.extended, icase: flags.icase, locale: c.locale, neededSub,
    recursive: () => bad(c, MESSAGES.RECURSIVE_ESCAPE_C),
  })
  if (result.error) bad(c, result.error)
  if (result.panic) throw panic(result.panic)
  return result.regex
}

// glibc's strverscmp, for `v`: digits compare as numbers, and a run of
// leading zeros as a fraction.
const VERSION_NEXT = [0, 3, 9, 0, 3, 3, 0, 6, 6, 0, 6, 9]
const VERSION_RESULT = [
  2, 2, 2, 2, 3, 2, 2, 2, 2,
  2, -1, -1, 1, 3, 3, 1, 3, 3,
  2, 2, 2, 2, 2, 2, 2, 2, 2,
  2, 1, 1, -1, 2, 2, -1, 2, 2,
]

export function strverscmp(a, b) {
  const s1 = encodeUtf8(a), s2 = encodeUtf8(b)
  const at = (s, i) => s[i] ?? 0
  const digit = (ch) => ch >= 48 && ch <= 57
  const kind = (ch) => (ch === 48 ? 1 : 0) + (digit(ch) ? 1 : 0)
  let i = 0
  let c1 = at(s1, i), c2 = at(s2, i++)
  let state = kind(c1)
  let diff
  while ((diff = c1 - c2) === 0) {
    if (c1 === 0) return 0
    state = VERSION_NEXT[state]
    c1 = at(s1, i)
    c2 = at(s2, i++)
    state += kind(c1)
  }
  const result = VERSION_RESULT[state * 3 + kind(c2)]
  if (result === 2) return diff
  if (result !== 3) return result
  let j1 = i, j2 = i
  while (digit(at(s1, j1++))) {
    if (!digit(at(s2, j2++))) return 1
  }
  return digit(at(s2, j2)) ? -1 : diff
}
