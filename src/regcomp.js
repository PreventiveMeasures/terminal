// glibc's regcomp, as GNU sed and GNU grep both hand it their -G and -E
// patterns: posix/regcomp.c of glibc 2.39, in C.UTF-8 or a byte locale,
// from parse_reg_exp down to parse_dup_op here and from parse_bracket_exp
// down in ./regcomp-bracket.js. It reads the pattern token by token as
// regcomp does and fails with regcomp's message for the first fault it
// meets, in the order it meets them; what a tool says of a malformed pattern
// is that message. A pattern it takes comes back as a tree, which sed spells
// out again for the AWK matcher (./commands/sed-regex.js) and grep only asks
// whether there is one (./commands/grep-syntax.js).
//
// regcomp is parameterized by the syntax bits a tool sets, and so is this:
// RE_SYNTAX_POSIX_BASIC and _EXTENDED for sed, RE_SYNTAX_GREP and _EGREP for
// grep, with RE_ICASE for sed's I and grep's -i. Only the bits the parser
// reads are here; those that steer nothing but the matcher (RE_DOT_NEWLINE,
// RE_DOT_NOT_NULL, RE_HAT_LISTS_NOT_NEWLINE, RE_NO_POSIX_BACKTRACKING,
// RE_NO_SUB) are left out of every syntax below, and so are those neither
// tool sets (RE_BACKSLASH_ESCAPE_IN_LISTS, RE_LIMITED_OPS, RE_NO_BK_REFS,
// RE_NO_GNU_OPS). It is parameterized by the locale too, as regcomp is: by
// whether a character can take more than one byte, and by the towupper that
// RE_ICASE reads the pattern through. What each tool does to a pattern
// before regcomp sees it — sed's escapes, grep's splitting at newlines — and
// what each says after it has taken one — the DFA's complaints — is the
// tool's own, and lives with it.
//
// glibc reads bytes, and so does this: the pattern is spelt in UTF-8 first.
// A byte past ASCII is never syntax. In a multibyte locale a character
// past ASCII is one token, which is what parse_expression makes of a lead
// byte and the continuation bytes it gathers after it, and a bracket takes
// it whole; in a byte locale each byte is a character of its own.

import { encodeUtf8Loose } from './bytes.js'
import { RegcompError, charAt, fail, parseBracket } from './regcomp-bracket.js'

export { utf8Width } from './regcomp-bracket.js'

// The syntax bits, with regex.h's values.
export const RE_BK_PLUS_QM = 1 << 1
export const RE_CHAR_CLASSES = 1 << 2
export const RE_CONTEXT_INDEP_ANCHORS = 1 << 3
export const RE_CONTEXT_INDEP_OPS = 1 << 4
export const RE_CONTEXT_INVALID_OPS = 1 << 5
export const RE_INTERVALS = 1 << 9
export const RE_NEWLINE_ALT = 1 << 11
export const RE_NO_BK_BRACES = 1 << 12
export const RE_NO_BK_PARENS = 1 << 13
export const RE_NO_BK_VBAR = 1 << 15
export const RE_NO_EMPTY_RANGES = 1 << 16
export const RE_UNMATCHED_RIGHT_PAREN_ORD = 1 << 17
export const RE_INVALID_INTERVAL_ORD = 1 << 21
export const RE_ICASE = 1 << 22
export const RE_CARET_ANCHORS_HERE = 1 << 23
export const RE_CONTEXT_INVALID_DUP = 1 << 24

