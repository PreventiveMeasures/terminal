// xargs parses its input using its own quoting rules, not shell expansion.
import { parseArgs } from './parse.js'
import { consumeStdin, err, ok, parseNonNegativeInt, splitLines } from './util.js'
import { UnsupportedError, unsupported } from './unsupported.js'

export function xargs(stdin, tokens, ctx) {
  consumeStdin(ctx)
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
  let items
  if (flags.has('0')) {
    items = stdin === '' ? [] : stdin.split('\0')
    if (items.at(-1) === '') items.pop()
  } else if (replace === undefined) items = inputWords(stdin)
  else {
    if (/["'\\]/u.test(stdin)) return unsupported('feature', 'xargs', '-I input quoting', 'xargs: quoted or escaped replacement lines are not supported')
    items = splitLines(stdin).map((line) => line.replace(/^[ \t]+/u, '')).filter(Boolean)
  }
  if (items.length === 0 && (flags.has('r') || replace !== undefined)) return ok()
  const runs = []
  if (replace === undefined) {
    const size = n.value ?? Math.max(1, items.length)
    if (items.length === 0) runs.push(baseArgs)
    for (let i = 0; i < items.length; i += size) runs.push([...baseArgs, ...items.slice(i, i + size)])
  } else {
    for (const item of items) runs.push(baseArgs.map((a) => a.replaceAll(replace, item)))
  }
  return runCommands(ctx, cmd, runs)
}

function inputWords(input) {
  const words = []
  let quote = null, started = false, word = ''
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (c === '\0') throw new UnsupportedError('feature', 'xargs NUL input', 'xargs: NUL input requires -0')
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\n') throw new Error('xargs: unmatched quote')
      else word += c
    } else if (c === '"' || c === "'") { quote = c; started = true }
    else if (c === '\\') {
      if (i + 1 >= input.length) throw new Error('xargs: trailing backslash')
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

function runCommands(ctx, cmd, runs) {
  let exitCode = 0, stderr = '', stdout = ''
  for (const args of runs) {
    const r = ctx.dispatch(cmd, args, '')
    stdout += r.stdout; stderr += r.stderr
    if (r.exitCode === 255) return { stdout, stderr: stderr + `xargs: ${cmd}: exited with status 255; aborting\n`, exitCode: 124 }
    if (r.exitCode === 127 && !ctx.registry.has(ctx.registry.resolveCommand(cmd))) return { stdout, stderr, exitCode: 127 }
    if (r.exitCode !== 0) exitCode = 123
  }
  return { stdout, stderr, exitCode }
}
