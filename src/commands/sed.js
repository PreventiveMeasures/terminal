import { parseArgs } from '../args.js'
import { err, readFilesFor } from '../util.js'
import { SED_SUBSET, sedFailure } from './sed-common.js'
import { preprocessInPlace, runInPlace } from './sed-in-place.js'
import { refreshSedStdin, sedOutput } from './sed-output.js'
import { runSed } from './sed-run.js'
import { finishSedProgram, parseSedScript } from './sed-script.js'

export function sed(stdin, tokens, ctx) {
  try {
    const { tokens: args, inPlace } = preprocessInPlace(tokens)
    const parsed = parseArgs(args, {
      short: ['n', 'E', 'r', 's', 'z'],
      long: ['regexp-extended', 'quiet', 'silent', 'separate', 'null-data', 'zero-terminated'],
      repeatable: ['e', 'expression', 'f', 'file'],
    })
    const delimiter = parsed.flags.has('z') || parsed.flags.has('null-data') || parsed.flags.has('zero-terminated') ? '\0' : '\n'
    const output = sedOutput(ctx, delimiter)
    const program = compileProgram(parsed, stdin, ctx, output.openWrite)
    if (program === null) return err(SED_SUBSET)
    if (program.error) return program.error
    Object.assign(program, { output, delimiter, hold: { text: '', terminator: delimiter }, regexState: { last: null }, budget: { steps: 0 } })
    program.stdin = refreshSedStdin(program.stdin, ctx)
    return inPlace === null ? runSed(program, parsed.flags, ctx)
      : runInPlace(program, parsed.flags, ctx, inPlace, (p, flags) => runSed(p, flags, ctx, true))
  } catch (e) { return sedFailure(e) }
}

function compileProgram({ order, positional }, stdin, ctx, openWrite) {
  const commands = []
  const textState = { openWrite }
  const locale = ctx.vars.get('LC_ALL') || ctx.vars.get('LC_CTYPE') || ctx.vars.get('LANG') || ''
  const byteLocale = locale === 'C' || locale === 'POSIX'
  let extended = false, scripted = false
  // GNU compiles each expression as its option is encountered. A later -E
  // affects later expressions. Text continuations can span -e/-f sources.
  for (const { name, value } of order) {
    if (name === 'E' || name === 'r' || name === 'regexp-extended') extended = true
    if (!['e', 'expression', 'f', 'file'].includes(name)) continue
    scripted = true
    let script = value
    if (name === 'f' || name === 'file') {
      stdin = refreshSedStdin(stdin, ctx)
      const scriptInput = stdin
      const r = ctx.io.bufferReads(() => readFilesFor('sed', [value], ctx, scriptInput))
      if (r.failed) return { error: err(r.stderr, 4) }
      script = r.inputs[0].content
      if (r.inputs[0].shared) stdin = ''
    }
    for (const command of parseSedScript(script, extended, byteLocale, textState)) commands.push(command)
  }
  if (scripted) return { commands: finishSedProgram(commands, textState), files: positional, stdin }
  if (positional.length === 0) return null
  return { commands: finishSedProgram(parseSedScript(positional[0], extended, byteLocale, textState), textState), files: positional.slice(1), stdin }
}
