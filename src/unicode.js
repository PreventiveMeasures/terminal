export const MAX_CODE_POINT = 0x10FFFF

export function isUnicodeScalar(code) {
  return Number.isInteger(code) && code >= 0 && code <= MAX_CODE_POINT && (code < 0xD800 || code > 0xDFFF)
}

// UTF-16 width; missing positions and lone surrogates advance one unit.
export const codePointSize = (code) => code > 0xFFFF ? 2 : 1
export const stepAt = (text, at) => codePointSize(text.codePointAt(at))
