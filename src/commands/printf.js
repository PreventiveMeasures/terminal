import { UnsupportedError, unsupported, unsupportedFrom, unsupportedNote } from '../unsupported.js'
import { ok, usage, utf8, utf8Decoder } from '../util.js'
import { printfBytes, printfEscape } from './printf-escape.js'
import { printfFloatField, printfInteger, printfIntegerField } from './printf-number.js'
import { INT32_MAX, INT32_MIN } from '../numeric.js'
import { MAX_FIELD_WIDTH } from '../awk/common.js'

const SPEC = /^%([-+ #0']*)(\d+|\*)?(?:\.(-?\d+|\*)?)?([hlLjzt]*)(.)?/su
const MAX_OUTPUT = 8_000_000

export function printf(_stdin, tokens, ctx) {
  const operands = tokens[0] === '--' ? tokens.slice(1) : tokens
  if (operands.length === 0) return usage('printf format [arguments]')
  if (tokens[0] !== '--' && /^-./su.test(tokens[0])) {
    const option = tokens[0].startsWith('-v') ? '-v' : tokens[0]
    return unsupported('option', 'printf', option, `printf: option ${option} is not supported`, 2)
  }
  const locale = ctx.vars.get('LC_ALL') || ctx.vars.get('LC_CTYPE') || ctx.vars.get('LANG')
  const state = { args: operands.slice(1), index: 0, chunks: [], size: 0, stderr: '', stop: false, byteLocale: locale === 'C' || locale === 'POSIX' }
  let result
  try {
    if (operands.some((s) => s.includes('\0'))) throw new UnsupportedError('feature', 'NUL in argument', 'NUL bytes in command arguments are not supported')
    do {
      const before = state.index
      printFormat(operands[0], state)
      if (state.index === before) break
    } while (!state.stop && state.index < state.args.length)
    result = ok()
  } catch (e) {
    result = unsupportedFrom(e, 'printf', `printf: ${e.message}`)
  }
  try { result.stdout = decodeOutput(state) } catch (e) {
    const note = unsupportedNote(result)
    if (note) ctx.unsupported.add(note, 'printf')
    const failed = unsupportedFrom(e, 'printf', `printf: ${e.message}`)
    failed.stderr = result.stderr + failed.stderr
    result = failed
  }
  result.stderr = state.stderr + result.stderr
  if (state.stderr && result.exitCode === 0) result.exitCode = 1
  return result
}

function append(state, bytes) {
  if (state.size + bytes.length > MAX_OUTPUT) throw new UnsupportedError('feature', 'format size limit', 'formatted output exceeds the output limit')
  if (bytes.length) state.chunks.push(bytes)
  state.size += bytes.length
}

function decodeOutput(state) {
  const bytes = new Uint8Array(state.size)
  let offset = 0
  for (const chunk of state.chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return utf8Decoder.decode(bytes)
}

const nextArg = (state) => state.args[state.index++]

function printFormat(format, state) {
  for (let at = 0; at < format.length && !state.stop;) {
    if (format[at] === '\\') {
      const escaped = printfEscape(format, at, false, state)
      append(state, escaped.bytes)
      at = escaped.end
    } else if (format[at] === '%') {
      if (format[at + 1] === '%') { append(state, [37]); at += 2; continue }
      const spec = readSpec(format.slice(at), state)
      at += spec.length
      const arg = nextArg(state)
      if ('sbc'.includes(spec.conv)) printString(arg ?? '', spec, state)
      else {
        const out = 'diouxX'.includes(spec.conv)
          ? printfIntegerField(printfInteger(arg, 'ouxX'.includes(spec.conv), state), spec)
          : printfFloatField(arg, spec, state)
        append(state, utf8.encode(out))
      }
    } else {
      let end = at + 1
      while (end < format.length && format[end] !== '%' && format[end] !== '\\') end++
      append(state, utf8.encode(format.slice(at, end)))
      at = end
    }
  }
}

function readSpec(text, state) {
  if (/^%[-+ #0'\d.*]*\$/u.test(text)) throw new UnsupportedError('feature', 'positional format arguments', 'positional format arguments are not supported')
  const match = SPEC.exec(text)
  const [, flags, width, precision, modifier, conv] = match
  if (conv === undefined) throw new Error('missing format character')
  if (!'sbcdiouxXeEfFgG'.includes(conv)) {
    if ('aAqQnCS(p%I'.includes(conv)) throw new UnsupportedError('feature', '%' + conv, `format %${conv} is not supported`)
    throw new Error(`invalid format character: ${conv}`)
  }
  if (modifier && 'sbc'.includes(conv)) throw new UnsupportedError('feature', 'format length modifier', 'length modifiers on string and character formats are not supported')
  const spec = {
    conv, length: match[0].length,
    minus: flags.includes('-'), plus: flags.includes('+'), space: flags.includes(' '), zero: flags.includes('0'), alt: flags.includes('#'),
    width: width === '*' ? Number(printfInteger(nextArg(state), false, state)) : Number(width ?? 0),
    precision: precision === '*' ? Number(printfInteger(nextArg(state), false, state)) : precision === undefined ? match[0].includes('.') ? 0 : null : Number(precision),
  }
  if (width === '*' && Math.abs(spec.width) > INT32_MAX || precision === '*' && (spec.precision < INT32_MIN || spec.precision > INT32_MAX)) {
    throw new UnsupportedError('feature', 'format size limit', 'star width or precision outside the signed 32-bit range is not supported')
  }
  if (spec.width < 0) { spec.minus = true; spec.width = -spec.width }
  if (spec.precision < 0) spec.precision = null
  if (spec.width > MAX_FIELD_WIDTH || spec.precision > MAX_FIELD_WIDTH) throw new UnsupportedError('feature', 'format size limit', 'format width or precision exceeds the output limit')
  return spec
}

function printString(arg, spec, state) {
  let bytes = spec.conv === 'b' ? printfBytes(arg, state) : utf8.encode(arg)
  if (spec.conv === 'c') bytes = bytes.length ? bytes.subarray(0, 1) : new Uint8Array(1)
  else if (spec.precision !== null) bytes = bytes.subarray(0, spec.precision)
  const missing = Math.max(0, spec.width - bytes.length)
  const padding = missing ? new Uint8Array(missing).fill(32) : []
  if (!spec.minus) append(state, padding)
  append(state, bytes)
  if (spec.minus) append(state, padding)
}
