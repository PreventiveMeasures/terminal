// Produce words with quotes/escapes removed but a per-UTF-16-unit mask:
// 0 = bare, 1 = hard-quoted, 2 = double-quoted (parameter expansion remains).
// Empty quoted fragments retain offsets so later expansion cannot erase them.
// Boundary tokens have distinct kinds; words retain whether any part was
// quoted so only bare words can become shell keywords.
// Backslashes escape any following character outside quotes; inside double
// quotes only $, backtick, quote, backslash and newline are escaped.
// lex.js handles substitutions, operators, ANSI-C strings and here-documents.

import { NAME_RE, backtickGap, decodeAnsiC, readExpansion, readHeredocBodies, readOperator } from './lex.js'

export { NAME_RE }

// These tokens already separate commands or require a continued operand.
// Other newlines become separators, including after a completed group.
const NEWLINE_ABSORB = new Set(['semi', 'and', 'or', 'pipe', 'pipe_err', 'paren_open'])

// Shell token boundaries are space and tab; CR and Unicode spaces stay literal.
const isBlank = (c) => c === ' ' || c === '\t'

export function tokenize(line) {
  // `st.line` is the cursor's source of truth: splicing backslash-newline
  // out of a reference rewrites it mid-scan, and the rest of the file
  // already reads it rather than the parameter.
  const st = { line, i: 0, tokens: [], cur: '', mask: '', empty: [], quoteStart: 0, quote: null, heredocs: [], lastParenAt: -2 }
  while (st.i < st.line.length) {
    const c = st.line[st.i]
    if (st.quote && c === st.quote) { closeQuote(st); st.i++; continue }
    if (st.quote === "'") { put(st, c, '1'); st.i++; continue }
    if (c === '\\') { readEscape(st); continue }
    if (c === '$') { readDollar(st); continue }
    if (c === '`') throw backtickGap()
    if (st.quote) { put(st, c, '2'); st.i++; continue }
    if (c === "'" || c === '"') { openQuote(st, c); st.i++; continue }
    const inToken = st.cur !== '' || st.empty.length > 0
    if (c === '#' && !inToken) { skipComment(st); continue }
    if (c === '\n') { newline(st); continue }
    if (isBlank(c)) { flush(st); st.i++; continue }
    const op = readOperator(st.line, st.i, !inToken)
    if (op?.token.kind === 'paren_open') op.token.wordAdjacent = inToken
    if (op) { flush(st); emit(st, op.token); st.i = op.end; continue }
    put(st, c, '0')
    st.i++
  }
  if (st.quote) throw new Error(`unterminated ${st.quote === "'" ? 'single' : 'double'} quote`)
  flush(st)
  if (st.heredocs.length > 0) readHeredocBodies(st.line, st.line.length, st.heredocs)
  return st.tokens
}

// Empty quotes are significant even when no character gets a quoting mask.
function openQuote(st, c) {
  st.quoteStart = st.cur.length
  st.quote = c
}

function closeQuote(st) {
  if (st.cur.length === st.quoteStart) st.empty.push(st.cur.length)
  st.quote = null
}

// Quote masks count UTF-16 units, including both halves of astral characters.
function put(st, ch, m) {
  st.cur += ch
  st.mask += m.repeat(ch.length)
}

function flush(st) {
  if (st.cur !== '' || st.empty.length > 0) {
    const quoted = st.empty.length > 0 || /[12]/u.test(st.mask)
    const token = { kind: 'word', value: st.cur, mask: quoted ? st.mask : null, quoted, ...(st.empty.length ? { empty: st.empty } : {}) }
    st.tokens.push(token)
    // A heredoc delimiter remains a word token and also guides body collection.
    const pending = st.heredocs.find((h) => h.delim === null)
    if (pending) { pending.delim = token.value; pending.quotedDelim = quoted }
  }
  st.cur = ''
  st.mask = ''
  st.empty = []
}

function emit(st, token) {
  if (token.kind === 'paren_open') {
    token.adjacent = st.lastParenAt === st.i - 1
    st.lastParenAt = st.i
  }
  if (token.kind === 'redir' && token.op === 'heredoc') st.heredocs.push(token)
  st.tokens.push(token)
}

// Backslash-newline disappears in either mode. Other double-quoted escapes
// are restricted; a trailing unquoted backslash remains literal.
function readEscape(st) {
  const n = st.line[st.i + 1]
  if (n === '\n') { st.i += 2; return }
  if (n !== undefined && (!st.quote || '$`"\\'.includes(n))) {
    put(st, n, '1')
    st.i += 2
  } else {
    put(st, '\\', st.quote ? '2' : '1')
    st.i++
  }
}

// Backslash-newline is spliced out before the shell recognises tokens,
// so a reference split across lines is still one reference: `$\<newline>?`
// is `$?`. Splicing only ahead of the cursor leaves every position the
// tokenizer has already recorded valid. Single-quoted text never reaches
// here, which is why the pair is always a continuation.
function spliceContinuations(st, at) {
  while (st.line[at] === '\\' && st.line[at + 1] === '\n') st.line = st.line.slice(0, at) + st.line.slice(at + 2)
}

// References keep their source text and 0/2 mask for later expansion.
// ANSI-C strings become hard-quoted text; literal dollars cannot expand.
function readDollar(st) {
  spliceContinuations(st, st.i + 1)
  const { line } = st
  const m = st.quote === '"' ? '2' : '0'
  const n = line[st.i + 1]
  if (m === '0' && n === "'") {
    const r = decodeAnsiC(line, st.i + 2)
    if (r.text === '') st.empty.push(st.cur.length)
    put(st, r.text, '1')
    st.i = r.end
    return
  }
  if (m === '0' && n === '"') { openQuote(st, '"'); st.i += 2; return }
  const ref = readExpansion(line, st.i)
  if (!ref) { put(st, '$', '1'); st.i++; return }
  // Quote removal must not join a reference to the next quoted fragment.
  const next = line[st.i + ref.raw.length]
  const text = NAME_RE.test(ref.name) && (next === '"' || next === "'")
    ? '${' + ref.name + '}' : ref.raw
  put(st, text, m)
  st.i += ref.raw.length
}

function skipComment(st) {
  while (st.i < st.line.length && st.line[st.i] !== '\n') st.i++
}

// Preserve newline versus ';' for the parser's rules after '{' and 'do'.
// Here-document bodies are consumed before tokenizing the following command.
function newline(st) {
  flush(st)
  if (st.heredocs.length > 0) {
    st.i = readHeredocBodies(st.line, st.i, st.heredocs)
    st.heredocs = []
  }
  const prev = st.tokens.at(-1)
  if (prev && !NEWLINE_ABSORB.has(prev.kind)) st.tokens.push({ kind: 'semi', newline: true })
  st.i++
}