// The syntaxes regex.h composes of them, as far as the parser goes. grep's
// two read a newline as `|`, which the patterns grep hands over never hold,
// and differ from POSIX's in what a repetition with nothing to repeat is: a
// BRE takes `\{` there as a character, an ERE passes over a `*`, `+`, `?`
// or `{`, and an ERE `{` that begins no valid interval is a character.
const POSIX_COMMON = RE_CHAR_CLASSES | RE_INTERVALS | RE_NO_EMPTY_RANGES
export const RE_SYNTAX_POSIX_BASIC = POSIX_COMMON | RE_BK_PLUS_QM | RE_CONTEXT_INVALID_DUP
export const RE_SYNTAX_POSIX_EXTENDED = POSIX_COMMON | RE_CONTEXT_INDEP_ANCHORS | RE_CONTEXT_INDEP_OPS | RE_NO_BK_BRACES |
  RE_NO_BK_PARENS | RE_NO_BK_VBAR | RE_CONTEXT_INVALID_OPS | RE_UNMATCHED_RIGHT_PAREN_ORD
export const RE_SYNTAX_GREP = (RE_SYNTAX_POSIX_BASIC | RE_NEWLINE_ALT) & ~RE_CONTEXT_INVALID_DUP
export const RE_SYNTAX_EGREP = (RE_SYNTAX_POSIX_EXTENDED | RE_INVALID_INTERVAL_ORD | RE_NEWLINE_ALT) & ~RE_CONTEXT_INVALID_OPS

// No interval bound may exceed it.
export const RE_DUP_MAX = 0x7fff

// Token types, as regcomp names them.
const T = {
  END_OF_RE: 'END_OF_RE', CHARACTER: 'CHARACTER', BACK_SLASH: 'BACK_SLASH', OP_ALT: 'OP_ALT', OP_BACK_REF: 'OP_BACK_REF',
  ANCHOR: 'ANCHOR', OP_WORD: 'OP_WORD', OP_NOTWORD: 'OP_NOTWORD', OP_SPACE: 'OP_SPACE', OP_NOTSPACE: 'OP_NOTSPACE',
  OP_OPEN_SUBEXP: 'OP_OPEN_SUBEXP', OP_CLOSE_SUBEXP: 'OP_CLOSE_SUBEXP', OP_DUP_ASTERISK: 'OP_DUP_ASTERISK',
  OP_DUP_PLUS: 'OP_DUP_PLUS', OP_DUP_QUESTION: 'OP_DUP_QUESTION', OP_OPEN_DUP_NUM: 'OP_OPEN_DUP_NUM',
  OP_CLOSE_DUP_NUM: 'OP_CLOSE_DUP_NUM', OP_OPEN_BRACKET: 'OP_OPEN_BRACKET', OP_PERIOD: 'OP_PERIOD',
}

// GNU's own operators, which a backslash makes in either syntax.
const GNU_ESCAPES = { '<': T.ANCHOR, '>': T.ANCHOR, b: T.ANCHOR, B: T.ANCHOR, '`': T.ANCHOR, "'": T.ANCHOR, w: T.OP_WORD, W: T.OP_NOTWORD, s: T.OP_SPACE, S: T.OP_NOTSPACE }

// The operators the syntax bits say how to spell, each with its bit.
const OPERATORS = {
  '|': [T.OP_ALT, RE_NO_BK_VBAR], '(': [T.OP_OPEN_SUBEXP, RE_NO_BK_PARENS], ')': [T.OP_CLOSE_SUBEXP, RE_NO_BK_PARENS],
  '{': [T.OP_OPEN_DUP_NUM, RE_NO_BK_BRACES], '}': [T.OP_CLOSE_DUP_NUM, RE_NO_BK_BRACES],
  '+': [T.OP_DUP_PLUS, RE_BK_PLUS_QM], '?': [T.OP_DUP_QUESTION, RE_BK_PLUS_QM],
}

