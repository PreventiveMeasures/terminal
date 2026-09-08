import { UnsupportedError } from './unsupported.js'
import { utf8 } from './util.js'

// GNU wc quotes a filename only when it contains a newline. Quote every
// control run in shell ANSI notation so an operand cannot forge output rows.
function filename(name, ctx) {
  if (!name.includes('\n')) return name
  const locale = ctx.vars.get('LC_ALL') || ctx.vars.get('LC_CTYPE') || ctx.vars.get('LANG')
  const bytes = locale === 'C' || locale === 'POSIX'
  if (!bytes && /[\u0080-\u009F\u2028\u2029]/u.test(name)) throw new UnsupportedError('feature', 'filename quoting', 'wc: locale-sensitive filename quoting is not supported')
  const chars = bytes ? Array.from(utf8.encode(name), (b) => String.fromCodePoint(b)) : [...name]
  const escapes = { 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' }
  let ansi = false
  let out = "'"
  for (const c of chars) {
    const code = c.codePointAt(0)
    if (code < 32 || code === 127 || (bytes && code > 127)) {
      if (!ansi) out += "'$'"
      out += escapes[code] ?? '\\' + code.toString(8).padStart(3, '0')
      ansi = true
    } else {
      if (c === "'") out += "'\\''"
      else out += (ansi ? "''" : '') + c
      ansi = false
    }
  }
  return out + "'"
}

export function formatWc(counts, name, which, width, ctx) {
  const parts = []
  if (which.l) parts.push(String(counts.l).padStart(width))
  if (which.w) parts.push(String(counts.w).padStart(width))
  if (which.m) parts.push(String(counts.m).padStart(width))
  if (which.c) parts.push(String(counts.c).padStart(width))
  return parts.join(' ') + (name ? ' ' + filename(name, ctx) : '')
}
