// What a plain literal is in each dialect, and whether the bytes of a file
// this terminal cannot read as text can hold it: GNU and ripgrep print
// nothing for such a file where they cannot, so neither does this. And what
// GNU's matchers make of a byte in such a file that spells no character,
// which a search reads as a marker of its own (decodeUtf8Marked in
// ../bytes.js), spelt for the JS matcher grepSource builds.
import { LOCALE, classTables } from '../locale.js'
import { compileNfa, search } from '../awk/re.js'
import { encodeUtf8 } from '../util.js'

// The bytes a plain literal can be, character by character: what each one is
// as written, or the bytes of each character it stands for where `-i` folds
// it — `s` for `s`, `S` and `ſ`, which are one, one and two bytes.
function literalMask({ pattern, tables }, folded) {
  return [...pattern].map((character) => {
    const codes = folded ? tables.fold(character.codePointAt(0)) : [character.codePointAt(0)]
    return codes.map((code) => encodeUtf8(String.fromCodePoint(code)))
  })
}

// Whether these bytes can hold no match at all: every pattern is a plain
// literal that is nowhere in the file, whichever of its spellings is looked
// for. A search would find nothing there, which is what GNU prints for such
// a file and all this terminal has to do. Anything else has to be read to
// know. A character is one byte at least, so nothing can begin past the end.
export function cannotHoldMatch(bytes, res) {
  return res.every((re) => {
    if (!re.literal) return false
    re.literalMask ??= literalMask(re.literal, re.folded)
    return !holdsMask(bytes, re.literalMask)
  })
}

// The same question, asked of patterns that were never compiled here: `rg`
// reads its own dialect and only needs to know whether a plain literal, as
// written, is anywhere in the bytes at all. Nothing else answers, and a
// folded one does not either — ripgrep folds case by its own tables.
export function literalsMissing(bytes, patterns, literal, locale = LOCALE) {
  const tables = classTables(locale)
  return patterns.every((pattern) => (literal || !METACHARACTER.test(pattern)) && pattern.isWellFormed() &&
    !holdsMask(bytes, literalMask({ pattern, tables }, false)))
}

function holdsMask(haystack, mask) {
  for (let at = 0; at + mask.length <= haystack.length; at++) if (maskAt(haystack, at, mask, 0)) return true
  return false
}

function maskAt(haystack, at, mask, i) {
  if (i === mask.length) return true
  return mask[i].some((option) => option.every((byte, k) => haystack[at + k] === byte) && maskAt(haystack, at + option.length, mask, i + 1))
}

// What makes a pattern more than the characters it spells.
const METACHARACTER = /[\\.^$*+?()[\]{}|]/u

// What makes a GNU pattern more than the characters it spells, by dialect: a
// BRE reads `(`, `{`, `|`, `+` and `?` as themselves and needs a backslash
// to make operators of them, which an ERE does not.
const BRE_SPECIAL = new Set('\\.[*^$')
const ERE_SPECIAL = new Set('\\.[*^$+?(){}|')

// The text a pattern selects when it is a plain literal, or null when it is
// more than that. `-F` is always one, and a GNU pattern is one where every
// special character in its dialect is escaped into itself: `foo(` in a BRE,
// `foo\(` in an ERE, `a\.b` in either. Any other escape — `\(` in a BRE,
// `\w`, `\<` — is an operator. `-P` keeps the reading `rg` has.
export function literalText(pattern, flags) {
  if (flags.has('F')) return pattern
  if (flags.has('P')) return METACHARACTER.test(pattern) ? null : pattern
  const special = flags.has('E') ? ERE_SPECIAL : BRE_SPECIAL
  let text = ''
  for (let i = 0; i < pattern.length; i++) {
    const escaped = pattern[i] === '\\'
    const c = escaped ? pattern[++i] : pattern[i]
    if (special.has(c) !== escaped) return null
    text += c
  }
  return text
}

// A byte that spells no character is one no pattern names: GNU's matchers
// never take it for a wildcard, a set or a literal, whatever the set holds.
// It still sits between characters, and where glibc's regex asks whether a
// word starts or ends there it reads the byte as the character of that value,
// as the C locale reads every byte — so after 0xE9, read as `é`, no word
// starts at a letter, and after 0xD7, read as `×`, one does. `-w` asks GNU's
// own word test instead, which takes such a byte for no word character at
// all; its lookarounds are plain sets, which hold no marker, and say the same.
export const MARKERS = '\\uDC80-\\uDCFF'
const MARKED = new Map()

export function markedAssertions(tables) {
  if (MARKED.has(tables)) return MARKED.get(tables)
  const js = tables.assertions()
  let latin = ''
  for (let byte = 0x80; byte <= 0xff; byte++) if (tables.has('word', byte)) latin += `\\u${(0xdc00 + byte).toString(16)}`
  const w = `[${js.word.slice(1, -1)}${latin}]`
  const set = {
    '<': `(?<!${w})(?=${w})`, '>': `(?<=${w})(?!${w})`,
    b: `(?:(?<!${w})(?=${w})|(?<=${w})(?!${w}))`, B: `(?:(?<=${w})(?=${w})|(?<!${w})(?!${w}))`,
    w: js.word, W: markedClass(js.nonWord), s: js.space, S: markedClass(js.nonSpace), '`': '^', "'": '$',
  }
  MARKED.set(tables, set)
  return set
}

