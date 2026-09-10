// Lexical helpers for operators, parameter references, ANSI-C quotes and
// here-document bodies. tokenize.js owns the cursor and quoting state.

import { decodeUtf8, encodeUtf8Loose } from '../util.js'
import { UnsupportedError } from '../unsupported.js'
import { readCommandSubstitution } from './substitution.js'
import { isUnicodeScalar } from '../unicode.js'
import { readArithmeticExpansion, readBracedExpansion } from './expansion-scan.js'
import { readConditional } from './conditional-lex.js'

export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u
const NAME_CHAR = /[A-Za-z0-9_]/u

// Process parameters are lexed here; expand.js reports their missing state.
const SPECIAL = /[?#@*$!0-9-]/u

// Lookahead follows shell_getc(1): continuations disappear before token
// recognition, while offsets still refer to the original source.
export function skipContinuations(line, at) {
  while (line[at] === '\\' && line[at + 1] === '\n') at += 2
  return at
}

// Tokenization scans raw source; expansion additionally supplies its quote
// mask. A reference cannot cross a mask boundary ("$x"y names x, not xy).
export function scanRef(line, i, mask = null) {
  const same = (j) => j < line.length && (mask === null || mask[j] === mask[i])
  if (!same(i + 1)) return null
  const c = line[i + 1]
  if (SPECIAL.test(c)) return { name: c, raw: line.slice(i, i + 2) }
  if (!/[A-Za-z_]/u.test(c)) return null
  let j = i + 2
  while (same(j) && NAME_CHAR.test(line[j])) j++
  return { name: line.slice(i + 1, j), raw: line.slice(i, j) }
}

// Called wherever substitution is active, including unquoted here-documents.
export function readExpansion(line, i, depth = 0, quoted = false, options = {}) {
  const nested = (source, at, level, inQuotes) => readExpansion(source, at, level, inQuotes, options)
  const next = skipContinuations(line, i + 1)
  const n = line[next]
  if (n === '(') {
    const second = skipContinuations(line, next + 1)
    if (line[second] === '(') return readArithmeticExpansion(line, i, second, depth, { readExpansion: nested })
    const result = readCommandSubstitution(line, i, next, depth, { readExpansion: nested, decodeAnsiC, readHeredocBodies, readOperator, readConditional, skipContinuations })
    options.validateSubstitution?.(result.command)
    return result
  }
  if (n === '{') return readBracedExpansion(line, i, next, depth, quoted, { readExpansion: nested, decodeAnsiC })
  if (n === '[') throw new UnsupportedError('feature', '$[', 'arithmetic expansion (`$[…]`) is not supported')
  return scanRef(line, i)
}

// A backtick outside single quotes opens the other command substitution.
export const backtickGap = () => new UnsupportedError('feature', '`', 'command substitution (backticks) is not supported')

// ANSI-C quoting decodes through bytes. NUL ends the result, but scanning must
// continue to the closing quote: $'a\0b' is 'a', not an unterminated string.
const ANSI_SIMPLE = { a: '\u0007', b: '\b', e: '\u001B', E: '\u001B', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }

// Quote boundaries follow source escapes, independently of how \c consumes them.
function ansiQuoteEnd(line, start) {
  for (let i = start; i < line.length; i++) {
    if (line[i] === '\\') i++
    else if (line[i] === "'") return i
  }
  throw new Error('unterminated single quote')
}

export function decodeAnsiC(line, start) {
  const end = ansiQuoteEnd(line, start)
  const bytes = []
  const text = (s) => { for (const b of encodeUtf8Loose(s)) bytes.push(b) }
  for (let i = start; i < end; i++) {
    if (line[i] !== '\\') {
      const ch = String.fromCodePoint(line.codePointAt(i))
      text(ch); i += ch.length - 1; continue
    }
    const n = line[i + 1]
    if (n in ANSI_SIMPLE) { text(ANSI_SIMPLE[n]); i++; continue }
    if (n === 'x' && line[i + 2] === '{') throw new UnsupportedError('feature', 'ANSI-C hexadecimal escape', 'braced hexadecimal escapes in ANSI-C quotes are not supported')
    const numeric = /^(?:[0-7]{1,3}|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8})/u.exec(line.slice(i + 1, end))
    if (numeric) {
      const digits = numeric[0]
      const octal = /^[0-7]/u.test(digits)
      const code = octal ? parseInt(digits, 8) : parseInt(digits.slice(1), 16)
      if (octal || digits[0] === 'x') bytes.push(code & 255)
      else {
        if (!isUnicodeScalar(code)) throw new UnsupportedError('feature', 'ANSI-C Unicode escape', 'ANSI-C escapes outside Unicode scalar values are not supported')
        text(String.fromCodePoint(code))
      }
      i += digits.length
      continue
    }
    if (n === 'c' && i + 2 < end) {
      const control = line.codePointAt(i + 2)
      if (control > 127) throw new UnsupportedError('feature', 'ANSI-C control escape', 'ANSI-C control escapes require an ASCII character')
      bytes.push(control === 63 ? 127 : control & 31)
      i += 2
      if (control === 92 && line[i + 1] === '\\') i++
      continue
    }
    text('\\')
  }
  const nul = bytes.indexOf(0)
  return { text: decodeUtf8(Uint8Array.from(nul === -1 ? bytes : bytes.slice(0, nul))), end: end + 1 }
}

