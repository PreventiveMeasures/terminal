// Tokenizer for the virtual shell: turns one command line into the
// flat token stream parse.js structures into steps. The lexical helpers
// (operators, redirects, `$` references, `$'…'`, heredoc bodies) live
// in lex.js; this file owns the character loop and the quoting state.
//
// Token kinds:
//   word         — `{ value, mask, quoted }`. `value` is the word's text
//                  with quotes removed and escapes applied — what the
//                  command would receive if nothing else expanded. `mask`
//                  records, per character, how it was quoted, and is
//                  what the expanders read: `0` bare, `1` hard-quoted
//                  (single quotes, a backslash, `$'…'`), `2` inside
//                  double quotes, where `$NAME` still expands but the
//                  result is neither split nor globbed. A word with no
//                  quoting at all carries `mask: null`. `quoted` is true
//                  when any part of the word was quoted, which is what
//                  keeps `"for"` from being the keyword.
//   pipe / pipe_err / and / or / semi / dsemi / amp
//                — `|`, `|&`, `&&`, `||`, `;` (an unquoted newline also
//                  becomes `semi`), `;;`, `&`
//   paren_open / paren_close
//                — `(` / `)`; a `(` directly after another carries
//                  `adjacent: true` so `((` can be told from `( (`
//   redir        — `{ fd, op, … }`: see lex.js's readOperator
//
// Comments: an unquoted `#` at the start of a word runs to the end of
// the line, as in bash; `a#b` is one word.
//
// Backslashes: outside quotes `\x` is a literal `x` (and `\<newline>` is
// a line continuation); inside double quotes only `\$`, `\\`, `` \` ``,
// `\"` and `\<newline>` are escapes, everything else keeps its
// backslash, both as bash does.
//
// What is refused here, with an UnsupportedError that names the
// construct: command substitution (`$(…)` and backticks), arithmetic
// (`$((…))`, `$[…]`), process substitution (`<(…)`, `>(…)`) and the
// parameter-expansion operators (`${x%.js}` and friends).

import { NAME_RE, decodeAnsiC, readHeredocBodies, readOperator, readRef } from './lex.js'
import { UnsupportedError } from './unsupported.js'

export { NAME_RE }

// A newline after one of these boundary tokens contributes nothing:
// the separator already exists (`;`) or the operator still needs its
// right-hand operand, so the command continues on the next line
// (`|` / `&&` / `||`, and an open `(`). After any other token — a
// word, a `)`, or a redirect — an unquoted newline ends the command,
// exactly like `;`. A leading newline (no token yet) is likewise a
// no-op, so blank lines never produce an empty stage.
const NEWLINE_ABSORB = new Set(['semi', 'and', 'or', 'pipe', 'pipe_err', 'paren_open'])

// Only these separate words: bash's default IFS plus `\r`, so a
// `\r\n` pair ends the word cleanly for Windows pastes (bash keeps a
// lone `\r` literal; treating it as whitespace is a deliberate quirk
// so a stray `\r` never glues onto a word). Other Unicode spaces
// (NBSP, U+3000) are ordinary characters, as in bash.
const isBlank = (c) => c === ' ' || c === '\t' || c === '\r'

export function tokenize(line) {
  const st = { line, i: 0, tokens: [], cur: '', mask: '', quote: null, sawQuote: false, inToken: false, heredocs: [], lastParenAt: -2 }
  while (st.i < line.length) {
    const c = line[st.i]
    if (st.quote === "'") {
      if (c === "'") st.quote = null
      else put(st, c, '1')
      st.i++
      continue
    }
    if (st.quote === '"') { readDoubleQuoted(st); continue }
    if (c === '\\') { readEscape(st); continue }
    if (c === "'" || c === '"') { openQuote(st, c); st.i++; continue }
    if (c === '$') { readDollar(st); continue }
    if (c === '`') throw new UnsupportedError('feature', '`', 'command substitution (backticks) is not supported')
    if (c === '#' && !st.inToken) { skipComment(st); continue }
    if (c === '\n') { newline(st); continue }
    if (isBlank(c)) { flush(st); st.i++; continue }
    const op = readOperator(line, st.i, !st.inToken)
    if (op) { flush(st); emit(st, op.token); st.i = op.end; continue }
    put(st, c, '0')
    st.i++
  }
  if (st.quote) throw new Error(`unterminated ${st.quote === "'" ? 'single' : 'double'} quote`)
  flush(st)
  if (st.heredocs.length > 0) readHeredocBodies(line, line.length, st.heredocs)
  return st.tokens
}

