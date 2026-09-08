// Lexical helpers for operators, parameter references, ANSI-C quotes and
// here-document bodies. tokenize.js owns the cursor and quoting state.

import { utf8, utf8Decoder } from '../util.js'
import { UnsupportedError } from '../unsupported.js'

export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u
const NAME_CHAR = /[A-Za-z0-9_]/u

// Process parameters are lexed here; expand.js reports their missing state.
const SPECIAL = /[?#@*$!0-9-]/u

// Keep references as source text for expansion. Unsupported braced operators
// must be diagnosed instead of surviving as plausible literal arguments.
export function readRef(line, i) {
  const ref = scanRef(line, i)
  if (ref || line[i + 1] !== '{') return ref
  const shown = line.slice(i, line.indexOf('}', i) + 1 || undefined).slice(0, 20)
  throw new UnsupportedError('feature', '${', `parameter expansion operators are not supported (\`${shown}\`); only \`$NAME\` and \`\${NAME}\` expand`)
}

// Tokenization scans raw source; expansion additionally supplies its quote
// mask. A reference cannot cross a mask boundary ("$x"y names x, not xy).
export function scanRef(line, i, mask = null) {
  const same = (j) => j < line.length && (mask === null || mask[j] === mask[i])
  if (line[i + 1] === '{') {
    let j = i + 2
    while (same(j) && line[j] !== '}') j++
    if (!same(j)) return null
    const name = line.slice(i + 2, j)
    return NAME_RE.test(name) || (name.length === 1 && SPECIAL.test(name)) ? { name, raw: line.slice(i, j + 1) } : null
  }
  if (!same(i + 1)) return null
  const c = line[i + 1]
  if (SPECIAL.test(c)) return { name: c, raw: line.slice(i, i + 2) }
  if (!/[A-Za-z_]/u.test(c)) return null
  let j = i + 2
  while (same(j) && NAME_CHAR.test(line[j])) j++
  return { name: line.slice(i + 1, j), raw: line.slice(i, j) }
}

// Called wherever substitution is active, including unquoted here-documents.
export function readExpansion(line, i) {
  const n = line[i + 1]
  if (n === '(') {
    if (line[i + 2] === '(') throw new UnsupportedError('feature', '$((', 'arithmetic expansion (`$((…))`) is not supported')
    throw new UnsupportedError('feature', '$(', 'command substitution (`$(…)`) is not supported')
  }
  if (n === '[') throw new UnsupportedError('feature', '$[', 'arithmetic expansion (`$[…]`) is not supported')
  return readRef(line, i)
}

// A backtick outside single quotes opens the other command substitution.
export const backtickGap = () => new UnsupportedError('feature', '`', 'command substitution (backticks) is not supported')

// ANSI-C quoting decodes through bytes. NUL ends the result, but scanning must
// continue to the closing quote: $'a\0b' is 'a', not an unterminated string.
const ANSI_SIMPLE = { a: '\u0007', b: '\b', e: '\u001B', E: '\u001B', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }

export function decodeAnsiC(line, start) {
  const bytes = []
  const text = (s) => { for (const b of utf8.encode(s)) bytes.push(b) }
  let i = start
  for (; i < line.length && line[i] !== "'"; i++) {
    if (line[i] !== '\\') {
      const ch = String.fromCodePoint(line.codePointAt(i))
      text(ch); i += ch.length - 1; continue
    }
    const n = line[i + 1]
    if (n === undefined) { text('\\'); continue }
    if (n in ANSI_SIMPLE) { text(ANSI_SIMPLE[n]); i++; continue }
    const numeric = /^(?:[0-7]{1,3}|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8})/u.exec(line.slice(i + 1))
    if (numeric) {
      const digits = numeric[0]
      const octal = /^[0-7]/u.test(digits)
      const code = octal ? parseInt(digits, 8) : parseInt(digits.slice(1), 16)
      if (octal || digits[0] === 'x') bytes.push(code & 255)
      else {
        if (code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) throw new UnsupportedError('feature', 'ANSI-C Unicode escape', 'ANSI-C escapes outside Unicode scalar values are not supported')
        text(String.fromCodePoint(code))
      }
      i += digits.length
      continue
    }
    if (n === 'c' && line[i + 2] !== undefined && line[i + 2] !== "'") {
      bytes.push(line[i + 2].toUpperCase().codePointAt(0) ^ 0x40)
      i += 2
      continue
    }
    text('\\')
  }
  if (i >= line.length) throw new Error('unterminated single quote')
  const nul = bytes.indexOf(0)
  return { text: utf8Decoder.decode(Uint8Array.from(nul === -1 ? bytes : bytes.slice(0, nul))), end: i + 1 }
}

