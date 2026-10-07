// regcomp's bracket expressions — parse_bracket_exp in glibc 2.39's
// posix/regcomp.c and the functions below it — for ./regcomp.js, together
// with what the two halves of the parser share: regcomp's messages, and how
// a character is read out of the pattern's bytes. In a bracket a backslash is
// a member like any other. C.UTF-8 has no collation rules, so a character of
// more than one byte is a member but no end of a range, and a collating
// symbol or an equivalence class is the one byte it names.

import { encodeUtf8Loose } from './bytes.js'

// __re_error_msgid, for the codes the parser can give.
const MESSAGES = {
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

export class RegcompError extends Error {}
export const fail = (code) => { throw new RegcompError(MESSAGES[code]) }

// How many bytes the character a lead byte starts takes.
export const utf8Width = (lead) => (lead < 0xc0 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4)

// The character at `at` of the pattern `st.s`: its code point and how many
// bytes spell it. In a byte locale every byte is a character.
export function charAt(st, at) {
  const lead = st.s[at]
  if (!st.multibyte || lead < 0xc0) return { code: lead, width: 1 }
  const width = Math.min(utf8Width(lead), st.s.length - at)
  let code = lead & (0xff >> (width + 1))
  for (let k = 1; k < width; k++) code = (code << 6) | (st.s[at + k] & 0x3f)
  return { code, width }
}

// Bracket token types, as regcomp names them.
const B = {
  END_OF_RE: 'END_OF_RE', CHARACTER: 'CHARACTER', OP_CHARSET_RANGE: 'OP_CHARSET_RANGE', OP_CLOSE_BRACKET: 'OP_CLOSE_BRACKET',
  OP_NON_MATCH_LIST: 'OP_NON_MATCH_LIST', OP_OPEN_COLL_ELEM: 'OP_OPEN_COLL_ELEM', OP_OPEN_EQUIV_CLASS: 'OP_OPEN_EQUIV_CLASS',
  OP_OPEN_CHAR_CLASS: 'OP_OPEN_CHAR_CLASS',
}
const BRACKET_SPECIALS = { 0x2d: B.OP_CHARSET_RANGE, 0x5d: B.OP_CLOSE_BRACKET, 0x5e: B.OP_NON_MATCH_LIST }

// peek_token_bracket. `[:` opens a class only with RE_CHAR_CLASSES.
function peekBracket(st) {
  const { s, i } = st
  if (i >= s.length) return { type: B.END_OF_RE, len: 0 }
  const c = s[i]
  if (c === 0x5b && i + 1 < s.length) {
    const c2 = s[i + 1]
    const type = c2 === 0x2e ? B.OP_OPEN_COLL_ELEM : c2 === 0x3d ? B.OP_OPEN_EQUIV_CLASS
      : c2 === 0x3a && st.charClasses ? B.OP_OPEN_CHAR_CLASS : null
    if (type) return { type, c: c2, len: 2 }
  }
  return { type: BRACKET_SPECIALS[c] ?? B.CHARACTER, c, len: 1 }
}

// Elements of a bracket, as regcomp names them.
const E = { SB_CHAR: 'SB_CHAR', MB_CHAR: 'MB_CHAR', COLL_SYM: 'COLL_SYM', EQUIV_CLASS: 'EQUIV_CLASS', CHAR_CLASS: 'CHAR_CLASS' }
const SYMBOLS = { [B.OP_OPEN_COLL_ELEM]: E.COLL_SYM, [B.OP_OPEN_EQUIV_CLASS]: E.EQUIV_CLASS, [B.OP_OPEN_CHAR_CLASS]: E.CHAR_CLASS }

// parse_bracket_exp, after the `[`: the bracket as a set of items, each a
// character (`coll` where a collating symbol or an equivalence class names
// it), a range between two characters as they are written, or a class.
// (gnulib's copy reads `---` as one `-`, as V7 grep did; glibc's does not.)
export function parseBracket(st) {
  const items = []
  let negate = false
  let token = peekBracket(st)
  if (token.type === B.END_OF_RE) fail('BADPAT')
  if (token.type === B.OP_NON_MATCH_LIST) {
    negate = true
    st.i += token.len
    token = peekBracket(st)
    if (token.type === B.END_OF_RE) fail('BADPAT')
  }
  // A `]` first is a member.
  if (token.type === B.OP_CLOSE_BRACKET) token.type = B.CHARACTER
  for (let firstRound = true; ; firstRound = false) {
    const first = parseElement(st, token, firstRound)
    token = peekBracket(st)
    let range = null
    if (first.type !== E.CHAR_CLASS && first.type !== E.EQUIV_CLASS) {
      if (token.type === B.END_OF_RE) fail('EBRACK')
      if (token.type === B.OP_CHARSET_RANGE) {
        st.i += token.len
        const next = peekBracket(st)
        if (next.type === B.END_OF_RE) fail('EBRACK')
        if (next.type === B.OP_CLOSE_BRACKET) {
          // A `-` before the closing bracket is a member.
          st.i -= token.len
          token.type = B.CHARACTER
        } else range = next
      }
    }
    if (range) {
      const last = parseElement(st, range, true)
      token = peekBracket(st)
      items.push(buildRange(st, first, last))
    } else items.push(buildElement(first))
    if (token.type === B.END_OF_RE) fail('EBRACK')
    if (token.type === B.OP_CLOSE_BRACKET) break
  }
  st.i += token.len
  const set = { t: 'set', negate, items }
  st.brackets.push(set)
  return set
}

// parse_bracket_element. A character of more than one byte is taken whole.
function parseElement(st, token, acceptHyphen) {
  if (st.multibyte && st.s[st.i] >= 0xc0) {
    const { code, width } = charAt(st, st.i)
    st.i += width
    return { type: E.MB_CHAR, code }
  }
  st.i += token.len
  if (Object.hasOwn(SYMBOLS, token.type)) return parseSymbol(st, token)
  // A `-` that is not last can only start a range, and here it cannot.
  if (token.type === B.OP_CHARSET_RANGE && !acceptHyphen && peekBracket(st).type !== B.OP_CLOSE_BRACKET) fail('ERANGE')
  return { type: E.SB_CHAR, code: token.c }
}

// Under RE_ICASE regcomp reads the pattern through towupper, so a member is
// its upper case, and one past ASCII becomes a byte where its upper case is
// one. In a byte locale a byte past ASCII has no case.
const fold = (st, code) => (st.icase && (st.multibyte || code < 0x80) ? st.up(code) : code)

// The bytes that spell a character.
const bytesOf = (st, code) => (st.multibyte && code > 0x7f ? [...encodeUtf8Loose(String.fromCodePoint(code))] : [code])

// parse_bracket_symbol: [:name:], [.name.] or [=name=], its name as bytes,
// at most 31 of them, and the first character it is written with. Under
// RE_ICASE the bytes are those of the upper-cased pattern regcomp reads, so
// `[.ı.]` names the one byte `I` and the 31 are counted in those — save
// that a class name keeps its ASCII as written (re_string_fetch_byte_case),
// which is what decides whether it names a class at all.
function parseSymbol(st, token) {
  const { s } = st
  if (st.i >= s.length) fail('EBRACK')
  const folds = token.type === B.OP_OPEN_CHAR_CLASS ? (code) => code > 0x7f : () => true
  const first = charAt(st, st.i).code
  const name = []
  let pending = []
  for (;;) {
    if (name.length >= 32) fail('EBRACK')
    if (pending.length === 0) {
      const { code, width } = charAt(st, st.i)
      pending = st.icase && folds(code) ? bytesOf(st, fold(st, code)) : [...s.subarray(st.i, st.i + width)]
      st.i += width
    }
    const ch = pending.shift()
    if (pending.length === 0 && st.i >= s.length) fail('EBRACK')
    if (ch === token.c && pending.length === 0 && s[st.i] === 0x5d) break
    name.push(ch)
  }
  st.i++
  return { type: SYMBOLS[token.type], name, first }
}

// The collation sequence value of a range's end, which without collation
// rules is the byte a single-byte character or a one-byte collating symbol
// is; a character of more bytes has none.
function rangeValue(st, element) {
  switch (element.type) {
    case E.SB_CHAR: return fold(st, element.code)
    case E.MB_CHAR: {
      const code = fold(st, element.code)
      return code < 0x80 ? code : null
    }
    case E.COLL_SYM: return element.name.length === 1 ? element.name[0] : null
    default: return null
  }
}

// What a range's end is written as: a collating symbol's first character.
const written = (element) => (element.type === E.COLL_SYM ? element.first : element.code)

// build_range_exp. A range may not run backwards with RE_NO_EMPTY_RANGES.
function buildRange(st, first, last) {
  const set = (element) => element.type === E.EQUIV_CLASS || element.type === E.CHAR_CLASS
  if (set(first) || set(last)) fail('ERANGE')
  const lo = rangeValue(st, first)
  const hi = rangeValue(st, last)
  if (lo === null || hi === null) fail('ECOLLATE')
  if (st.noEmptyRanges && lo > hi) fail('ERANGE')
  return { k: 'range', lo: written(first), hi: written(last) }
}

// The classes glibc knows by name. GNU's `[:word:]` is not one of them.
const CLASSES = new Set(['alnum', 'cntrl', 'lower', 'space', 'alpha', 'digit', 'print', 'upper', 'blank', 'graph', 'punct', 'xdigit'])

// build_collating_symbol, build_equiv_class and build_charclass: a
// collating symbol or an equivalence class is the one byte it names, and
// stands here for the character it is written with.
function buildElement(element) {
  switch (element.type) {
    case E.COLL_SYM:
    case E.EQUIV_CLASS:
      if (element.name.length !== 1) fail('ECOLLATE')
      return { k: 'char', code: element.first, coll: true }
    case E.CHAR_CLASS: {
      const name = String.fromCodePoint(...element.name)
      if (!CLASSES.has(name)) fail('ECTYPE')
      return { k: 'class', name }
    }
    default: return { k: 'char', code: element.code }
  }
}
