// The tokenizer's lexical helpers: the boundary operators and redirect
// spellings, the two kinds of `$` reference, ANSI-C `$'…'` decoding,
// and here-document body collection. tokenize.js drives the character
// loop and the quoting state; everything here reads at a position it
// is handed and reports what it found.

import { UnsupportedError } from './unsupported.js'

// Shell variable names: `[A-Za-z_][A-Za-z0-9_]*`, written once. The
// anchored form validates a whole string (`for`'s loop variable, in
// parse.js); the sticky form scans in place from a given offset.
const NAME = '[A-Za-z_][A-Za-z0-9_]*'
export const NAME_RE = new RegExp(`^${NAME}$`, 'u')
const NAME_AT = new RegExp(NAME, 'uy')

// The one-character special parameters bash knows: `$?` (last status),
// `$#` `$@` `$*` and the positional `$1`…`$9` (there are no positional
// parameters here, so they expand to nothing), and `$$` `$!` `$0` `$-`
// `$_`, which name process facts this terminal does not have.
const SPECIAL = /[?#@*$!0-9-]/u
const SPECIAL_UNDERSCORE = '_'

// The reference starting at the `$` at `line[i]`, or null when what
// follows is not one: `$NAME`, `${NAME}`, or a special parameter. `raw`
// is the source text, kept so an unexpanded form can be echoed back
// exactly as typed. Anything else after `${` is a parameter-expansion
// operator this shell does not implement (`${x%.js}`, `${#x}`,
// `${x:-d}`), reported as such rather than passed through as text.
export function readRef(line, i) {
  const braced = line[i + 1] === '{'
  const at = braced ? i + 2 : i + 1
  const c = line[at]
  if (!braced && c !== undefined && (SPECIAL.test(c) || (c === SPECIAL_UNDERSCORE && !/[A-Za-z0-9_]/u.test(line[at + 1] ?? '')))) {
    return { name: c, raw: line.slice(i, at + 1) }
  }
  NAME_AT.lastIndex = at
  const m = NAME_AT.exec(line)
  if (!braced) return m ? { name: m[0], raw: line.slice(i, NAME_AT.lastIndex) } : null
  if (m && line[NAME_AT.lastIndex] === '}') return { name: m[0], raw: line.slice(i, NAME_AT.lastIndex + 1) }
  if (c !== undefined && SPECIAL.test(c) && line[at + 1] === '}') return { name: c, raw: line.slice(i, at + 2) }
  const shown = line.slice(i, line.indexOf('}', i) + 1 || undefined).slice(0, 20)
  throw new UnsupportedError('feature', '${', `parameter expansion operators are not supported (\`${shown}\`); only \`$NAME\` and \`\${NAME}\` expand`)
}

// The `$` at `line[i]`: the reference it starts (see readRef), null
// when it is a literal dollar, or a refusal for the substitutions this
// shell lacks — `$(…)`, `$((…))` and `$[…]` — raised wherever bash would
// expand them: a bare or double-quoted word, an unquoted here-document.
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

// `$'…'`: bash's ANSI-C quoting. Returns the decoded text and the index
// just past the closing quote.
const ANSI_SIMPLE = { a: '\u0007', b: '\b', e: '\u001B', E: '\u001B', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }

export function decodeAnsiC(line, start) {
  let out = ''
  let i = start
  for (; i < line.length && line[i] !== "'"; i++) {
    if (line[i] !== '\\') { out += line[i]; continue }
    const n = line[i + 1]
    if (n === undefined) { out += '\\'; continue }
    if (n in ANSI_SIMPLE) { out += ANSI_SIMPLE[n]; i++; continue }
    const numeric = /^(?:[0-7]{1,3}|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8})/u.exec(line.slice(i + 1))
    if (numeric) {
      const digits = numeric[0]
      const code = /^[0-7]/u.test(digits) ? parseInt(digits, 8) : parseInt(digits.slice(1), 16)
      out += code <= 0x10FFFF ? String.fromCodePoint(code) : '�'
      i += digits.length
      continue
    }
    if (n === 'c' && line[i + 2] !== undefined && line[i + 2] !== "'") {
      out += String.fromCodePoint(line[i + 2].toUpperCase().codePointAt(0) ^ 0x40)
      i += 2
      continue
    }
    out += '\\'
  }
  if (i >= line.length) throw new Error('unterminated single quote')
  return { text: out, end: i + 1 }
}