// The operator `c` is, spelt after a backslash or bare, or null: `\+` and
// `\?` are operators with RE_BK_PLUS_QM and `+` and `?` without it; `\|`,
// `\(`, `\)`, `\{` and `\}` are operators without their RE_NO_BK_ bit and
// the bare ones with it; and the braces are none without RE_INTERVALS.
function operator(c, backslash, syntax) {
  if (!Object.hasOwn(OPERATORS, c)) return null
  const [type, bit] = OPERATORS[c]
  const spelt = bit === RE_BK_PLUS_QM ? Boolean(syntax & bit) : !(syntax & bit)
  const interval = type === T.OP_OPEN_DUP_NUM || type === T.OP_CLOSE_DUP_NUM
  return spelt === backslash && (!interval || syntax & RE_INTERVALS) ? type : null
}

// peek_token, at `at`, under `syntax`.
function peekToken(st, at, syntax) {
  const { s } = st
  if (at >= s.length) return { type: T.END_OF_RE, len: 0 }
  if (s[at] === 0x5c) {
    if (at + 1 >= s.length) return { type: T.BACK_SLASH, len: 1 }
    const { code, width } = charAt(st, at + 1)
    const c2 = String.fromCodePoint(code)
    const token = { type: T.CHARACTER, c: code, len: 1 + width, escaped: true }
    if (Object.hasOwn(GNU_ESCAPES, c2)) token.type = GNU_ESCAPES[c2]
    else if (c2 >= '1' && c2 <= '9') Object.assign(token, { type: T.OP_BACK_REF, idx: code - 0x31 })
    else token.type = operator(c2, true, syntax) ?? T.CHARACTER
    if (token.type === T.ANCHOR) token.kind = c2
    return token
  }
  const { code, width } = charAt(st, at)
  const c = String.fromCodePoint(code)
  const token = { type: T.CHARACTER, c: code, len: width }
  const type = operator(c, false, syntax)
  if (type) token.type = type
  else if (c === '\n' && syntax & RE_NEWLINE_ALT) token.type = T.OP_ALT
  else if (c === '*') token.type = T.OP_DUP_ASTERISK
  else if (c === '[') token.type = T.OP_OPEN_BRACKET
  else if (c === '.') token.type = T.OP_PERIOD
  else if (c === '^') {
    // A caret anchors where an expression begins (RE_CARET_ANCHORS_HERE,
    // which the parser passes there), at the start, and after a newline
    // that is an alternation — and anywhere with RE_CONTEXT_INDEP_ANCHORS.
    if (syntax & (RE_CONTEXT_INDEP_ANCHORS | RE_CARET_ANCHORS_HERE) || at === 0 || (syntax & RE_NEWLINE_ALT && s[at - 1] === 0x0a)) {
      Object.assign(token, { type: T.ANCHOR, kind: c })
    }
  } else if (c === '$') {
    // A dollar anchors at the end and before an alternation or a closing
    // group — and anywhere with RE_CONTEXT_INDEP_ANCHORS.
    const next = syntax & RE_CONTEXT_INDEP_ANCHORS || at + 1 === s.length ? null : peekToken(st, at + 1, syntax).type
    if (next === null || next === T.OP_ALT || next === T.OP_CLOSE_SUBEXP) Object.assign(token, { type: T.ANCHOR, kind: c })
  }
  return token
}

// fetch_token; `extra` is a bit the parser adds for this token alone.
function fetch(st, extra = 0) {
  st.token = peekToken(st, st.i, st.syntax | extra)
  st.i += st.token.len
}

// Compile PATTERN under SYNTAX. A fault comes back as `error`, regcomp's
// message for it. A pattern taken comes back as its `tree`, with the number
// of its groups (`nsub`), every bracket it holds in order (`brackets`) — the
// sets of the tree among them — and the code point of every character a
// backslash made literal (`escapes`), whether or not the tree still holds
// either, as an interval of `{0}` drops what it repeats. `multibyte` says
// whether a character of the locale can take more than one byte, and `up` is
// its towupper, which RE_ICASE reads the pattern through. The state the
// parser keeps carries the bits a bracket reads.
export function regcomp(pattern, syntax, { multibyte = true, up = (code) => code } = {}) {
  const st = {
    s: encodeUtf8Loose(pattern), i: 0, syntax, multibyte, up,
    icase: Boolean(syntax & RE_ICASE), charClasses: Boolean(syntax & RE_CHAR_CLASSES), noEmptyRanges: Boolean(syntax & RE_NO_EMPTY_RANGES),
    nsub: 0, completed: 0, token: null, brackets: [], escapes: [],
  }
  try {
    fetch(st, RE_CARET_ANCHORS_HERE)
    const tree = parseRegExp(st, 0)
    return { tree, nsub: st.nsub, brackets: st.brackets, escapes: st.escapes }
  } catch (e) {
    if (e instanceof RegcompError) return { error: e.message }
    throw e
  }
}

