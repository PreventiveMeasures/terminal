// Produce words with quotes/escapes removed but a per-UTF-16-unit mask:
// 0 = bare, 1 = hard-quoted, 2 = double-quoted (substitutions remain active).
// Empty quoted fragments retain offsets so later expansion cannot erase them.
// Boundary tokens have distinct kinds; words retain whether any part was
// quoted so only bare words can become shell keywords.
// Backslashes escape any following character outside quotes; inside double
// quotes only $, backtick, quote, backslash and newline are escaped.
// lex.js handles substitutions, operators, ANSI-C strings and here-documents.

import { NAME_RE, decodeAnsiC, readBacktickSubstitution, readExpansion, readHeredocBodies, readOperator, skipContinuations } from './lex.js'
import { UnsupportedError } from '../unsupported.js'
import { readConditional } from './conditional-lex.js'

export { NAME_RE }

// These tokens already separate commands or require a continued operand.
// Other newlines become separators, including after a completed group.
const NEWLINE_ABSORB = new Set(['semi', 'and', 'or', 'pipe', 'pipe_err', 'paren_open'])

// Shell token boundaries are space and tab; CR and Unicode spaces stay literal.
const isBlank = (c) => c === ' ' || c === '\t'

export function tokenize(line, options = {}) {
  return scan(newScanner(line, options), false).tokens
}

// Keep unfinished grammar in the token buffer. The parser clears it only after
// accepting an input unit, before this scanner reads any of the next unit.
export function createTokenizer(line, options = {}) {
  const st = newScanner(line, options)
  return { read: () => scan(st, true), reset: () => { st.tokens = [] } }
}

function scan(st, incremental) {
  // Reference scanning splices backslash-newline out of st.line.
  while (st.i < st.line.length) {
    const c = st.line[st.i]
    if (st.quote && c === st.quote) { closeQuote(st); st.i++; continue }
    if (st.quote === "'") { put(st, c, '1'); st.i++; continue }
    if (c === '\\') { readEscape(st); continue }
    if (c === '$') { readDollar(st); continue }
    if (c === '`') { readBacktick(st); continue }
    if (st.quote) { put(st, c, '2'); st.i++; continue }
    if (c === "'" || c === '"') { openQuote(st, c); st.i++; continue }
    const inToken = st.cur !== '' || st.empty.length > 0
    if (!inToken && st.line.startsWith('[[', st.i) && /[ \t\n()<>;&|]|^$/u.test(st.line[st.i + 2] ?? '') && conditionalPosition(st.tokens)) {
      const r = readConditional(st.line, st.i, { readExpansion: st.readExpansion, decodeAnsiC })
      emit(st, { kind: 'condition', expression: r.expression })
      st.i += r.raw.length
      continue
    }
    if (c === '#' && !inToken) { skipComment(st); continue }
    if (c === '\n') {
      newline(st)
      if (incremental) return { tokens: st.tokens, done: st.i >= st.line.length }
      continue
    }
    if (isBlank(c)) { flush(st); st.i++; continue }
    if (c === '(' && st.mask.at(-1) === '0' && /[?*+@!]/u.test(st.cur.at(-1)) && !st.empty.includes(st.cur.length)) {
      throw new UnsupportedError('feature', 'extglob', 'extended glob patterns are not supported')
    }
    const op = readOperator(st.line, st.i, !inToken)
    if (op?.token.kind === 'paren_open') op.token.wordAdjacent = inToken
    if (op) { flush(st); emit(st, op.token); st.i = op.end; continue }
    put(st, c, '0')
    st.i++
  }
  if (st.quote) throw new Error(`unterminated ${st.quote === "'" ? 'single' : 'double'} quote`)
  flush(st)
  if (st.heredocs.length > 0) readHeredocBodies(st.line, st.line.length, st.heredocs)
  return { tokens: st.tokens, done: true }
}

function newScanner(line, options = {}) {
  return {
    line, i: 0, tokens: [], cur: '', mask: '', empty: [], quoted: false, quoteStart: 0, quote: null, heredocs: [], lastParenAt: -2,
    readExpansion: (source, at, depth = 0, quoted = false) => readExpansion(source, at, depth, quoted, options),
  }
}

// Parameter operands are a single shell word even when they contain spaces or
// operators. Their own quotes protect only the corresponding fragments.
export function tokenizeFragment(line, quoted = false) {
  const st = { ...newScanner(line), fragment: true, fragmentQuoted: quoted }
  while (st.i < st.line.length) {
    const c = st.line[st.i]
    if (st.quote && c === st.quote) { closeQuote(st); st.i++; continue }
    if (st.quote === "'") { put(st, c, '1'); st.i++; continue }
    if (c === '\\') { readEscape(st); continue }
    if (c === '$') { readDollar(st); continue }
    if (c === '`') { readBacktick(st); continue }
    if (st.quote) { put(st, c, '2'); st.i++; continue }
    if (c === '"' || (c === "'" && !quoted)) { openQuote(st, c); st.i++; continue }
    if (!quoted && (c === '<' || c === '>') && st.line[skipContinuations(st.line, st.i + 1)] === '(') {
      throw new UnsupportedError('feature', `${c}(`, 'process substitution in parameter operands is not supported')
    }
    put(st, c, quoted ? '2' : '0')
    st.i++
  }
  if (st.quote) throw new UnsupportedError('feature', '${', 'unterminated quote in parameter operand')
  flush(st)
  return st.tokens[0] ?? { value: '', mask: quoted ? '' : null }
}