// The boundary token starting at `line[i]`, or null when the character
// is not one. Each returns the token plus the index just past it. `(` /
// `)` are boundaries mid-word the same way `;` / `|` are, so `(echo a)`
// and `( echo a )` produce identical token streams.
//
// A run of digits directly before `>` or `<` at a word boundary is a
// file-descriptor prefix (`2>`, `12>`), which is why the caller passes
// `atWordStart`: `cat2>foo` keeps `cat2` as one word and only `>` is
// the redirect.
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
      if (two === '&>') return { token: { kind: 'redir', fd: 1, op: line[i + 2] === '>' ? 'bothAppend' : 'both' }, end: line[i + 2] === '>' ? i + 3 : i + 2 }
      return tok('amp', i + 1)
    case ';': return two === ';;' ? tok('dsemi', i + 2) : tok('semi', i + 1)
    case '(': return tok('paren_open', i + 1)
    case ')': return tok('paren_close', i + 1)
    case '<': case '>': return readRedirect(line, i, c === '<' ? 0 : 1)
    default: return null
  }
}

const tok = (kind, end) => ({ token: { kind }, end })

// The redirect operator whose `<` or `>` sits at `line[i]`, for file
// descriptor `fd` (explicit `N>`, or the operator's own default).
function readRedirect(line, i, fd) {
  const c = line[i]
  const n = line[i + 1]
  if (n === '(') throw new UnsupportedError('feature', `${c}(`, `process substitution (\`${c}(…)\`) is not supported`)
  if (n === '&') return readDup(line, i + 1, fd, c === '<' ? '<&' : `${fd === 1 && c === '>' ? '' : fd}>&`)
  if (c === '<') {
    if (line.slice(i, i + 3) === '<<<') return { token: { kind: 'redir', fd, op: 'herestring' }, end: i + 3 }
    if (n === '<') {
      const strip = line[i + 2] === '-'
      return { token: { kind: 'redir', fd, op: 'heredoc', strip, delim: null, body: null }, end: i + (strip ? 3 : 2) }
    }
    return { token: { kind: 'redir', fd, op: 'read' }, end: i + 1 }
  }
  if (n === '>') return { token: { kind: 'redir', fd, op: 'append' }, end: i + 2 }
  if (n === '|') return { token: { kind: 'redir', fd, op: 'write' }, end: i + 2 }
  return { token: { kind: 'redir', fd, op: 'write' }, end: i + 1 }
}

// `N>&M` / `N<&M` fd duplication and the `N>&-` close form. The target
// must be followed by end-of-input or a delimiter so `2>&1foo` (which
// the user wrote as one token) doesn't silently split into a fd-dup
// plus a stray word.
function readDup(line, ampAt, fd, label) {
  const target = line[ampAt + 1]
  const after = line[ampAt + 2]
  const boundary = after === undefined || /[\s|&>;()<]/u.test(after)
  if (/[0-9]/u.test(target ?? '') && boundary) return { token: { kind: 'redir', fd, op: 'dup', toFd: Number(target) }, end: ampAt + 2 }
  if (target === '-' && boundary) return { token: { kind: 'redir', fd, op: 'close' }, end: ampAt + 2 }
  throw new Error(`redirect \`${label}\` requires a file descriptor number (or \`-\`) followed by a token boundary`)
}

// Here-document bodies. Called at the newline that ends the line the
// `<<` operators appeared on: each pending heredoc, in order, takes the
// following lines up to (not including) its delimiter line. With an
// unquoted delimiter a backslash-newline joins the next physical line
// on first — so `EO\⏎F` closes an `EOF` heredoc, as in bash. `<<-`
// then strips leading tabs from the (joined) line. Returns the index of
// the newline that ended the last delimiter line, or the end of input
// when a body ran out of text (bash warns and takes what it got; here
// the same).
export function readHeredocBodies(line, newlineAt, pending) {
  let i = newlineAt + 1
  for (const h of pending) {
    const lines = []
    while (i <= line.length) {
      let end = line.indexOf('\n', i)
      let text = line.slice(i, end === -1 ? line.length : end)
      i = (end === -1 ? line.length : end) + 1
      while (!h.quotedDelim && end !== -1 && continues(text)) {
        end = line.indexOf('\n', i)
        text = text.slice(0, -1) + line.slice(i, end === -1 ? line.length : end)
        i = (end === -1 ? line.length : end) + 1
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
