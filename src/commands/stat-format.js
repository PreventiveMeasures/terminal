import { MAX_FIELD_WIDTH } from '../awk/common.js'
import { decodeUtf8, encodeUtf8 } from '../util.js'
import { UnsupportedError } from '../unsupported.js'
import { printfIntegerField } from './printf-number.js'

const ESCAPES = { a: 7, b: 8, e: 27, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 }

export function statFormat(format, escapes) {
  const parts = []
  for (let at = 0; at < format.length;) {
    if (format[at] === '%') {
      if (format[at + 1] === '%' || at + 1 === format.length) { parts.push([37]); at += 2; continue }
      const match = /^%([-+ #0']*)(\d+)?(?:\.(\d*))?([\s\S])?/u.exec(format.slice(at))
      const [, flags, width, precision, field] = match
      if (!field || field === '%') throw new Error(`invalid directive: ${match[0]}`)
      if (!'nsF'.includes(field)) throw new UnsupportedError('feature', '%' + field, `format %${field} is not supported`)
      if (flags.includes("'")) throw new UnsupportedError('feature', 'grouped format', 'digit grouping in stat formats is not supported')
      const spec = {
        field, conv: 'u', width: Number(width ?? 0), precision: precision === undefined ? null : Number(precision || 0),
        minus: flags.includes('-'), zero: flags.includes('0'), plus: flags.includes('+'), space: flags.includes(' '), alt: flags.includes('#'),
      }
      if (spec.width > MAX_FIELD_WIDTH || spec.precision > MAX_FIELD_WIDTH) throw new UnsupportedError('feature', 'format size limit', 'format width or precision exceeds the output limit')
      parts.push(spec)
      at += match[0].length
    } else if (format[at] === '\\' && escapes) {
      const c = format[at + 1]
      const numeric = /^(?:[0-7]{1,3}|x[\da-fA-F]{1,2})/u.exec(format.slice(at + 1))?.[0]
      if (numeric) {
        const radix = numeric[0] === 'x' ? 16 : 8
        parts.push([parseInt(radix === 16 ? numeric.slice(1) : numeric, radix) & 255])
        at += numeric.length + 1
      } else if (Object.hasOwn(ESCAPES, c)) { parts.push([ESCAPES[c]]); at += 2 }
      else throw new UnsupportedError('feature', 'format escape', `format escape ${JSON.stringify(format.slice(at, at + 2))} is not supported`)
    } else {
      let end = at + 1
      while (end < format.length && format[end] !== '%') {
        if (escapes && format[end] === '\\') break
        end++
      }
      parts.push(encodeUtf8(format.slice(at, end)))
      at = end
    }
  }
  if (!escapes) parts.push([10])
  return parts
}

export function formatStat(parts, name, path, fs) {
  const isDir = fs.isDir(path)
  if (isDir && fs.isFile(path)) throw new UnsupportedError('feature', 'ambiguous file type', `path is both a file and a directory: ${name}`)
  let size
  const chunks = parts.map((part) => {
    if (!part.field) return part
    if (part.field === 'n') return stringField(name, part)
    if (part.field === 's' && isDir) throw new UnsupportedError('feature', 'directory byte size', `directory byte sizes are not available: ${name}`)
    size ??= isDir ? 0 : fs.fileSize(path)
    if (part.field === 'F') return stringField(isDir ? 'directory' : size === 0 ? 'regular empty file' : 'regular file', part)
    return encodeUtf8(printfIntegerField(BigInt(size), part))
  })
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length }
  return decodeUtf8(bytes)
}

function stringField(value, spec) {
  let bytes = encodeUtf8(value)
  if (spec.precision !== null) bytes = bytes.subarray(0, spec.precision)
  const missing = Math.max(0, spec.width - bytes.length)
  if (!missing) return bytes
  const padded = new Uint8Array(bytes.length + missing).fill(32)
  padded.set(bytes, spec.minus ? 0 : missing)
  return padded
}