// Parentheses delimit even mid-word. A descriptor prefix is recognized only
// at a word boundary: cat2>foo contains the word cat2 and an ordinary '>'.
export function readOperator(line, i, atWordStart) {
  const c = line[i]
  if (atWordStart && /[0-9]/u.test(c)) {
    let j = i
    while (/[0-9]/u.test(line[j] ?? '')) j++
    if (line[j] !== '>' && line[j] !== '<') return null
    return readRedirect(line, j, Number(line.slice(i, j)))
  }
  const two = line.slice(i, i + 2)
  switch (c) {
    case '|': return two === '||' ? tok('or', i + 2) : two === '|&' ? tok('pipe_err', i + 2) : tok('pipe', i + 1)
    case '&':
      if (two === '&&') return tok('and', i + 2)
      if (two === '&>') {
        const append = line[i + 2] === '>'
        return redir(1, append ? 'bothAppend' : 'both', i + (append ? 3 : 2))
      }
      return tok('amp', i + 1)
    case ';': return two === ';;' ? tok('dsemi', i + 2) : tok('semi', i + 1)
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
  const n = line[i + 1]
  if (n === '(') throw new UnsupportedError('feature', `${c}(`, `process substitution (\`${c}(…)\`) is not supported`)
  if (n === '&') return readDup(line, i + 1, fd, c === '<' ? '<&' : `${fd === 1 && c === '>' ? '' : fd}>&`)
  if (c === '<') {
    if (n === '>') throw new UnsupportedError('feature', '<>', 'read/write file redirects are not supported')
    if (line.slice(i, i + 3) === '<<<') return redir(fd, 'herestring', i + 3)
    if (n === '<') {
      const strip = line[i + 2] === '-'
      return redir(fd, 'heredoc', i + (strip ? 3 : 2), { strip, delim: null, body: null })
    }
    return redir(fd, 'read', i + 1)
  }
  if (n === '>') return redir(fd, 'append', i + 2)
  return redir(fd, 'write', i + (n === '|' ? 2 : 1))
}

// `N>&M` / `N<&M` fd duplication and the `N>&-` close form. The target
// must be followed by end-of-input or a delimiter so `2>&1foo` (which
// the user wrote as one token) doesn't silently split into a fd-dup
// plus a stray word.
function readDup(line, ampAt, fd, label) {
  const target = line[ampAt + 1]
  const after = line[ampAt + 2]
  const boundary = after === undefined || /[\s|&>;()<]/u.test(after)
  if (/[0-9]/u.test(target ?? '') && boundary) return redir(fd, 'dup', ampAt + 2, { toFd: Number(target) })
  if (target === '-' && boundary) return redir(fd, 'close', ampAt + 2)
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
    while (i <= line.length) {
      let end, text = ''
      for (;;) {
        end = line.indexOf('\n', i)
        const stop = end === -1 ? line.length : end
        text += line.slice(i, stop)
        i = stop + 1
        if (h.quotedDelim || end === -1 || !continues(text)) break
        text = text.slice(0, -1)
      }
      if (h.strip) text = text.replace(/^\t+/u, '')
      if (text === h.delim) break
      lines.push(text)
      if (end === -1) break
    }
    h.body = lines.length === 0 ? '' : lines.join('\n') + '\n'
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
