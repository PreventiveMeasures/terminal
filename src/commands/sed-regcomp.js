// GNU sed hands a regular expression to glibc's regcomp, and what regcomp
// says of a malformed one is what sed prints: the first fault its parser
// meets, in the order it meets them. This is that parser (posix/regcomp.c of
// glibc 2.39, in C.UTF-8, with the syntax bits sed 4.9 sets), reading the
// pattern token by token as regcomp does and failing with its message. A
// pattern it accepts comes back as a tree, spelt out again for the AWK
// matcher (../awk/regex.js) so that nothing between the two reads it a
// second time by other rules: a backslash in a bracket is a member, as it
// is to glibc, and an escape that is no operator is the character itself.

import { scriptGap } from './sed-common.js'
import { REG, RegexError, charAt, fail, parseBracket } from './sed-bracket.js'

const RE_DUP_MAX = 0x7fff

// Token types, as regcomp names them.
const T = {
  END: 'END', CHAR: 'CHAR', BACK_SLASH: 'BACK_SLASH', ALT: 'ALT', BACK_REF: 'BACK_REF', ANCHOR: 'ANCHOR',
  WORD: 'WORD', NOTWORD: 'NOTWORD', SPACE: 'SPACE', NOTSPACE: 'NOTSPACE', OPEN: 'OPEN', CLOSE: 'CLOSE',
  STAR: 'STAR', PLUS: 'PLUS', QUESTION: 'QUESTION', OPEN_DUP: 'OPEN_DUP', CLOSE_DUP: 'CLOSE_DUP',
  BRACKET: 'BRACKET', PERIOD: 'PERIOD',
}

// What a backslash makes of the character after it: GNU's operators in
// both syntaxes, and in a BRE the ones an ERE spells bare.
const ESCAPED = { '<': T.ANCHOR, '>': T.ANCHOR, b: T.ANCHOR, B: T.ANCHOR, '`': T.ANCHOR, "'": T.ANCHOR, w: T.WORD, W: T.NOTWORD, s: T.SPACE, S: T.NOTSPACE }
const BRE_ESCAPED = { '|': T.ALT, '(': T.OPEN, ')': T.CLOSE, '+': T.PLUS, '?': T.QUESTION, '{': T.OPEN_DUP, '}': T.CLOSE_DUP }
const ERE_BARE = { '|': T.ALT, '+': T.PLUS, '?': T.QUESTION, '{': T.OPEN_DUP, '}': T.CLOSE_DUP, '(': T.OPEN, ')': T.CLOSE }
const BARE = { '*': T.STAR, '[': T.BRACKET, '.': T.PERIOD }

// peek_token. A multibyte character is one CHARACTER token here, which is
// what regcomp's run of continuation bytes amounts to.
function peekToken(st, i, caretHere) {
  const { s, ere } = st
  if (i >= s.length) return { type: T.END, len: 0 }
  const c = charAt(s, i)
  if (c === '\\') {
    if (i + 1 >= s.length) return { type: T.BACK_SLASH, len: 1 }
    const c2 = charAt(s, i + 1)
    const token = { type: T.CHAR, c: c2, len: 1 + c2.length, escaped: true }
    if (Object.hasOwn(ESCAPED, c2)) token.type = ESCAPED[c2]
    else if (!ere && Object.hasOwn(BRE_ESCAPED, c2)) token.type = BRE_ESCAPED[c2]
    else if (c2 >= '1' && c2 <= '9') Object.assign(token, { type: T.BACK_REF, idx: Number(c2) - 1 })
    if (token.type === T.ANCHOR) token.kind = c2
    return token
  }
  const token = { type: T.CHAR, c, len: c.length }
  if (Object.hasOwn(BARE, c)) token.type = BARE[c]
  else if (ere && Object.hasOwn(ERE_BARE, c)) token.type = ERE_BARE[c]
  // A BRE caret anchors only where an expression starts, and a BRE dollar
  // only where one ends.
  else if (c === '^' && (ere || caretHere || i === 0)) Object.assign(token, { type: T.ANCHOR, kind: c })
  else if (c === '$' && (ere || i + 1 === s.length || [T.ALT, T.CLOSE].includes(peekToken(st, i + 1, false).type))) {
    Object.assign(token, { type: T.ANCHOR, kind: c })
  }
  return token
}

function fetch(st, caretHere = false) {
  st.token = peekToken(st, st.i, caretHere)
  st.i += st.token.len
}

// Parse PATTERN as glibc does under sed's syntax; throw the regcomp message
// of its first fault. `icase` is the I flag, under which regcomp reads the
// pattern upper-cased (`up`), which is what decides whether a range runs
// backwards.
export function parseGnuRegex(pattern, { extended, icase = false, up = (code) => code }) {
  const st = { s: pattern, i: 0, ere: extended, icase, up, nsub: 0, completed: 0, token: null, brackets: [], gap: null }
  try {
    fetch(st, true)
    const tree = parseRegExp(st, 0)
    return { tree, nsub: st.nsub, brackets: st.brackets, gap: st.gap }
  } catch (e) {
    if (e instanceof RegexError) return { error: e.message }
    throw e
  }
}

// A branch ends at `|`, at the end, and inside a group at its `)`.
const branchEnds = (st, nest) => st.token.type === T.ALT || st.token.type === T.END || (nest > 0 && st.token.type === T.CLOSE)

