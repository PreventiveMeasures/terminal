import { AwkRegex } from '../awk/regex.js'
import { decodeUtf8, encodeUtf8 } from '../util.js'
import { UnsupportedError } from '../unsupported.js'
import { EXTENDED_C, LOCALE, classTables, isByteLocale } from '../locale.js'
import { scriptGap } from './sed-common.js'
import { confusingBracket } from './sed-bracket.js'
import { emitRegex, parseGnuRegex } from './sed-regcomp.js'

// normalize_text's three readings of an escape: text (a, i, c and y) drops
// the backslash of one it does not know, a replacement or a regex passes it
// on for the next reader, and a replacement keeps an `&` or `\` it spelt by
// number literal. Escapes are converted inside brackets too.
export const TEXT_BUFFER = 'buffer'
export const TEXT_REPLACEMENT = 'replacement'
export const TEXT_REGEX = 'regex'

const CONTROLS = { a: 7, f: 12, n: 10, '\n': 10, r: 13, t: 9, v: 11 }
const BASES = { d: 10, o: 8, x: 16 }
const sequence = (byte) => byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 1

// `recursive` reports `\c\x` for the caller, which knows where the reader is.
export function normalizeText(text, type, recursive) {
  const input = encodeUtf8(text), out = []
  let i = 0
  while (i < input.length) {
    const byte = input[i]
    if (byte >= 0x80) {
      const end = Math.min(input.length, i + sequence(byte))
      while (i < end) out.push(input[i++])
      continue
    }
    if (byte !== 92 || i + 1 === input.length) { out.push(input[i++]); continue }
    const escape = String.fromCodePoint(input[++i])
    if (Object.hasOwn(CONTROLS, escape)) {
      out.push(CONTROLS[escape])
      i++
    } else if (Object.hasOwn(BASES, escape)) {
      const { produced, end } = convertNumber(input, i, BASES[escape])
      if (type === TEXT_REPLACEMENT && (produced === 38 || produced === 92)) out.push(92)
      out.push(produced)
      i = end
    } else if (escape === 'c') i = control(input, i, type, out, recursive)
    else {
      if (type !== TEXT_BUFFER) out.push(92)
      out.push(input[i++])
    }
  }
  return decodeUtf8(Uint8Array.from(out))
}

// convert_number: as many digits as fit a byte's worth of the base, after
// the letter at `at`; none leaves the letter itself.
function convertNumber(input, at, base) {
  let max = 1, value = 0
  let j = at + 1
  for (; j < input.length && max <= 255; j++, max *= base) {
    const c = input[j]
    const digit = c >= 48 && c <= 57 ? c - 48 : (c | 32) >= 97 && (c | 32) <= 102 ? (c | 32) - 87 : -1
    if (digit < 0 || digit >= base) break
    value = value * base + digit
  }
  return { produced: j === at + 1 ? input[at] : value & 255, end: j }
}

// `\cX`, the `c` at `at`: X upper-cased with its 0x40 bit flipped. A `\c`
// that ends the text passes its backslash on, and loses its `c`.
function control(input, at, type, out, recursive) {
  let i = at + 1
  if (i === input.length) {
    if (type !== TEXT_BUFFER) out.push(92)
    return i
  }
  const c = input[i]
  out.push((c >= 97 && c <= 122 ? c - 32 : c) ^ 64)
  if (c === 92 && input[++i] !== 92) recursive()
  return i + 1
}

