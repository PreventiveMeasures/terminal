import { UnsupportedError } from '../unsupported.js'

export const MAX_SUBSTITUTION_DEPTH = 64

// What bash says when the input ends inside a quote or a substitution: the
// character it was still looking for.
export const unmatched = (closer) => Object.assign(new Error(`unexpected EOF while looking for matching \`${closer}'`), { kind: 'unmatched' })

// Bash's own words for input it cannot read, as distinct from a refusal. A
// `kind` says which of its forms an error is, for a reader that reports one
// form differently: `near` for a token the grammar stopped at, `end` for the
// end of the input.
export const syntaxError = (message, kind) => Object.assign(new Error(message), { grammar: true, kind })
export const unexpectedToken = (label) => syntaxError(`syntax error near unexpected token \`${label}'`, 'near')

// A grammar error inside `$( … )` stops the enclosing reader too, which adds
// a plain `syntax error` of its own for each level it is nested in.
export const nestedSyntaxError = (error) => (error?.grammar ? syntaxError(`${error.message}\nsyntax error`) : error)

// Backticks quote differently from `$( )`: a backslash escapes only `$`, a
// backslash, a newline and a backtick, and every other backslash reaches the
// inner command intact. An escaped backtick is how the form nests, and the
// escape levels compound with the nesting, so those are refused rather than
// half-implemented — callers get a diagnostic naming the escape.
export function readBacktickSubstitution(line, start) {
  let command = ''
  for (let i = start + 1; i < line.length; i++) {
    const c = line[i]
    if (c === '`') return { command, raw: line.slice(start, i + 1), backtick: true }
    if (c !== '\\') { command += c; continue }
    const next = line[i + 1]
    if (next === '`') {
      throw new UnsupportedError('feature', '\\`', 'nested backtick command substitution is not supported; use `$( )` instead')
    }
    if (next === '$' || next === '\\') { command += next; i++; continue }
    if (next === '\n') { i++; continue }
    command += c
  }
  throw unmatched('`')
}

// Inside double quotes a backslash before `"` escapes it too, so
// "`echo \"q\"`" runs `echo "q"`. Only the reader knows the quotes, and the
// word keeps the source re-read at expansion, so the escape is taken out of
// that source here: a `"` cannot end the substitution, and every other pair
// stays for the re-read to unescape as it always does.
export function doubleQuotedBacktick(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') { out += raw[i]; continue }
    out += raw[i + 1] === '"' ? '"' : raw.slice(i, i + 2)
    i++
  }
  return out
}

const freshWord = () => ({ value: '', quoted: false, started: false })
const depthGap = () => new UnsupportedError('feature', 'command substitution depth', `command substitution nesting above ${MAX_SUBSTITUTION_DEPTH} is not supported`)

// Find the closing parenthesis without interpreting the command. Heredoc
// bodies and nested substitutions have their own quoting boundaries.
export function readCommandSubstitution(line, start, open, depth, helpers) {
  if (depth >= MAX_SUBSTITUTION_DEPTH) throw depthGap()
  const st = { line, i: open + 1, depth, helpers, parens: 0, quote: null, word: freshWord(), command: true, target: null, heredocs: [] }
  while (st.i < line.length) {
    if (scan(st)) return { raw: line.slice(start, st.i + 1), command: line.slice(open + 1, st.i) }
  }
  if (st.quote) throw unmatched(st.quote)
  // Bash reads the body by its grammar, where a `(` after a word opens a
  // definition or is an error, and either may take a `)` this count gave
  // to that `(` — so where the input ends, what bash says is not known here.
  if (st.afterWord) throw new UnsupportedError('feature', 'command substitution', 'an unterminated `$( … )` holding a `(` after a word is not supported')
  throw unmatched(')')
}

function append(st, text, quoted = false) {
  st.word.value += text
  st.word.quoted ||= quoted
  st.word.started = true
}

function finishWord(st) {
  const word = st.word
  if (!word.started) return
  if (st.target) {
    if (st.target.op === 'heredoc') {
      st.target.delim = word.value
      st.target.quotedDelim = word.quoted
    }
    st.target = null
  } else if (st.command && !word.quoted) {
    if (word.value === 'case') throw new UnsupportedError('feature', 'case', '`case` patterns inside command substitutions are not supported')
    st.command = ['!', '{', 'do', 'then', 'else', 'elif', 'if', 'while', 'until'].includes(word.value) || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word.value)
  } else st.command = false
  st.word = freshWord()
}