function conditionalPosition(tokens) {
  let command = true, target = false
  for (const t of tokens) {
    if (['semi', 'and', 'or', 'pipe', 'pipe_err', 'paren_open'].includes(t.kind)) { command = true; target = false; continue }
    if (t.kind === 'redir') { command = false; target = !['dup', 'close'].includes(t.op); continue }
    if (target) { target = false; continue }
    if (!command || t.kind !== 'word' || t.quoted || !['!', '{', 'if', 'then', 'else', 'elif', 'do'].includes(t.value)) command = false
  }
  return command && !target
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
function put(st, ch, m, quoted = m !== '0') {
  st.cur += ch
  st.mask += m.repeat(ch.length)
  st.quoted ||= quoted
}

function flush(st) {
  if (st.cur !== '' || st.empty.length > 0) {
    const quoted = st.empty.length > 0 || st.quoted
    const token = { kind: 'word', value: st.cur, mask: /[12]/u.test(st.mask) || quoted ? st.mask : null, quoted, ...(st.empty.length ? { empty: st.empty } : {}) }
    st.tokens.push(token)
    // A heredoc delimiter remains a word token and also guides body collection.
    const pending = st.heredocs.find((h) => h.delim === null)
    if (pending) { pending.delim = token.value; pending.quotedDelim = quoted }
  }
  st.cur = ''
  st.mask = ''
  st.empty = []
  st.quoted = false
}

function emit(st, token) {
  if (token.kind === 'paren_open') {
    token.adjacent = skipContinuations(st.line, st.lastParenAt + 1) === st.i
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
  if (n !== undefined && (!(st.quote || st.fragmentQuoted) || '$`"\\'.includes(n) || (st.fragment && n === '}'))) {
    put(st, n, '1')
    st.i += 2
  } else {
    put(st, '\\', st.quote || st.fragmentQuoted ? '2' : '1')
    st.i++
  }
}

// Backslash-newline is spliced out before the shell recognises tokens,
// so a reference split across lines is still one reference: `$\<newline>?`
// is `$?`. Splicing only ahead of the cursor leaves every position the
// tokenizer has already recorded valid. Single-quoted text never reaches
// here, which is why the pair is always a continuation.
function spliceContinuations(st, at) {
  const end = skipContinuations(st.line, at)
  if (end !== at) st.line = st.line.slice(0, at) + st.line.slice(end)
}

// References keep their source text and 0/2 mask for later expansion.
// ANSI-C strings become hard-quoted text; literal dollars cannot expand.
function readDollar(st) {
  spliceContinuations(st, st.i + 1)
  const { line } = st
  const m = st.quote === '"' || st.fragmentQuoted ? '2' : '0'
  const n = line[st.i + 1]
  if ((m === '0' || (st.fragmentQuoted && !st.quote)) && n === "'") {
    const r = decodeAnsiC(line, st.i + 2)
    if (st.fragmentQuoted && /[$`"\\]/u.test(r.text)) {
      throw new UnsupportedError('feature', '${', 'active characters in ANSI-C quoted parameter operands are not supported')
    }
    if (r.text === '') st.empty.push(st.cur.length)
    put(st, r.text, '1')
    st.i = r.end
    return
  }
  if ((m === '0' || (st.fragmentQuoted && !st.quote)) && n === '"') { openQuote(st, '"'); st.i += 2; return }
  const ref = st.readExpansion(line, st.i, 0, m === '2')
  if (!ref) { put(st, '$', '1'); st.i++; return }
  if (ref.command !== undefined || ref.parameter !== undefined || ref.arithmetic !== undefined) {
    put(st, '$', m)
    put(st, ref.raw.slice(1), '1', false)
    st.i += ref.raw.length
    return
  }
  // Quote removal must not join a reference to the next quoted fragment.
  const next = line[st.i + ref.raw.length]
  const text = NAME_RE.test(ref.name) && (next === '"' || next === "'")
    ? '${' + ref.name + '}' : ref.raw
  put(st, text, m)
  st.i += ref.raw.length
}

// Backticks carry the same command substitution as `$( )` and differ only in
// how the source is quoted, so the source is kept in the word exactly as `$( )`
// keeps its own and re-read at expansion. Rewriting it into `$(command)` here
// would be simpler but wrong: unescaping can leave a trailing backslash, and
// that backslash would escape the synthesised closing parenthesis.
function readBacktick(st) {
  const m = st.quote === '"' || st.fragmentQuoted ? '2' : '0'
  const { raw } = readBacktickSubstitution(st.line, st.i)
  put(st, '`', m)
  put(st, raw.slice(1), '1', false)
  st.i += raw.length
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
  else if (prev?.kind === 'semi') prev.lineEnd = true
  st.i++
}
