import { UnsupportedError } from '../unsupported.js'
import { doubleQuotedBacktick, readBacktickSubstitution } from './substitution.js'

const UNARY = /^-[abcdefghknoprstuvwxzGLNORS]$/u
const BINARY = new Set(['=', '==', '!=', '=~', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef'])
const END_TERM = new Set(['end', '&&', '||', ')'])
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u

// [[ has its own grammar: comparison operators are not redirects, and &&/||
// combine predicates whose operands expand only when evaluation reaches them.
export function readConditional(line, start, helpers, expansionDepth = 0) {
  const p = { line, i: start + 2, helpers, token: null, depth: 0, terms: 0, removed: 0, expansionDepth }
  advance(p, true)
  const expression = parseOr(p)
  if (p.token.kind !== 'end') syntax(p, p.token.kind === 'word' ? 'syntax error in conditional expression' : `syntax error in conditional expression: unexpected token \`${tokenText(p.token)}'`)
  return { raw: line.slice(start, p.i + p.removed), expression }
}

function parseOr(p) {
  let expression = parseAnd(p)
  while (p.token.kind === '||') {
    advance(p, true)
    expression = { kind: 'or', left: expression, right: parseAnd(p) }
  }
  return expression
}

function parseAnd(p) {
  let expression = parseTerm(p)
  while (p.token.kind === '&&') {
    advance(p, true)
    expression = { kind: 'and', left: expression, right: parseTerm(p) }
  }
  return expression
}

function parseTerm(p) {
  if (++p.terms > 128) throw new UnsupportedError('feature', '[[ complexity', 'conditional expressions above 128 terms are not supported')
  if (++p.depth > 64) throw new UnsupportedError('feature', '[[ nesting', 'conditional nesting above 64 levels is not supported')
  try {
    const token = p.token
    if (token.kind === '(') {
      advance(p, true)
      const expression = parseOr(p)
      if (p.token.kind !== ')') syntax(p, p.token.kind === 'word' ? "expected `)'" : `unexpected token \`${tokenText(p.token)}', expected \`)'`)
      advance(p, true)
      return expression
    }
    if (bare(token, '!')) {
      advance(p, true)
      return { kind: 'not', expression: parseTerm(p) }
    }
    if (token.kind === 'end') syntax(p)
    if (token.kind !== 'word') syntax(p, `unexpected token \`${tokenText(token)}' in conditional command`)
    if (!token.quoted && UNARY.test(token.value)) {
      advanceOperand(p, 'unary')
      const word = operand(p, 'unary')
      advance(p, true)
      return { kind: 'unary', op: token.value, word }
    }
    advance(p)
    if (END_TERM.has(p.token.kind)) return { kind: 'unary', op: '-n', word: token }
    const operator = p.token
    const binary = operator.kind === 'word' ? !operator.quoted && BINARY.has(operator.value) : operator.kind === '<' || operator.kind === '>'
    if (!binary) syntax(p, operator.kind === 'word' ? 'conditional binary operator expected' : `unexpected token \`${tokenText(operator)}', conditional binary operator expected`)
    if (operator.value === '=~') throw new UnsupportedError('feature', '[[ =~', 'regular expression comparisons in [[ are not supported')
    advanceOperand(p, 'binary')
    const right = operand(p, 'binary')
    advance(p, true)
    return { kind: 'binary', op: operator.value, left: token, right }
  } finally { p.depth-- }
}

const bare = (token, value) => token.kind === 'word' && !token.quoted && token.value === value

// Bash rejects these too, so they are the caller's own typo rather than
// something this shell is missing: an ordinary syntax error, not a gap. Bash
// says what its conditional reader expected, and its grammar then names the
// token before where that reader stopped, read back from the line itself.
function syntax(p, message) {
  const near = `syntax error near \`${nearText(p.line, p.i)}'`
  throw Object.assign(new Error(message ? `${message}\n${near}` : near), { grammar: true })
}

// The token as bash's conditional reader names it.
const tokenText = (token) => (token.kind === 'newline' ? 'newline' : token.kind === 'end' ? ']]' : token.raw ?? token.value ?? token.kind)

// Bash's error_token_from_text: back from where reading stopped over blanks
// to the end of a token, then back to the blank, `;`, `|` or `&` before it —
// so `&&` reads as `&` — within the line reading stopped on.
function nearText(line, at) {
  const start = line.lastIndexOf('\n', at - 2) + 1
  const end = line.indexOf('\n', Math.max(at - 1, start))
  const t = line.slice(start, end === -1 ? line.length : end + 1)
  let i = at - start
  if (i > 0 && i >= t.length) i--
  while (i > 0 && /[ \t\n]/u.test(t[i])) i--
  const last = i > 0 ? i + 1 : 0
  while (i > 0 && !' \n\t;|&'.includes(t[i])) i--
  while (i !== last && /[ \t\n]/u.test(t[i])) i++
  return last ? t.slice(i, last) : t[i]
}

// An operand whose quote the input never closes: bash says so, and then that
// its operator went without an argument.
function advanceOperand(p, kind) {
  try { advance(p) } catch (error) {
    if (!error.quoteEof) throw error
    throw Object.assign(new Error(`unexpected EOF while looking for matching \`${error.quoteEof}'\nunexpected argument to conditional ${kind} operator`), { grammar: true })
  }
}

function operand(p, kind) {
  if (p.token.kind !== 'word') syntax(p, `unexpected argument \`${tokenText(p.token)}' to conditional ${kind} operator`)
  return p.token
}

function advance(p, newlines = false) {
  p.token = nextToken(p)
  if (newlines) while (p.token.kind === 'newline') p.token = nextToken(p)
}

// A typed line ends with a newline, which the reader may take as a token;
// the input ends only after it.
function nextToken(p) {
  while (p.i < p.line.length) {
    const c = p.line[p.i]
    if (c === ' ' || c === '\t') { p.i++; continue }
    if (c === '\\' && p.line[p.i + 1] === '\n') { p.i += 2; continue }
    if (c === '#') {
      const end = p.line.indexOf('\n', p.i)
      p.i = end < 0 ? p.line.length : end
      continue
    }
    if (c === '\n') { p.i++; return { kind: 'newline' } }
    const pair = p.line.slice(p.i, p.i + 2)
    if (pair === '<(' || pair === '>(') throw new UnsupportedError('feature', pair, `process substitution (\`${pair}…\`) is not supported`)
    if (pair === '&&' || pair === '||') { p.i += 2; return { kind: pair } }
    if ('()<>;&|'.includes(c)) { p.i++; return { kind: c, value: c } }
    const word = readWord(p)
    return bare(word, ']]') ? { kind: 'end' } : word
  }
  if (!p.ended) { p.ended = true; return { kind: 'newline' } }
  throw Object.assign(new Error("unexpected EOF while looking for `]]'\nsyntax error: unexpected end of file"), { grammar: true })
}

function readWord(p) {
  const start = p.i
  const word = { kind: 'word', value: '', mask: '', quoted: false, empty: [] }
  let quote = null, quoteStart = 0
  while (p.i < p.line.length) {
    const c = p.line[p.i]
    if (quote && c === quote) {
      if (word.value.length === quoteStart) word.empty.push(quoteStart)
      word.quoted = true; quote = null; p.i++; continue
    }
    if (quote === "'") { put(word, c, '1'); p.i++; continue }
    if (c === '\\') { escape(p, word, quote); continue }
    if (c === '$') {
      spliceContinuations(p)
      if (!quote && p.line[p.i + 1] === '"') { quote = '"'; quoteStart = word.value.length; p.i += 2; continue }
      dollar(p, word, quote)
      continue
    }
    if (c === '`') {
      const backtick = readBacktickSubstitution(p.line, p.i)
      put(word, '`', quote ? '2' : '0')
      put(word, (quote === '"' ? doubleQuotedBacktick(backtick.raw) : backtick.raw).slice(1), '1')
      p.i += backtick.raw.length
      continue
    }
    if (quote) { put(word, c, '2'); p.i++; continue }
    if (c === "'" || c === '"') { quote = c; quoteStart = word.value.length; p.i++; continue }
    if (c === '(' && word.mask.at(-1) === '0' && /[?*+@!]/u.test(word.value.at(-1)) && !word.empty.includes(word.value.length)) {
      throw new UnsupportedError('feature', '[[ extglob', 'extended glob patterns in [[ are not supported')
    }
    if (/[ \t\n()<>;&|]/u.test(c)) break
    put(word, c, '0'); p.i++
  }
  // Bash reads on past such a quote into bytes of its own, and names one of
  // them as the token it cannot read, except where it wanted an operand.
  if (quote) throw Object.assign(new UnsupportedError('feature', '[[ quote', 'an unterminated quote inside `[[` is not supported'), { quoteEof: quote })
  if (!word.quoted && !/[12]/u.test(word.mask)) word.mask = null
  if (word.empty.length === 0) delete word.empty
  word.raw = p.line.slice(start, p.i)
  return word
}

function put(word, text, mask, quoted = mask !== '0') {
  word.value += text
  word.mask += mask.repeat(text.length)
  word.quoted ||= quoted
}

function escape(p, word, quote) {
  const next = p.line[p.i + 1]
  if (next === '\n') { p.i += 2; return }
  if (next !== undefined && (!quote || '$`"\\'.includes(next))) {
    put(word, next, '1'); p.i += 2
  } else { put(word, '\\', quote ? '2' : '1'); p.i++ }
}

function spliceContinuations(p) {
  while (p.line[p.i + 1] === '\\' && p.line[p.i + 2] === '\n') {
    p.line = p.line.slice(0, p.i + 1) + p.line.slice(p.i + 3)
    p.removed += 2
  }
}

function dollar(p, word, quote) {
  const mask = quote ? '2' : '0'
  if (!quote && p.line[p.i + 1] === "'") {
    const result = p.helpers.decodeAnsiC(p.line, p.i + 2)
    if (result.text === '') word.empty.push(word.value.length)
    put(word, result.text, '1'); p.i = result.end; return
  }
  const reference = p.helpers.readExpansion(p.line, p.i, p.expansionDepth + 1, Boolean(quote))
  if (!reference) { put(word, '$', '1'); p.i++; return }
  if (reference.command !== undefined || reference.parameter !== undefined || reference.arithmetic !== undefined) {
    put(word, '$', mask)
    put(word, reference.raw.slice(1), '1', false)
  } else {
    const next = p.line[p.i + reference.raw.length]
    const text = NAME.test(reference.name) && (next === "'" || next === '"') ? '${' + reference.name + '}' : reference.raw
    put(word, text, mask)
  }
  p.i += reference.raw.length
}
