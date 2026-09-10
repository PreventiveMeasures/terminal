import { UnsupportedError, unsupportedNote } from '../unsupported.js'
import { expansionStderr } from './output.js'
import { isolated, withState } from './state.js'
import { err } from '../util.js'
import { parseLine } from './parse.js'
import { MAX_SUBSTITUTION_DEPTH } from './substitution.js'

export function commandSubstitution(command, ctx, runSteps) {
  const depth = (ctx.substitutionDepth ?? 0) + 1
  if (depth > MAX_SUBSTITUTION_DEPTH) throw new UnsupportedError('feature', 'command substitution nesting limit', `command substitution nesting beyond ${MAX_SUBSTITUTION_DEPTH} levels is not supported`)
  const stderr = ctx.expansionFds[2]
  const outputFds = { 1: 'out', 2: typeof stderr === 'object' || stderr === 'closed' ? stderr : 'err' }
  const result = withState(ctx, { substitutionDepth: depth, outputFds, closed: { out: false, err: stderr === 'closed' } }, () => isolated(ctx, () => {
    let steps
    try {
      steps = parseLine(command, ctx.writable, ctx.registry.has)
    } catch (e) {
      const note = unsupportedNote(e)
      if (!note) {
        // Literal substitutions are validated with their enclosing input unit.
        // Heredoc bodies are parsed during expansion, where Bash's recovery
        // depends on builtin versus external-command execution scopes.
        throw new UnsupportedError('feature', 'command substitution syntax', `runtime command substitution syntax errors are not supported: ${e.message}`)
      }
      ctx.unsupported.add(note)
      return err(`error: ${e.message}`, 1)
    }
    const stage = steps.length === 1 && !steps[0].negate && steps[0].stages.length === 1 ? steps[0].stages[0] : null
    // Bash's $(<file) shorthand reads the file without a command name.
    if (stage && !stage.group && !stage.loop && !stage.conditional && !stage.test && stage.words.length === 0 && stage.assigns.length === 0 && stage.redirs.length === 1 && stage.redirs[0].op === 'read') stage.words.push({ value: 'cat', mask: null })
    return runSteps(steps, ctx, { text: ctx.stdinLeft })
  }))
  ctx.lastExit = ctx.substitutionExit = result.exitCode
  let value = result.stdout
  let errors = result.stderr
  if (value.includes('\0')) {
    value = value.replaceAll('\0', '')
    errors += 'warning: command substitution: ignored null byte in input\n'
  }
  expansionStderr(ctx, errors)
  let end = value.length
  while (end > 0 && value[end - 1] === '\n') end--
  return value.slice(0, end)
}