// A set that leaves things out would take a marker, and one that names what
// it holds may span the markers with a range, so either is kept off them.
export const markedClass = (cls) => `(?:(?![${MARKERS}])${cls})`

// The extent matcher `-o` uses, reading a marker as the JS matcher does: as
// nothing a wildcard or a set takes, and as the Latin-1 character it stands
// for where a word edge is asked about.
const isMarker = (code) => code >= 0xdc80 && code <= 0xdcff

export function markedExtent(extent) {
  const nfa = compileNfa(extent.ast, extent.tables)
  const states = nfa.states.map((s) => {
    if (s.op === 'any') return { op: 'set', test: (code) => !isMarker(code), next: s.next }
    return s.op === 'set' ? { ...s, test: (code) => !isMarker(code) && s.test(code) } : s
  })
  const marked = { ...nfa, states, isWord: (code) => extent.tables.has('word', isMarker(code) ? code - 0xdc00 : code) }
  return { search: (line, from) => search(marked, line, from) }
}

// What glibc reads at a marker: a character after all where the bytes from
// there spell one past U+10FFFF in its shortest form of four bytes up to six,
// which every reading of glibc's takes for one, and a surrogate spelt in
// three, which only its regex does. The width read, or 0 where it reads none.
const LEAST = [0, 0, 0, 0, 0x110000, 0x200000, 0x4000000]
const byteAt = (text, at) => (isMarker(text.codePointAt(at)) ? text.codePointAt(at) - 0xdc00 : -1)

function glibcSequence(text, at) {
  const lead = byteAt(text, at)
  const width = lead === 0xed ? 3 : lead >= 0xf0 && lead <= 0xf7 ? 4 : lead >= 0xf8 && lead <= 0xfb ? 5 : lead === 0xfc || lead === 0xfd ? 6 : 0
  let code = lead & (0x7f >> width)
  for (let k = 1; k < width; k++) {
    const next = byteAt(text, at + k)
    if (next < 0x80 || next > 0xbf) return 0
    code = (code << 6) | (next & 0x3f)
  }
  return width === 3 ? (code >= 0xd800 && code <= 0xdfff ? 3 : 0) : width && code >= LEAST[width] ? width : 0
}

// Whether the text holds a byte glibc reads as no character — which GNU will
// not print — and whether it holds a run some reading of glibc's takes for a
// character: a form past U+10FFFF, or a surrogate.
export function glibcReading(text) {
  const found = { errors: false, long: false, surrogate: false }
  for (let at = 0; at < text.length; at++) {
    const code = text.codePointAt(at)
    if (code > 0xffff) at++
    if (!isMarker(code)) continue
    const width = glibcSequence(text, at)
    if (width === 0) { found.errors = true; continue }
    if (width === 3) found.errors = found.surrogate = true
    else found.long = true
    at += width - 1
  }
  return found
}

// What a GNU pattern, as written, asks of a character, where that decides
// which of GNU's matchers answers: a set spelt by what it leaves out, which
// takes a character past U+10FFFF even in GNU's own matcher; a wildcard; and
// whether glibc's regex answers the whole pattern, which in a multibyte locale
// it does for a backreference, a word edge, `\w`, `\s` and their negations,
// and a set holding a class or a range — and then reads both those runs as
// characters, as it always does for what `-o` prints.
export function patternShape(pattern, backrefs, wordEdge) {
  const shape = { negated: false, dot: false, regex: backrefs || wordEdge, wordEdge }
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') {
      const next = pattern[++i] ?? ''
      if ('wsWS'.includes(next)) shape.regex = true
      if ('WS'.includes(next)) shape.negated = true
    } else if (c === '.') shape.dot = true
    else if (c === '[') {
      const end = bracketEnd(pattern, i)
      const body = pattern.slice(i + 1, end)
      if (body.startsWith('^')) shape.negated = true
      if (/\[:|.-./u.test(body.replace(/^\^?\]?/u, ''))) shape.regex = true
      i = end
    }
  }
  return shape
}

function bracketEnd(pattern, start) {
  let i = start + 1
  if (pattern[i] === '^') i++
  if (pattern[i] === ']') i++
  for (; i < pattern.length; i++) {
    if (pattern[i] === '[' && ':.='.includes(pattern[i + 1] ?? '')) {
      const close = pattern.indexOf(pattern[i + 1] + ']', i + 2)
      if (close >= 0) { i = close + 1; continue }
    }
    if (pattern[i] === ']') return i
  }
  return pattern.length
}

// Whether glibc and GNU's own matcher could answer this pattern differently
// over text holding such runs; `-o` asks glibc's regex where a match ends.
export function glibcDiffers(shape, reading, only) {
  if (!shape || !(reading.long || reading.surrogate)) return false
  if (shape.wordEdge || ((shape.dot || shape.negated) && (shape.regex || only))) return true
  return reading.long && shape.negated
}