// compile_regex: the pattern as match_slash collected it, which is not
// empty. A fault comes back as `error` (regcomp's, which sed reports where
// its reader stands) or `panic` (the DFA's, which it does not).
export function compileRegex(raw, { extended, icase, locale = LOCALE, neededSub, recursive }) {
  const pattern = normalizeText(raw, TEXT_REGEX, recursive)
  if (isByteLocale(locale) && /[\u0080-\u{10FFFF}]/u.test(pattern)) {
    throw new UnsupportedError('feature', 'locale', `matching non-ASCII text in the ${locale} locale is not supported`)
  }
  const tables = classTables(locale)
  const parsed = parseGnuRegex(pattern, { extended, icase, up: tables.up })
  if (parsed.error) return { error: parsed.error }
  if (neededSub && parsed.nsub < neededSub - 1) return { error: invalidReference(neededSub - 1) }
  if (confusingBracket(pattern, parsed.brackets)) return { panic: 'character class syntax is [[:space:]], not [:space:]' }
  if (parsed.gap) scriptGap(parsed.gap)
  const source = emitRegex(parsed.tree)
  let re
  try { re = new AwkRegex(source, icase, null, tables) } catch (e) {
    if (e.gap) throw e
    throw new UnsupportedError('feature', 'regex', `sed: this regular expression cannot be represented by the matcher: ${e.message}`)
  }
  return { regex: { re, noSub: !neededSub, nsub: parsed.nsub, locale, ignoreCase: icase, pattern } }
}

export const invalidReference = (n) => `invalid reference \\${n} on \`s' command's RHS`

export function checkRegexText(text, regex) {
  if (!/[\u0080-\u{10FFFF}]/u.test(text + regex.re.src)) return
  // The matcher reads a character at a time, which is C.UTF-8's reading and
  // no other locale's.
  if (regex.locale !== LOCALE) throw new UnsupportedError('feature', 'locale', `matching non-ASCII text in the ${regex.locale} locale is not supported`)
  // GNU's two matchers fold the Cyrillic Extended-C letters differently
  // (see EXTENDED_C in ../locale.js), so a match over them is refused.
  if (regex.ignoreCase && EXTENDED_C.test(text + regex.pattern)) scriptGap('case folding of Cyrillic Extended-C letters')
}

// match_regex: an empty regex is the last one used, which a substitution
// that wants its groups recompiles if it was compiled without them — and
// only then checks the references against it.
export function resolveRegex(regex, state, regsize, badProg) {
  let resolved = regex
  if (resolved === null) {
    resolved = state.last
    if (!resolved) throw badProg('no previous regular expression')
  } else state.last = resolved
  if (resolved.noSub && regsize) {
    if (resolved.nsub < regsize - 1) throw badProg(invalidReference(regsize - 1))
    resolved.noSub = false
  }
  return resolved
}

export function matchesRegex(regex, text, state, badProg) {
  const resolved = resolveRegex(regex, state, 0, badProg)
  checkRegexText(text, resolved)
  return resolved.re.search(text, 0) !== null
}

// setup_replacement: literal runs, each followed by a reference (`id`, 0
// for `&`) and carrying the case conversion in force (`type`).
export const REPL = { ASIS: 0, UPPER: 1, LOWER: 2, UPPER_FIRST: 4, LOWER_FIRST: 8 }
const MODIFIERS = REPL.UPPER_FIRST | REPL.LOWER_FIRST

export function setupReplacement(raw, recursive) {
  const text = normalizeText(raw, TEXT_REPLACEMENT, recursive)
  const parts = []
  let base = 0, maxId = 0, save = REPL.ASIS, type = REPL.ASIS
  for (let p = 0; p < text.length; p++) {
    const c = text[p]
    if (c === '&') {
      parts.push({ text: text.slice(base, p), id: 0, type })
      type = save
      base = p + 1
      continue
    }
    if (c !== '\\') continue
    const part = { text: text.slice(base, p), id: -1, type }
    parts.push(part)
    type = save
    if (++p === text.length) { part.text += '\\'; base = p; break }
    const escape = String.fromCodePoint(text.codePointAt(p))
    if (escape >= '0' && escape <= '9') {
      part.id = Number(escape)
      maxId = Math.max(maxId, part.id)
    } else if (escape === 'L' || escape === 'U' || escape === 'E') {
      type = save = escape === 'L' ? REPL.LOWER : escape === 'U' ? REPL.UPPER : REPL.ASIS
    } else if (escape === 'l' || escape === 'u') {
      save = type
      type |= escape === 'l' ? REPL.LOWER_FIRST : REPL.UPPER_FIRST
    } else {
      // GNU takes one byte of an escaped character as the escaped one, so a
      // case conversion does not reach a character past ASCII spelt so.
      if (escape.codePointAt(0) > 0x7f && (part.type !== REPL.ASIS || type !== REPL.ASIS)) scriptGap('case conversion of an escaped multibyte character')
      part.text += escape
    }
    p += escape.length - 1
    base = p + 1
  }
  if (base < text.length) parts.push({ text: text.slice(base), id: -1, type })
  return { parts, maxId }
}

