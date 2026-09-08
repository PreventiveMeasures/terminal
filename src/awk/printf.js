// printf / sprintf over awk values: walks a parsed format, pulls one
// argument per conversion (plus one per `*`), converts it the awk way
// (`%d` of `"12abc"` is 12, `%s` of a number goes through CONVFMT, `%c`
// of a number is a code point) and hands the numeric conversions to
// ./format.js.

import { AwkError, MAX_FIELD_WIDTH } from './common.js'
import { formatNumeric, padField, parseFormat } from './format.js'
import { StrNum, checkText, looksNumeric, toNum, toStr } from './value.js'

const FORMAT_CACHE = new Map()

function pieces(fmt) {
  let p = FORMAT_CACHE.get(fmt)
  if (!p) {
    if (FORMAT_CACHE.size >= 256) FORMAT_CACHE.clear()
    p = parseFormat(fmt)
    FORMAT_CACHE.set(fmt, p)
  }
  return p
}

export function awkSprintf(m, fmt, args) {
  let ai = 0
  const take = () => {
    if (ai >= args.length) throw new AwkError('printf: not enough arguments to satisfy format string')
    return args[ai++]
  }
  let out = ''
  for (const piece of pieces(fmt)) {
    if (typeof piece === 'string') { out += piece; continue }
    const spec = { ...piece }
    if (piece.width === '*') {
      const w = Math.trunc(toNum(take()))
      // A negative `*` width means left-justify, as in C.
      if (w < 0) { spec.minus = true; spec.width = -w } else spec.width = w
    }
    if (piece.precision === '*') {
      const p = Math.trunc(toNum(take()))
      spec.precision = p < 0 ? null : p
    }
    if (spec.width > MAX_FIELD_WIDTH || spec.precision > MAX_FIELD_WIDTH) {
      throw new AwkError(`printf: field width or precision above ${MAX_FIELD_WIDTH} is not supported`, null, 'format size limit')
    }
    out += formatOne(m, spec, take())
  }
  return out
}

function formatOne(m, spec, arg) {
  if (spec.conv === 's') {
    let s = toStr(arg, m)
    if (spec.precision !== null) s = [...s].slice(0, spec.precision).join('')
    return padField('', s, spec, false)
  }
  if (spec.conv === 'c') return padField('', checkText(m, charOf(arg)), spec, false)
  return formatNumeric(toNum(arg), spec)
}

// `%c`: a number (or numeric string from input) is a code point; any
// other string contributes its first character — for an empty string a
// NUL, as gawk emits.
function charOf(arg) {
  const numeric = typeof arg === 'number' || (arg instanceof StrNum && looksNumeric(arg.s))
  if (numeric) {
    const code = Math.trunc(toNum(arg))
    if (!Number.isSafeInteger(code) || code < 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) throw new AwkError('printf: character code outside Unicode scalar values is not supported', null, 'character code')
    return String.fromCodePoint(code)
  }
  const s = arg instanceof StrNum ? arg.s : arg ?? ''
  return s === '' ? '\0' : String.fromCodePoint(s.codePointAt(0))
}