// A branch ends at `|`, at the end, and inside a group at its `)`.
const branchEnds = (st, nest) => st.token.type === T.OP_ALT || st.token.type === T.END_OF_RE || (nest > 0 && st.token.type === T.OP_CLOSE_SUBEXP)

// parse_reg_exp. A backreference in a branch may name only a group closed
// before it in that branch or before the alternation began.
function parseRegExp(st, nest) {
  const initial = st.completed
  let tree = parseBranch(st, nest)
  while (st.token.type === T.OP_ALT) {
    fetch(st, RE_CARET_ANCHORS_HERE)
    let branch = null
    if (!branchEnds(st, nest)) {
      const accumulated = st.completed
      st.completed = initial
      branch = parseBranch(st, nest)
      st.completed |= accumulated
    }
    tree = { t: 'alt', a: tree, b: branch }
  }
  return tree
}

function parseBranch(st, nest) {
  const nodes = []
  const tree = parseExpression(st, nest)
  if (tree) nodes.push(tree)
  for (;;) {
    if (branchEnds(st, nest)) break
    const expr = parseExpression(st, nest)
    if (expr) nodes.push(expr)
  }
  return nodes.length === 0 ? null : nodes.length === 1 ? nodes[0] : { t: 'cat', nodes }
}

const DUPS = new Set([T.OP_DUP_ASTERISK, T.OP_DUP_PLUS, T.OP_DUP_QUESTION, T.OP_OPEN_DUP_NUM])

// parse_expression. A repetition with nothing to repeat is an error with
// RE_CONTEXT_INVALID_OPS (an interval already with RE_CONTEXT_INVALID_DUP),
// passed over with RE_CONTEXT_INDEP_OPS, and a character otherwise; a `)`
// closing no group is an error unless RE_UNMATCHED_RIGHT_PAREN_ORD makes it
// a character.
function parseExpression(st, nest) {
  const { token, syntax } = st
  let tree
  switch (token.type) {
    case T.CHARACTER:
      if (token.escaped) st.escapes.push(token.c)
      tree = { t: 'char', c: String.fromCodePoint(token.c) }
      break
    case T.OP_OPEN_SUBEXP: tree = parseSubExp(st, nest + 1); break
    case T.OP_OPEN_BRACKET: tree = parseBracket(st); break
    case T.OP_BACK_REF:
      if (!(st.completed & (1 << token.idx))) fail('ESUBREG')
      tree = { t: 'backref', idx: token.idx + 1 }
      break
    case T.OP_OPEN_DUP_NUM:
      if (syntax & RE_CONTEXT_INVALID_DUP) fail('BADRPT')
    // falls through
    case T.OP_DUP_ASTERISK: case T.OP_DUP_PLUS: case T.OP_DUP_QUESTION:
      if (syntax & RE_CONTEXT_INVALID_OPS) fail('BADRPT')
      if (syntax & RE_CONTEXT_INDEP_OPS) {
        fetch(st)
        return parseExpression(st, nest)
      }
    // falls through
    case T.OP_CLOSE_SUBEXP:
      if (token.type === T.OP_CLOSE_SUBEXP && !(syntax & RE_UNMATCHED_RIGHT_PAREN_ORD)) fail('ERPAREN')
    // falls through
    case T.OP_CLOSE_DUP_NUM:
      tree = { t: 'char', c: String.fromCodePoint(token.c) }
      break
    case T.ANCHOR:
      // No repetition applies to an anchor: `^*` is an anchor and a star.
      tree = { t: 'anchor', kind: token.kind }
      fetch(st)
      return tree
    case T.OP_PERIOD: tree = { t: 'any' }; break
    case T.OP_WORD: case T.OP_NOTWORD: case T.OP_SPACE: case T.OP_NOTSPACE: tree = { t: 'escape', c: String.fromCodePoint(token.c) }; break
    case T.BACK_SLASH: return fail('EESCAPE')
    default: return null
  }
  fetch(st)
  while (DUPS.has(st.token.type)) {
    tree = parseDupOp(st, tree)
    // RE_CONTEXT_INVALID_DUP allows no star or interval straight after
    // another repetition.
    if (syntax & RE_CONTEXT_INVALID_DUP && (st.token.type === T.OP_DUP_ASTERISK || st.token.type === T.OP_OPEN_DUP_NUM)) fail('BADRPT')
  }
  return tree
}