// A quote marks the word quoted even when nothing sits between the
// quotes: `""` is an (empty) argument, where a bare word that expands
// to nothing is no argument at all.
function openQuote(st, c) {
  st.quote = c
  st.sawQuote = true
  st.inToken = true
}

function put(st, ch, m) {
  st.cur += ch
  st.mask += m
  st.inToken = true
}

function flush(st) {
  if (st.inToken) {
    const quoted = st.sawQuote || /[12]/u.test(st.mask)
    const token = { kind: 'word', value: st.cur, mask: quoted ? st.mask : null, quoted }
    st.tokens.push(token)
    // The word after `<<` is its delimiter: recorded here for the body
    // collection at the end of the line, and left in the stream as the
    // operator's target, where parse.js consumes it like any other.
    const pending = st.heredocs.find((h) => h.delim === null)
    if (pending) { pending.delim = token.value; pending.quotedDelim = quoted }
  }
  st.cur = ''
  st.mask = ''
  st.sawQuote = false
  st.inToken = false
}

function emit(st, token) {
  if (token.kind === 'paren_open') {
    token.adjacent = st.lastParenAt === st.i - 1
    st.lastParenAt = st.i
  }
  if (token.kind === 'redir' && token.op === 'heredoc') st.heredocs.push(token)
  st.tokens.push(token)
}

// Inside `"…"`: the five escapes, a reference, or a plain character.
function readDoubleQuoted(st) {
  const { line } = st
  const c = line[st.i]
  if (c === '"') { st.quote = null; st.i++; return }
  if (c === '\\') {
    const n = line[st.i + 1]
    if (n === '\n') { st.i += 2; return }
    // Hard-quoted, so an escaped dollar is never read as a reference.
    if (n === '$' || n === '`' || n === '"' || n === '\\') { put(st, n, '1'); st.i += 2; return }
    put(st, '\\', '2')
    st.i++
    return
  }
  if (c === '$') { readDollar(st); return }
  if (c === '`') throw new UnsupportedError('feature', '`', 'command substitution (backticks) is not supported')
  put(st, c, '2')
  st.i++
}

// An unquoted backslash: the next character taken literally, or a line
// continuation. A trailing backslash at the very end stays literal, as
// `bash -c` keeps it.
function readEscape(st) {
  const n = st.line[st.i + 1]
  if (n === undefined) { put(st, '\\', '1'); st.i++; return }
  if (n === '\n') { st.i += 2; return }
  put(st, n, '1')
  st.i += 2
}

// A `$`, bare or inside double quotes. `$'…'` and `$"…"` open quotes;
// `$(…)`, `$((…))` and `$[…]` are refused; `$NAME` / `${NAME}` / the
// special parameters are kept as text (the expander reads them back off
// the mask, which stays `0` or `2` so a hard-quoted `$` never matches);
// any other `$` is an ordinary character.
function readDollar(st) {
  const { line } = st
  const m = st.quote === '"' ? '2' : '0'
  const n = line[st.i + 1]
  if (m === '0' && n === "'") {
    const r = decodeAnsiC(line, st.i + 2)
    for (const ch of r.text) put(st, ch, '1')
    st.sawQuote = true
    st.inToken = true
    st.i = r.end
    return
  }
  if (m === '0' && n === '"') { openQuote(st, '"'); st.i += 2; return }
  if (n === '(') {
    if (line[st.i + 2] === '(') throw new UnsupportedError('feature', '$((', 'arithmetic expansion (`$((…))`) is not supported')
    throw new UnsupportedError('feature', '$(', 'command substitution (`$(…)`) is not supported')
  }
  if (n === '[') throw new UnsupportedError('feature', '$[', 'arithmetic expansion (`$[…]`) is not supported')
  const ref = readRef(line, st.i)
  if (!ref) { put(st, '$', m); st.i++; return }
  for (const ch of ref.raw) put(st, ch, m)
  st.i += ref.raw.length
}

function skipComment(st) {
  while (st.i < st.line.length && st.line[st.i] !== '\n') st.i++
}

// An unquoted line feed terminates the current command. Emit a `semi`
// so it parses identically to `;` downstream — but only where it
// actually separates two commands: `NEWLINE_ABSORB` swallows breaks
// that are leading, doubled (blank lines), or follow a `|` / `&&` /
// `||` / `(` continuation. A line that opened here-documents first
// hands the following lines to them.
function newline(st) {
  flush(st)
  if (st.heredocs.length > 0) {
    st.i = readHeredocBodies(st.line, st.i, st.heredocs)
    st.heredocs = []
  }
  const prev = st.tokens.at(-1)
  if (prev && !NEWLINE_ABSORB.has(prev.kind)) st.tokens.push({ kind: 'semi' })
  st.i++
}