// str_append_modified, by glibc's towupper and towlower.
function appendModified(text, type, tables) {
  if (type === REPL.ASIS) return text
  let out = ''
  let rest = type
  for (let i = 0; i < text.length;) {
    let code = text.codePointAt(i)
    i += code > 0xffff ? 2 : 1
    if (rest & MODIFIERS) {
      code = rest & REPL.UPPER_FIRST ? tables.up(code) : tables.low(code)
      rest &= ~MODIFIERS
      if (rest === REPL.ASIS) return out + String.fromCodePoint(code) + text.slice(i)
    } else code = rest & REPL.UPPER ? tables.up(code) : tables.low(code)
    out += String.fromCodePoint(code)
  }
  return out
}

// append_replacement: a \u or \l before a reference that matched nothing
// waits for the next one.
function expand(parts, groupText, nsub, tables) {
  let out = ''
  let pending = 0
  for (const part of parts) {
    let type = part.type & MODIFIERS ? part.type : part.type | pending
    pending = 0
    if (part.text) {
      out += appendModified(part.text, type, tables)
      type &= ~MODIFIERS
    }
    if (part.id < 0 || part.id > nsub) continue
    const matched = groupText(part.id)
    if (!matched && part.type & MODIFIERS) pending = type & MODIFIERS
    else if (matched) out += appendModified(matched, type, tables)
  }
  return out
}

// do_subst. A match is replaced when it is the numbered one or later under
// g; an empty match right after a replaced one is passed over, as is the
// character after any empty match that was not replaced.
export function substitute(text, command, state, badProg) {
  const regex = resolveRegex(command.regex, state, command.maxId + 1, badProg)
  checkRegexText(text, regex)
  const tables = classTables(regex.locale)
  const needsGroups = command.parts.some((part) => part.id > 0 && part.id <= regex.nsub)
  let m = regex.re.search(text, 0)
  if (!m) return { out: text, replaced: false }
  let again = true, count = 0, lastEnd = 0, out = '', replaced = false, start = 0
  do {
    const offset = m.start
    let matched = m.end - m.start
    if (start < offset) { out += text.slice(start, offset); start = offset }
    if ((matched > 0 || count === 0 || offset > lastEnd) && ++count >= command.nth) {
      replaced = true
      const groups = needsGroups ? regex.re.groups(text, m.start, m.end) : null
      const match = m
      out += expand(command.parts, (id) => (id === 0 ? text.slice(match.start, match.end) : groups?.[id]?.text ?? ''), regex.nsub, tables)
      again = command.global
    } else {
      if (matched === 0) {
        if (start >= text.length) break
        // GNU steps over one byte, and searches on from inside the
        // character: what it finds there splits the character.
        if (text.codePointAt(start) > 0x7f) {
          throw new UnsupportedError('feature', 'empty match before a multibyte character', 'sed: a substitution stepping past an empty match before a character past ASCII is not supported')
        }
        matched = 1
      }
      out += text.slice(offset, offset + matched)
    }
    start = offset + matched
    lastEnd = m.end
  } while (again && start <= text.length && (m = regex.re.search(text, start)))
  if (start < text.length) out += text.slice(start)
  return { out: count < command.nth ? text : out, replaced }
}