// parse_sub_exp. The first nine groups are what a backreference can name.
function parseSubExp(st, nest) {
  const index = st.nsub++
  fetch(st, RE_CARET_ANCHORS_HERE)
  let tree = null
  if (st.token.type !== T.OP_CLOSE_SUBEXP) {
    tree = parseRegExp(st, nest)
    if (st.token.type !== T.OP_CLOSE_SUBEXP) fail('EPAREN')
  }
  if (index <= 8) st.completed |= 1 << index
  return { t: 'group', idx: index + 1, node: tree }
}

// fetch_number: -1 for an empty field, -2 for anything but digits.
function fetchNumber(st) {
  let num = -1
  for (;;) {
    fetch(st)
    const { type, c } = st.token
    if (type === T.END_OF_RE) return -2
    if (type === T.OP_CLOSE_DUP_NUM || c === 0x2c) return num
    num = type !== T.CHARACTER || !(c >= 0x30 && c <= 0x39) || num === -2 ? -2 : num === -1 ? c - 0x30 : Math.min(RE_DUP_MAX + 1, num * 10 + c - 0x30)
  }
}

// parse_dup_op. An interval that does not read as one is an error, unless
// RE_INVALID_INTERVAL_ORD takes its `{` back as a character, to read on
// from just after it.
function parseDupOp(st, elem) {
  const token = st.token
  const startIdx = st.i
  let end, start
  if (token.type === T.OP_OPEN_DUP_NUM) {
    end = 0
    start = fetchNumber(st)
    if (start === -1) {
      if (st.token.type === T.CHARACTER && st.token.c === 0x2c) start = 0
      else fail('BADBR')
    }
    if (start !== -2) {
      end = st.token.type === T.OP_CLOSE_DUP_NUM ? start
        : st.token.type === T.CHARACTER && st.token.c === 0x2c ? fetchNumber(st) : -2
    }
    if (start === -2 || end === -2) {
      if (!(st.syntax & RE_INVALID_INTERVAL_ORD)) fail(st.token.type === T.END_OF_RE ? 'EBRACE' : 'BADBR')
      st.i = startIdx
      st.token = { ...token, type: T.CHARACTER }
      return elem
    }
    if ((end !== -1 && start > end) || st.token.type !== T.OP_CLOSE_DUP_NUM) fail('BADBR')
    if (RE_DUP_MAX < (end === -1 ? start : end)) fail('ESIZE')
  } else {
    start = token.type === T.OP_DUP_PLUS ? 1 : 0
    end = token.type === T.OP_DUP_QUESTION ? 1 : -1
  }
  fetch(st)
  if (elem === null || (start === 0 && end === 0)) return null
  return { t: 'rep', node: elem, min: start, max: end === -1 ? null : end }
}
