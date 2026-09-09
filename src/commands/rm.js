import { parseArgs } from '../args.js'
import { lookup } from '../fs.js'
import { encodeUtf8, err, ok } from '../util.js'
import { UnsupportedError } from '../unsupported.js'

const QUOTE_ESCAPES = new Map([['\0', '0'], ['\u0007', 'a'], ['\b', 'b'], ['\f', 'f'], ['\n', 'n'], ['\r', 'r'], ['\t', 't'], ['\v', 'v']])

export function rm(_stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['f', 'v'], long: ['force', 'verbose'] })
  const force = flags.has('f') || flags.has('force')
  const verbose = flags.has('v') || flags.has('verbose')
  if (positional.length === 0) return force ? ok('') : err('rm: missing operand')
  const events = []
  let stderr = '', stdout = ''
  for (const name of positional) {
    const found = lookup(ctx.cwd, name, ctx.fs)
    let error = found.error
    // GNU -f ignores ENOTDIR as well as ENOENT: neither names an existing file.
    if (force && (error === 'No such file or directory' || error === 'Not a directory')) continue
    if (error === null && ctx.fs.isDir(found.path)) error = 'Is a directory'
    const shown = verbose || error !== null || !ctx.writable || !found.path?.startsWith('/tmp/') ? quoteName(name, ctx) : ''
    if (error === null && !ctx.fs.removeWritable?.(ctx.cwd, name)) error = 'Read-only file system'
    if (error) {
      const text = `rm: cannot remove ${shown}: ${error}\n`
      stderr += text
      events.push({ fd: 2, text })
    } else if (verbose) {
      const text = `removed ${shown}\n`
      stdout += text
      events.push({ fd: 1, text })
    }
  }
  return { stdout, stderr, events, exitCode: stderr ? 1 : 0 }
}

// GNU quoteaf keeps printable names shell-quoted and groups nonprinting
// bytes in adjacent ANSI-C quoted spans, so one filename stays one log entry.
function quoteName(name, ctx) {
  const locale = ctx.vars.get('LC_ALL') || ctx.vars.get('LC_CTYPE') || ctx.vars.get('LANG') || ''
  const byteLocale = locale === 'C' || locale === 'POSIX'
  const units = byteLocale ? Array.from(encodeUtf8(name), (byte) => String.fromCodePoint(byte)) : [...name]
  if (!byteLocale && units.some((char) => char.codePointAt(0) > 127 && /[\p{C}\p{Zl}\p{Zp}]/u.test(char))) {
    throw new UnsupportedError('feature', 'filename quoting', 'quoting nonprinting Unicode filenames is not supported')
  }
  if (name.includes("'") && units.every((char) => /[-a-zA-Z0-9 %+,./:_\]']/u.test(char) || !byteLocale && char.codePointAt(0) > 127)) return '"' + name + '"'
  let escaped = false, out = "'"
  for (const char of units) {
    const code = char.codePointAt(0)
    const escape = QUOTE_ESCAPES.get(char) ?? (code < 32 || code === 127 || byteLocale && code > 127 ? code.toString(8).padStart(3, '0') : null)
    if (escape !== null) {
      if (!escaped) out += "'$'"
      escaped = true
      out += '\\' + escape
    } else if (char === "'") {
      out += "'\\''"
      escaped = false
    } else {
      if (escaped) out += "''"
      escaped = false
      out += char
    }
  }
  return out + "'"
}
