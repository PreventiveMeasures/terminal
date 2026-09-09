import { UnsupportedError } from '../unsupported.js'

export const MAX_SUBSTITUTION_DEPTH = 64
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
  if (st.quote) throw new Error(`unterminated ${st.quote === "'" ? 'single' : 'double'} quote`)
  throw new Error('unterminated command substitution')
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
    if (word.value === '[[') throw new UnsupportedError('feature', '[[', '`[[ … ]]` expressions inside command substitutions are not supported')
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
  if (!st.quote && line[i + 1] === "'") {
    const r = st.helpers.decodeAnsiC(line, i + 2)
    append(st, r.text, true)
    st.i = r.end
    return
  }
  if (!st.quote && line[i + 1] === '"') { st.quote = '"'; st.word.started = true; st.i += 2; return }
  const ref = st.helpers.readExpansion(line, i, st.depth + st.parens + 1)
  const text = ref?.raw ?? '$'
  append(st, text, Boolean(st.quote))
  st.i += text.length
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
  throw new Error('unterminated backtick substitution')
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
    st.command = true
  } else if (token.kind === 'redir') {
    if (token.op === 'heredoc') st.heredocs.push(token)
    if (!['dup', 'close'].includes(token.op)) st.target = token
  } else st.command = true
  st.i = op.end
  return false
}

function newline(st) {
  finishWord(st)
  if (st.heredocs.some((h) => h.delim === null)) throw new Error('heredoc requires a delimiter')
  if (st.heredocs.length) {
    st.i = st.helpers.readHeredocBodies(st.line, st.i, st.heredocs)
    st.heredocs = []
  }
  st.command = true
  st.i++
}
