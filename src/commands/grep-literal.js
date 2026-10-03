// What a plain literal is in each dialect, and whether the bytes of a file
// this terminal cannot read as text can hold it: GNU and ripgrep print
// nothing for such a file where they cannot, so neither does this.
import { LOCALE, classTables } from '../locale.js'
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