function parseRegExp(st, nest) {
  const initial = st.completed
  let tree = parseBranch(st, nest)
  while (st.token.type === T.ALT) {
    fetch(st, true)
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

function parseExpression(st, nest) {
  const token = st.token
  let tree
  switch (token.type) {
    case T.CHAR:
      // Under I, regcomp takes an escaped character as written but matches
      // it against upper-cased text, so an escaped lower-case letter matches
      // nothing — a quirk the matcher here does not share.
      if (token.escaped && st.icase && (token.c.codePointAt(0) > 0x7f || st.up(token.c.codePointAt(0)) !== token.c.codePointAt(0))) {
        st.gap = 'case-insensitive escaped letter'
      }
      tree = { t: 'char', c: token.c }
      break
    case T.OPEN: tree = parseSubExp(st, nest + 1); break
    case T.BRACKET: tree = parseBracket(st); break
    case T.BACK_REF:
      if (!(st.completed & (1 << token.idx))) fail(REG.ESUBREG)
      tree = { t: 'backref', idx: token.idx + 1 }
      break
    case T.OPEN_DUP:
    case T.STAR: case T.PLUS: case T.QUESTION:
    case T.CLOSE: case T.CLOSE_DUP:
      // BRE: a leading interval is an error and a leading star a literal;
      // ERE: any leading repetition is an error, as is a stray `)`.
      if (token.type === T.OPEN_DUP && !st.ere) fail(REG.BADRPT)
      if (token.type !== T.CLOSE && token.type !== T.CLOSE_DUP && st.ere) fail(REG.BADRPT)
      if (token.type === T.CLOSE) fail(REG.ERPAREN)
      tree = { t: 'char', c: token.c }
      break
    case T.ANCHOR:
      // No repetition applies to an anchor: `^*` is an anchor and a star.
      tree = { t: 'anchor', kind: token.kind }
      fetch(st)
      return tree
    case T.PERIOD: tree = { t: 'any' }; break
    case T.WORD: case T.NOTWORD: case T.SPACE: case T.NOTSPACE: tree = { t: 'escape', c: token.c }; break
    case T.BACK_SLASH: return fail(REG.EESCAPE)
    default: return null
  }
  fetch(st)
  while ([T.STAR, T.PLUS, T.QUESTION, T.OPEN_DUP].includes(st.token.type)) {
    tree = parseDupOp(st, tree)
    // BRE allows no star or interval straight after another repetition.
    if (!st.ere && (st.token.type === T.STAR || st.token.type === T.OPEN_DUP)) fail(REG.BADRPT)
  }
  return tree
}

function parseSubExp(st, nest) {
  const index = st.nsub++
  fetch(st, true)
  let tree = null
  if (st.token.type !== T.CLOSE) {
    tree = parseRegExp(st, nest)
    if (st.token.type !== T.CLOSE) fail(REG.EPAREN)
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
    if (type === T.END) return -2
    if (type === T.CLOSE_DUP || c === ',') return num
    num = type !== T.CHAR || !(c >= '0' && c <= '9') || num === -2 ? -2 : num === -1 ? Number(c) : Math.min(RE_DUP_MAX + 1, num * 10 + Number(c))
  }
}

function parseDupOp(st, elem) {
  const token = st.token
  let end, start
  if (token.type === T.OPEN_DUP) {
    end = 0
    start = fetchNumber(st)
    if (start === -1) {
      if (st.token.type === T.CHAR && st.token.c === ',') start = 0
      else fail(REG.BADBR)
    }
    if (start !== -2) {
      end = st.token.type === T.CLOSE_DUP ? start
        : st.token.type === T.CHAR && st.token.c === ',' ? fetchNumber(st) : -2
    }
    if (start === -2 || end === -2) fail(st.token.type === T.END ? REG.EBRACE : REG.BADBR)
    if ((end !== -1 && start > end) || st.token.type !== T.CLOSE_DUP) fail(REG.BADBR)
    if (RE_DUP_MAX < (end === -1 ? start : end)) fail(REG.ESIZE)
  } else {
    start = token.type === T.PLUS ? 1 : 0
    end = token.type === T.QUESTION ? 1 : -1
  }
  fetch(st)
  if (elem === null || (start === 0 && end === 0)) return null
  return { t: 'rep', node: elem, min: start, max: end === -1 ? null : end }
}

// The tree as the AWK matcher's ERE: `\` escapes only its syntax, a bracket
// spells its members so that none reads as syntax, and GNU's `\b` is its
// `\y`. Backreferences have no matcher here.
const SYNTAX = '^$.[]|()*+?{}\\/"'
const ANCHORS = { '^': '^', $: '$', '<': '\\<', '>': '\\>', b: '\\y', B: '\\B', '`': '\\`', "'": "\\'" }

export function emitRegex(tree) {
  if (tree === null) return ''
  switch (tree.t) {
    case 'char': return SYNTAX.includes(tree.c) ? '\\' + tree.c : tree.c
    case 'any': return '.'
    case 'anchor': return ANCHORS[tree.kind]
    case 'escape': return '\\' + tree.c
    case 'group': return '(' + emitRegex(tree.node) + ')'
    case 'cat': return tree.nodes.map(emitRegex).join('')
    case 'alt': return emitRegex(tree.a) + '|' + emitRegex(tree.b)
    case 'rep': return emitRegex(tree.node) + quantifier(tree.min, tree.max)
    case 'set': return '[' + (tree.negate ? '^' : '') + tree.items.map(emitItem).join('') + ']'
    default: return scriptGap('regex backreferences')
  }
}

function quantifier(min, max) {
  if (max === null) return min === 0 ? '*' : min === 1 ? '+' : `{${min},}`
  if (min === 0 && max === 1) return '?'
  return min === max ? `{${min}}` : `{${min},${max}}`
}

const member = (code) => {
  const c = String.fromCodePoint(code)
  return '\\]^-['.includes(c) ? '\\' + c : c
}

function emitItem(item) {
  if (item.k === 'class') return `[:${item.name}:]`
  if (item.k === 'range') return `${member(item.lo)}-${member(item.hi)}`
  return member(item.code)
}