// Parentheses delimit even mid-word. A descriptor prefix is recognized only
// at a word boundary: cat2>foo contains the word cat2 and an ordinary '>'.
export function readOperator(line, i, atWordStart) {
  const c = line[i]
  if (atWordStart && /[0-9]/u.test(c)) {
    let digits = '', j = i
    while (/[0-9]/u.test(line[j] ?? '')) {
      digits += line[j]
      j = skipContinuations(line, j + 1)
    }
    if (line[j] !== '>' && line[j] !== '<') return null
    return readRedirect(line, j, Number(digits))
  }
  const next = skipContinuations(line, i + 1)
  const n = line[next]
  switch (c) {
    case '|': return n === '|' ? tok('or', next + 1) : n === '&' ? tok('pipe_err', next + 1) : tok('pipe', i + 1)
    case '&':
      if (n === '&') return tok('and', next + 1)
      if (n === '>') {
        const third = skipContinuations(line, next + 1)
        const append = line[third] === '>'
        return redir(1, append ? 'bothAppend' : 'both', (append ? third : next) + 1)
      }
      return tok('amp', i + 1)
    case ';': return n === ';' ? tok('dsemi', next + 1) : tok('semi', i + 1)
    case '(': return tok('paren_open', i + 1)
    case ')': return tok('paren_close', i + 1)
    case '<': case '>': return readRedirect(line, i, c === '<' ? 0 : 1)
    default: return null
  }
}

const tok = (kind, end) => ({ token: { kind }, end })
const redir = (fd, op, end, fields) => ({ token: { kind: 'redir', fd, op, ...fields }, end })

function readRedirect(line, i, fd) {
  const c = line[i]
  const next = skipContinuations(line, i + 1)
  const n = line[next]
  if (n === '(') throw new UnsupportedError('feature', `${c}(`, `process substitution (\`${c}(…)\`) is not supported`)
  if (n === '&') return readDup(line, next, fd, c === '<' ? '<&' : `${fd === 1 && c === '>' ? '' : fd}>&`)
  if (c === '<') {
    if (n === '>') throw new UnsupportedError('feature', '<>', 'read/write file redirects are not supported')
    if (n === '<') {
      const third = skipContinuations(line, next + 1)
      if (line[third] === '<') return redir(fd, 'herestring', third + 1)
      const strip = line[third] === '-'
      return redir(fd, 'heredoc', (strip ? third : next) + 1, { strip, delim: null, body: null })
    }
    return redir(fd, 'read', i + 1)
  }
  if (n === '>') return redir(fd, 'append', next + 1)
  return redir(fd, 'write', (n === '|' ? next : i) + 1)
}

// `N>&M` / `N<&M` fd duplication and the `N>&-` close form. The target
// must be followed by end-of-input or a delimiter so `2>&1foo` (which
// the user wrote as one token) doesn't silently split into a fd-dup
// plus a stray word.
function readDup(line, ampAt, fd, label) {
  const targetAt = skipContinuations(line, ampAt + 1)
  const target = line[targetAt]
  const after = line[skipContinuations(line, targetAt + 1)]
  const boundary = after === undefined || /[ \t\n|&>;()<]/u.test(after)
  if (/[0-9]/u.test(target ?? '') && boundary) return redir(fd, 'dup', targetAt + 1, { toFd: Number(target) })
  if (target === '-' && boundary) return redir(fd, 'close', targetAt + 1)
  throw new UnsupportedError('feature', 'redirect target', `redirect \`${label}\` requires a file descriptor number (or \`-\`) followed by a token boundary`)
}

// Consume pending here-documents in order. Unquoted delimiters join escaped
// newlines before comparison; <<- strips tabs after joining. The returned
// cursor is the final delimiter newline, or end of input for an unfinished
// body (which retains the collected text).
export function readHeredocBodies(line, newlineAt, pending) {
  let i = newlineAt + 1
  for (const h of pending) {
    const lines = []
    let terminated = false
    while (i < line.length) {
      let end, text = ''
      for (;;) {
        end = line.indexOf('\n', i)
        const stop = end === -1 ? line.length : end
        text += line.slice(i, stop)
        i = stop + 1
        if (h.quotedDelim || end === -1 || !continues(text)) break
        text = text.slice(0, -1)
      }
      if (end === -1 && text === '') break
      if (h.strip) text = text.replace(/^\t+/u, '')
      if (text === h.delim) { terminated = true; break }
      lines.push(text)
      if (end === -1) break
    }
    h.body = lines.length === 0 ? '' : lines.join('\n') + '\n'
    if (!terminated) h.warning = `warning: here-document delimited by end-of-file (wanted \`${h.delim}')\n`
  }
  return i - 1
}

// A line ending in an odd number of backslashes: the last one escapes
// the newline (`a\\` ends in an escaped backslash instead).
function continues(text) {
  let n = 0
  while (n < text.length && text[text.length - 1 - n] === '\\') n++
  return n % 2 === 1
}
