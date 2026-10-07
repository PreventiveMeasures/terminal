// xargs parses its input using its own quoting rules, not shell expansion.
import { parseArgs } from '../args.js'
import { consumeStdin, encodeUtf8Loose, ok, splitLines, usageError } from '../util.js'
import { appendOutput, emptyOutput } from '../shell/output.js'
import { markUnsupported, unsupported } from '../unsupported.js'

export async function xargs(stdin, tokens, ctx) {
  const { flags, values, positional } = parseArgs(tokens, {
    short: ['r', '0'], valueShort: ['n', 'I'], stopAtFirstPositional: true,
  })
  const [cmd = 'echo', ...baseArgs] = positional
  const replace = values.get('I')
  const n = values.has('n') ? maxArgs(values.get('n')) : { value: undefined }
  if (n.error) return n.error
  // An empty replacement string GNU answers erratically: once a line with
  // the command alone, or `command too long` beside an initial argument.
  if (replace === '') return unsupported('option', 'xargs', '-I', "xargs: -I '' (an empty replacement string) is not supported")
  if (replace !== undefined && n.value !== undefined) return unsupported('option', 'xargs', '-I -n', 'xargs: combining replacement and chunk limits is not supported')
  consumeStdin(ctx)
  if (!flags.has('0') && stdin.includes('\0')) return unsupported('feature', 'xargs', 'NUL input', 'xargs: NUL input requires -0')
  let items
  if (flags.has('0')) items = splitLines(stdin, '\0')
  else if (replace === undefined) items = inputWords(stdin)
  else {
    if (/["'\\]/u.test(stdin)) return unsupported('feature', 'xargs', '-I input quoting', 'xargs: quoted or escaped replacement lines are not supported')
    items = splitLines(stdin).map((line) => line.replace(/^[ \t\r\f\v]+/u, '')).filter(Boolean)
  }
  if (items.length === 0 && (flags.has('r') || replace !== undefined)) return ok()
  // Build each batch only when it is reached; unavailable commands stop immediately.
  // What every batch wrote, in the order it wrote it, the bytes a command
  // wrote as bytes among it: a pipe after xargs takes those as they are.
  const out = emptyOutput()
  const baseSize = [cmd, ...baseArgs].reduce((sum, word) => sum + argSize(word), 0)
  let exitCode = 0
  let i = 0
  do {
    let args
    if (replace === undefined) {
      let end = i, size = baseSize
      while (end < items.length && (n.value === undefined || end - i < n.value) && size + argSize(items[end]) <= ARG_MAX) size += argSize(items[end++])
      if (end === i && i < items.length) {
        appendOutput(out, { ...emptyOutput('xargs: argument line too long\n'), exitCode: 1 })
        return out
      }
      args = [...baseArgs, ...items.slice(i, end)]
      i = end
    } else {
      const item = items[i++]
      args = baseArgs.map((arg) => arg.replaceAll(replace, item))
      if (args.reduce((sum, word) => sum + argSize(word), argSize(cmd)) > ARG_MAX) {
        const message = 'xargs: a replaced command line longer than 128 KiB is not supported'
        appendOutput(out, { ...emptyOutput(message + '\n'), exitCode: 1 })
        return markUnsupported(out, 'feature', 'xargs', 'command line limit', message)
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- one batch after the last, as xargs runs them.
    const r = await ctx.dispatch(cmd, args, '', { devNull: true })
    appendOutput(out, r)
    if (r.exitCode === 255) {
      appendOutput(out, { ...emptyOutput(`xargs: ${cmd}: exited with status 255; aborting\n`), exitCode: 124 })
      return out
    }
    if (r.exitCode === 127 && !ctx.hasCommand(ctx.registry.resolveCommand(cmd))) return { ...out, exitCode: 127 }
    if (r.exitCode !== 0) exitCode = 123
  } while (i < items.length)
  return { ...out, exitCode, ignored: false }
}

// GNU's xargs builds a command line of at most 128 KiB — each word counted
// with the NUL that ends it, the command's own words included — and runs
// what it has whenever the next argument would not fit. An argument too long
// for any command line ends the run there, with what went before it run.
const ARG_MAX = 128 * 1024
const argSize = (word) => encodeUtf8Loose(word).length + 1

// -n reads its count with strtol: blanks, a sign and decimal digits, past
// whose range it saturates, and at least 1. Recorded from findutils 4.9.
function maxArgs(text) {
  if (!/^[ \t\n\r\f\v]*[+-]?\d+$/u.test(text)) return { error: usageError('xargs', `invalid number "${text}" for -n option`) }
  const value = BigInt(text.trim())
  if (value < 1n) return { error: usageError('xargs', `value ${text} for -n option should be >= 1`) }
  return { value: value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value) }
}

// Dispatch names the command, so the message says only what went wrong —
// which quote it was, and that `-0` is the way to stop reading them.
const unmatched = (quote) =>
  new Error(`unmatched ${quote === "'" ? 'single' : 'double'} quote; by default quotes are special to xargs unless you use the -0 option`)

function inputWords(input) {
  const words = []
  let quote = null, started = false, word = ''
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    // GNU strips all ASCII whitespace before an argument, but only blanks
    // and newlines separate arguments once an unquoted word has started.
    if (!started && /[ \t\n\r\f\v]/u.test(c)) continue
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\n') throw unmatched(quote)
      else word += c
    } else if (c === '"' || c === "'") { quote = c; started = true }
    else if (c === '\\') {
      if (i + 1 >= input.length) break
      word += input[++i]; started = true
    } else if (c === ' ' || c === '\t' || c === '\n') {
      if (started) words.push(word)
      word = ''; started = false
    } else { word += c; started = true }
  }
  if (quote) throw unmatched(quote)
  if (started) words.push(word)
  return words
}