function scan(st) {
  const { line, i, quote } = st
  const c = line[i]
  if (quote && c === quote) { st.quote = null; st.word.quoted = true; st.i++; return false }
  if (quote === "'") { append(st, c, true); st.i++; return false }
  if (c === '\\') { escape(st); return false }
  if (c === '$') { dollar(st); return false }
  if (c === '`') { backticks(st); return false }
  if (quote) { append(st, c, true); st.i++; return false }
  if (c === "'" || c === '"') { st.quote = c; st.word.started = true; st.i++; return false }
  if (st.command && !st.target && !st.word.started && line.startsWith('[[', i) && /[ \t\n()<>;&|]|^$/u.test(line[i + 2] ?? '')) {
    const r = st.helpers.readConditional(line, i, st.helpers, st.depth + st.parens + 1)
    st.i += r.raw.length
    st.command = false
    return false
  }
  if (c === '#' && !st.word.started) {
    const end = line.indexOf('\n', i)
    st.i = end === -1 ? line.length : end
    return false
  }
  if (c === '\n') { newline(st); return false }
  if (c === ' ' || c === '\t') { finishWord(st); st.i++; return false }
  let op
  try { op = st.helpers.readOperator(line, i, !st.word.started) } catch (e) {
    if (!(e instanceof UnsupportedError)) throw e
    // The inner parser reports unavailable redirections when executed.
    st.i++
    return false
  }
  if (op) return operator(st, op)
  append(st, c)
  st.i++
  return false
}

function escape(st) {
  const n = st.line[st.i + 1]
  if (n === '\n') { st.i += 2; return }
  if (n !== undefined && (!st.quote || '$`"\\'.includes(n))) {
    append(st, n, true)
    st.i += 2
  } else { append(st, '\\', Boolean(st.quote)); st.i++ }
}

function dollar(st) {
  const { line, i } = st
  const next = st.helpers.skipContinuations(line, i + 1)
  if (!st.quote && line[next] === "'") {
    const r = st.helpers.decodeAnsiC(line, next + 1)
    append(st, r.text, true)
    st.i = r.end
    return
  }
  if (!st.quote && line[next] === '"') { st.quote = '"'; st.word.started = true; st.i = next + 1; return }
  const ref = nestedExpansion(st, i)
  const text = ref?.raw ?? '$'
  append(st, text, Boolean(st.quote))
  st.i += text.length
}

function nestedExpansion(st, i) {
  try { return st.helpers.readExpansion(st.line, i, st.depth + st.parens + 1, st.quote === '"') } catch (error) { throw nestedSyntaxError(error) }
}

// Backticks remain unavailable at execution, but their quoted parentheses
// cannot close the surrounding $() while scanning a skipped command.
function backticks(st) {
  const start = st.i++
  while (st.i < st.line.length) {
    const c = st.line[st.i++]
    if (c === '`') { append(st, st.line.slice(start, st.i), Boolean(st.quote)); return }
    if (c === '\\' && st.i < st.line.length) st.i++
  }
  throw unmatched('`')
}

function operator(st, op) {
  finishWord(st)
  const token = op.token
  if (token.kind === 'paren_close') {
    if (st.parens === 0) {
      if (st.heredocs.length) throw new UnsupportedError('feature', 'command substitution heredoc', 'a command substitution heredoc must finish before its closing parenthesis')
      return true
    }
    st.parens--
    st.command = false
  } else if (token.kind === 'paren_open') {
    if (st.depth + ++st.parens >= MAX_SUBSTITUTION_DEPTH) throw depthGap()
    st.afterWord ||= !st.command
    st.command = true
  } else if (token.kind === 'redir') {
    st.command = false
    if (token.op === 'heredoc') st.heredocs.push(token)
    if (!['dup', 'close'].includes(token.op)) st.target = token
  } else st.command = true
  st.i = op.end
  return false
}

function newline(st) {
  finishWord(st)
  // A `<<` with no word after it, which the reader of the enclosing line
  // reports as its own syntax error too.
  if (st.heredocs.some((h) => h.delim === null)) throw nestedSyntaxError(unexpectedToken('newline'))
  if (st.heredocs.length) {
    st.i = st.helpers.readHeredocBodies(st.line, st.i, st.heredocs)
    st.heredocs = []
  }
  st.command = true
  st.i++
}
