import { byteLocale } from '../locale.js'
import { UnsupportedError, unsupported, unsupportedFrom, unsupportedNote } from '../unsupported.js'
import { decodeUtf8, encodeUtf8Loose, err, ok } from '../util.js'
import { printfBytes, printfEscape } from './printf-escape.js'
import { printfFloatField, printfInteger, printfIntegerField } from './printf-number.js'
import { quoteLocale } from './quote-name.js'
import { INT32_MAX, INT32_MIN } from '../numeric.js'
import { MAX_FIELD_WIDTH } from '../awk/common.js'

const SPEC = /^%([-+ #0']*)(\d+|\*)?(?:\.(-?\d+|\*)?)?([hlLjzt]*)(.)?/su
const MAX_OUTPUT = 8_000_000
const BASH_USAGE = 'printf: usage: printf [-v var] format [arguments]'

// Two printfs answer to the name, and they part ways over more than their
// options: bash's builtin, which a plain `printf` runs, and coreutils', which
// a path, xargs and find -exec run. They read numbers alike and say different
// things about one they cannot read; they take different escapes; and only
// coreutils' stops at a `\c` in the format, warns of arguments it never
// reached, and names itself by what it was run as. `program` is that name for
// coreutils' and null for bash's, and the state carries it to the readers.
export function printf(_stdin, tokens, ctx) {
  let at = 0
  const first = tokens[0]
  if (first === '--') at = 1
  else if (first !== undefined && first.length > 1 && first.startsWith('-')) {
    if (first === '--help' || first[1] === 'v') {
      const option = first.startsWith('-v') ? '-v' : first
      return unsupported('option', 'printf', option, `printf: option ${option} is not supported`, 2)
    }
    return err(`printf: -${first[1]}: invalid option\n${BASH_USAGE}`, 2)
  }
  if (at >= tokens.length) return err(BASH_USAGE, 2)
  return run(tokens.slice(at), ctx, null)
}

export function printfProgram(_stdin, tokens, ctx, name = 'printf') {
  if (tokens.length === 1 && (tokens[0] === '--help' || tokens[0] === '--version')) {
    return unsupported('option', 'printf', tokens[0], `${name}: ${tokens[0]} is not supported`)
  }
  const operands = tokens[0] === '--' ? tokens.slice(1) : tokens
  if (operands.length === 0) return err(`${name}: missing operand\nTry '${name} --help' for more information.`)
  return run(operands, ctx, name)
}

function run(operands, ctx, program) {
  const state = { args: operands.slice(1), index: 0, chunks: [], size: 0, stderr: '', failed: false, stop: false, byteLocale: byteLocale(ctx), program, name: program ?? 'printf', ctx }
  let result
  try {
    if (operands.some((s) => s.includes('\0'))) throw new UnsupportedError('feature', 'NUL in argument', 'NUL bytes in command arguments are not supported')
    let used
    do {
      const before = state.index
      printFormat(operands[0], state)
      used = state.index - before
    } while (!state.stop && used > 0 && state.index < state.args.length)
    if (program !== null && !state.stop && used === 0 && state.index < state.args.length) {
      state.stderr += `${program}: warning: ignoring excess arguments, starting with ${quoteLocale(state.args[state.index], ctx)}\n`
    }
    result = ok()
  } catch (e) {
    result = unsupportedFrom(e, 'printf', `${state.name}: ${e.message}`)
  }
  try { result.stdout = decodeOutput(state) } catch (e) {
    const note = unsupportedNote(result)
    if (note) ctx.unsupported.add(note, 'printf')
    const failed = unsupportedFrom(e, 'printf', `${state.name}: ${e.message}`)
    failed.stderr = result.stderr + failed.stderr
    result = failed
  }
  result.stderr = state.stderr + result.stderr
  // A warning about what was ignored is not a failure; everything else is —
  // but for coreutils' `\c`, which exits successfully whatever came before.
  if (state.failed && result.exitCode === 0 && state.stop !== 'exit') result.exitCode = 1
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
  return decodeUtf8(bytes)
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
        append(state, encodeUtf8Loose(out))
      }
    } else {
      let end = at + 1
      while (end < format.length && format[end] !== '%' && format[end] !== '\\') end++
      append(state, encodeUtf8Loose(format.slice(at, end)))
      at = end
    }
  }
}

// A conversion either tool would make and this does not is refused; one
// neither makes is the error that tool gives, which ends the run with what
// was written so far: bash names the character, or the whole directive where
// the format ends inside it, and coreutils the directive up to that point.
const BASH_GAPS = 'aAqQn('
const COREUTILS_GAPS = 'aAqI'

function readSpec(text, state) {
  const match = SPEC.exec(text)
  const [, flags, width, precision, modifier, conv] = match
  const coreutils = state.program !== null
  if (conv === undefined) {
    throw new Error(coreutils ? `${match[0]}: invalid conversion specification` : `\`${match[0]}': missing format character`)
  }
  // A precision spelt with a minus is no precision either of them reads:
  // coreutils stops at the minus, and bash hands it on to a C printf that
  // prints the directive back out.
  if (precision?.startsWith('-')) {
    if (coreutils) throw new Error(`${text.slice(0, text.indexOf('.') + 2)}: invalid conversion specification`)
    throw new UnsupportedError('feature', 'negative literal precision', 'a precision spelt with a minus sign is not supported')
  }
  if (!'sbcdiouxXeEfFgG'.includes(conv)) {
    if ((coreutils ? COREUTILS_GAPS : BASH_GAPS).includes(conv)) throw new UnsupportedError('feature', '%' + conv, `format %${conv} is not supported`)
    throw new Error(coreutils ? `${match[0]}: invalid conversion specification` : `\`${conv}': invalid format character`)
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
  let bytes = spec.conv === 'b' ? printfBytes(arg, state) : encodeUtf8Loose(arg)
  if (spec.conv === 'c') bytes = bytes.length ? bytes.subarray(0, 1) : new Uint8Array(1)
  else if (spec.precision !== null) bytes = bytes.subarray(0, spec.precision)
  const missing = Math.max(0, spec.width - bytes.length)
  const padding = missing ? new Uint8Array(missing).fill(32) : []
  if (!spec.minus) append(state, padding)
  append(state, bytes)
  if (spec.minus) append(state, padding)
}
