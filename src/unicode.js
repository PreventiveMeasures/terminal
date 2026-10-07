export const MAX_CODE_POINT = 0x10FFFF

export function isUnicodeScalar(code) {
  return Number.isInteger(code) && code >= 0 && code <= MAX_CODE_POINT && (code < 0xD800 || code > 0xDFFF)
}

// UTF-16 width; missing positions and lone surrogates advance one unit.
export const codePointSize = (code) => code > 0xFFFF ? 2 : 1
export const stepAt = (text, at) => codePointSize(text.codePointAt(at))

// V8 tries a match from between the two halves of a surrogate pair, where its
// lookarounds read no character on either side, so an empty match or a word
// edge is found inside a character a matcher reading characters reads whole.
// Only there is neither the start of the text nor a character behind, so only
// there no match starts.
export const wholeCharacters = (source) => `(?:^|(?<=[^]))(?:${source})`
