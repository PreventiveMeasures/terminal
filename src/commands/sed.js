// A read-only sed subset with cumulative line numbers across operands.
import { parseArgs } from '../args.js'
import { err, lineRecords, okWith, readInputs } from '../util.js'
import { unsupported, unsupportedFrom } from '../unsupported.js'
import { SED_SUBSET, parseSedScript, selectsLine, substituteLine } from './sed-script.js'

export function sed(stdin, tokens, ctx) {
  let parsed
  try { parsed = parseArgs(tokens, { short: ['n', 'E', 'r'], long: ['regexp-extended'] }) } catch { return unsupported('feature', 'sed', 'script', SED_SUBSET) }
  const { flags, positional } = parsed
  if (positional.length === 0) return err(SED_SUBSET)
  let commands
  try { commands = parseSedScript(positional[0], flags.has('E') || flags.has('r') || flags.has('regexp-extended')) } catch (e) { return failure(e) }
  const r = readInputs('sed', positional.slice(1), stdin, ctx)
  // Each EOF ends a record even without a final newline. Output preserves
  // that missing newline until another print needs to start a fresh line.
  const lines = r.inputs.flatMap(({ content }) => lineRecords(content))
  const out = []
  let missingNewline = false
  const emit = (text, newline) => {
    if (missingNewline) out.push('\n')
    out.push(text + newline)
    // A newline introduced by s/// is part of the pattern space, not
    // its record terminator. GNU still separates the next output record.
    missingNewline = newline === ''
  }
  try {
    for (let i = 0; i < lines.length; i++) {
      const newline = lines[i].endsWith('\n') ? '\n' : ''
      let text = newline ? lines[i].slice(0, -1) : lines[i]
      for (const command of commands) {
        if (!selectsLine(command, text, i + 1, i + 1 === lines.length)) continue
        if (command.kind === 'p') { emit(text, newline); continue }
        const result = substituteLine(text, command)
        text = result.out
        if (result.count && command.print) emit(text, newline)
      }
      if (!flags.has('n')) emit(text, newline)
    }
  } catch (e) {
    const failed = failure(e)
    failed.stdout = out.join('')
    failed.stderr = r.stderr + failed.stderr
    return failed
  }
  return { ...okWith(out.join(''), r), exitCode: r.failed ? 2 : 0 }
}

function failure(e) {
  if (e.gap) return unsupported('feature', 'sed', e.gap, `sed: ${e.message}`)
  if (e instanceof RangeError) return unsupported('feature', 'sed', 'regex runtime limit', `sed: ${e.message}`)
  return unsupportedFrom(e, 'sed', `sed: ${e.message.replace(/^sed: /u, '')}`)
}
