// xargs parses its input using its own quoting rules, not shell expansion.
import { parseArgs } from '../args.js'
import { consumeStdin, err, ok, parseNonNegativeInt, splitLines } from '../util.js'
import { unsupported } from '../unsupported.js'

export function xargs(stdin, tokens, ctx) {
  const { flags, values, positional } = parseArgs(tokens, {
    short: ['r', '0'], valueShort: ['n', 'I'], stopAtFirstPositional: true,
  })
  const [cmd = 'echo', ...baseArgs] = positional
  const replace = values.get('I')
  const n = values.has('n') ? parseNonNegativeInt(values.get('n'), 'xargs: -n') : { value: undefined }
  if (n.error) return n.error
  if (n.value === 0) return err('xargs: -n: must be at least 1')
  if (replace === '') return err('xargs: -I: replacement string must not be empty')
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
  const size = replace === undefined ? n.value ?? Math.max(1, items.length) : 1
  let exitCode = 0, stderr = '', stdout = ''
  for (let i = 0; i < Math.max(1, items.length); i += size) {
    const item = items[i]
    const args = replace === undefined
      ? [...baseArgs, ...items.slice(i, i + size)]
      : baseArgs.map((arg) => arg.replaceAll(replace, item))
    const r = ctx.dispatch(cmd, args, '')
    stdout += r.stdout; stderr += r.stderr
    if (r.exitCode === 255) return { stdout, stderr: stderr + 'xargs: ' + cmd + ': exited with status 255; aborting\n', exitCode: 124 }
    if (r.exitCode === 127 && !ctx.hasCommand(ctx.registry.resolveCommand(cmd))) return { stdout, stderr, exitCode: 127 }
    if (r.exitCode !== 0) exitCode = 123
  }
  return { stdout, stderr, exitCode }
}

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
      else if (c === '\n') throw new Error('xargs: unmatched quote')
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
  if (quote) throw new Error('xargs: unmatched quote')
  if (started) words.push(word)
  return words
}
