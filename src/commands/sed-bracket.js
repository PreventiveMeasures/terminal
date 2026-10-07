// regcomp's bracket expressions (parse_bracket_exp in glibc 2.39's
// posix/regcomp.c), in C.UTF-8: a backslash is a member like any other, and,
// the locale having no collation rules, a character past ASCII is a member
// but no end of a range, and a collating symbol or an equivalence class is
// one character of ASCII.

export const REG = {
  BADPAT: 'Invalid regular expression',
  ECOLLATE: 'Invalid collation character',
  ECTYPE: 'Invalid character class name',
  EESCAPE: 'Trailing backslash',
  ESUBREG: 'Invalid back reference',
  EBRACK: 'Unmatched [, [^, [:, [., or [=',
  EPAREN: 'Unmatched ( or \\(',
  EBRACE: 'Unmatched \\{',
  BADBR: 'Invalid content of \\{\\}',
  ERANGE: 'Invalid range end',
  BADRPT: 'Invalid preceding regular expression',
  ESIZE: 'Regular expression too big',
  ERPAREN: 'Unmatched ) or \\)',
}

export class RegexError extends Error {}
export const fail = (code) => { throw new RegexError(code) }
export const charAt = (s, i) => String.fromCodePoint(s.codePointAt(i))
const utf8Length = (code) => code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4

const CLASSES = new Set(['alnum', 'cntrl', 'lower', 'space', 'alpha', 'digit', 'print', 'upper', 'blank', 'graph', 'punct', 'xdigit'])
const SYMBOLS = { '.': 'COLL', '=': 'EQUIV', ':': 'CLASS' }

// peek_token_bracket.
function peekBracket(st) {
  const { s, i } = st
  if (i >= s.length) return { type: 'END', len: 0 }
  const c = charAt(s, i)
  if (c === '[' && Object.hasOwn(SYMBOLS, s[i + 1] ?? '')) return { type: SYMBOLS[s[i + 1]], c: s[i + 1], len: 2 }
  const type = c === '-' ? 'RANGE' : c === ']' ? 'CLOSE' : c === '^' ? 'NOT' : 'CHAR'
  return { type, c, len: c.length }
}

// After the `[`; the bracket as its items, and where it started.
export function parseBracket(st) {
  const items = []
  const start = st.i - 1
  let negate = false
  let token = peekBracket(st)
  if (token.type === 'END') fail(REG.BADPAT)
  if (token.type === 'NOT') {
    negate = true
    st.i += token.len
    token = peekBracket(st)
    if (token.type === 'END') fail(REG.BADPAT)
  }
  if (token.type === 'CLOSE') token.type = 'CHAR'
  let firstRound = true
  for (;;) {
    const first = parseElement(st, token, firstRound)
    firstRound = false
    token = peekBracket(st)
    let range = null
    if (first.type !== 'CLASS' && first.type !== 'EQUIV') {
      if (token.type === 'END') fail(REG.EBRACK)
      if (token.type === 'RANGE') {
        st.i += token.len
        const next = peekBracket(st)
        if (next.type === 'END') fail(REG.EBRACK)
        if (next.type === 'CLOSE') {
          // A `-` before the closing bracket is a member.
          st.i -= token.len
          token.type = 'CHAR'
        } else range = next
      }
    }
    if (range) {
      const last = parseElement(st, range, true)
      token = peekBracket(st)
      items.push(buildRange(st, first, last))
    } else items.push(buildElement(first))
    if (token.type === 'END') fail(REG.EBRACK)
    if (token.type === 'CLOSE') break
  }
  st.i += token.len
  st.brackets.push({ start, items })
  return { t: 'set', negate, items }
}

function parseElement(st, token, acceptHyphen) {
  const code = st.s.codePointAt(st.i)
  if (code > 0x7f) {
    st.i += code > 0xffff ? 2 : 1
    return { type: 'MB', code }
  }
  st.i += token.len
  if (token.type === 'COLL' || token.type === 'CLASS' || token.type === 'EQUIV') return parseSymbol(st, token)
  // A `-` that is not last can only start a range, and here it cannot.
  if (token.type === 'RANGE' && !acceptHyphen && peekBracket(st).type !== 'CLOSE') fail(REG.ERANGE)
  return { type: 'SB', code: token.c.codePointAt(0) }
}

// [:name:], [.name.] or [=name=], of at most 31 bytes.
function parseSymbol(st, token) {
  const { s } = st
  const delim = token.c
  if (st.i >= s.length) fail(REG.EBRACK)
  let name = ''
  let bytes = 0
  for (;;) {
    if (bytes >= 32) fail(REG.EBRACK)
    const ch = charAt(s, st.i)
    st.i += ch.length
    bytes += utf8Length(ch.codePointAt(0))
    if (st.i >= s.length) fail(REG.EBRACK)
    if (ch === delim && s[st.i] === ']') break
    name += ch
  }
  st.i++
  return { type: token.type, name }
}

// Under I, regcomp reads the pattern through towupper, so a member is its
// upper case, and one that is past ASCII becomes a byte where its upper case
// is not.
function collationValue(st, element) {
  if (element.type === 'SB' || element.type === 'MB') {
    const code = st.icase ? st.up(element.code) : element.code
    return code > 0x7f ? null : code
  }
  if (element.type === 'COLL') {
    const name = st.icase ? [...element.name].map((c) => String.fromCodePoint(st.up(c.codePointAt(0)))).join('') : element.name
    return name.length === 1 && name.codePointAt(0) <= 0x7f ? name.codePointAt(0) : null
  }
  return null
}

function buildRange(st, first, last) {
  if (first.type === 'EQUIV' || first.type === 'CLASS' || last.type === 'EQUIV' || last.type === 'CLASS') fail(REG.ERANGE)
  const lo = collationValue(st, first)
  const hi = collationValue(st, last)
  if (lo === null || hi === null) fail(REG.ECOLLATE)
  if (lo > hi) fail(REG.ERANGE)
  const written = (element) => (element.type === 'COLL' ? element.name.codePointAt(0) : element.code)
  return { k: 'range', lo: written(first), hi: written(last) }
}

function buildElement(element) {
  switch (element.type) {
    case 'COLL':
    case 'EQUIV':
      if (element.name.length !== 1 || element.name.codePointAt(0) > 0x7f) fail(REG.ECOLLATE)
      return { k: 'char', code: element.name.codePointAt(0), coll: true }
    case 'CLASS':
      if (!CLASSES.has(element.name)) fail(REG.ECTYPE)
      return { k: 'class', name: element.name }
    default: return { k: 'char', code: element.code }
  }
}

// GNU's DFA, which compiles the pattern after regcomp has accepted it,
// rejects a bracket spelt like a class name without its own brackets —
// `[:space:]`: one that opens and closes on a colon, holds something else
// besides, and holds no class, range or collating element — and sed dies
// of it.
export function confusingBracket(pattern, brackets) {
  return brackets.some(({ start, items }) => {
    const open = pattern[start + 1] === '^' ? start + 2 : start + 1
    return pattern[open] === ':' && items.every((item) => item.k === 'char' && !item.coll)
      && items.at(-1).code === 0x3a && items.some((item) => item.code !== 0x3a)
  })
}
