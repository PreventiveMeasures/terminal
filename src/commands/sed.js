// Read-only sed with addressed print and substitution commands.
import { parseArgs } from '../args.js'
import { err, lineRecords, okWith, readFilesFor, readInputs } from '../util.js'
import { unsupported, unsupportedFrom } from '../unsupported.js'
import { SED_SUBSET, parseSedScript, selectsLine, substituteLine } from './sed-script.js'

export function sed(stdin, tokens, ctx) {
  let parsed
  try {
    parsed = parseArgs(tokens, {
      short: ['n', 'E', 'r', 's', 'z'],
      long: ['regexp-extended', 'quiet', 'silent', 'separate', 'null-data', 'zero-terminated'],
      repeatable: ['e', 'expression', 'f', 'file'],
    })
  } catch (e) { return failure(e) }
  let program
  try { program = compileProgram(parsed, stdin, ctx) } catch (e) { return failure(e) }
  if (program === null) return err(SED_SUBSET)
  if (program.error) return program.error
  const r = readInputs('sed', program.files, program.stdin, ctx)
  return runProgram(program.commands, parsed.flags, r)
}

function runProgram(commands, flags, r) {
  const delimiter = flags.has('z') || flags.has('null-data') || flags.has('zero-terminated') ? '\0' : '\n'
  const quiet = flags.has('n') || flags.has('quiet') || flags.has('silent')
  const separate = flags.has('s') || flags.has('separate')
  // Each EOF ends a record even without a final delimiter. Output preserves
  // that missing delimiter until another print starts a fresh record.
  const inputs = r.inputs.map(({ content }) => lineRecords(content, delimiter))
  const out = []
  let missingDelimiter = false
  const emit = (text, terminator) => {
    if (missingDelimiter) out.push(delimiter)
    out.push(text + terminator)
    // A delimiter introduced by s/// is part of the pattern space, not
    // its record terminator. GNU still separates the next output record.
    missingDelimiter = terminator === ''
  }
  try {
    for (const lines of separate ? inputs : [inputs.flat()]) {
      for (const command of commands) command.active = command.start?.type === 'line' && command.start.value === 0
      runLines(commands, lines, delimiter, quiet, emit)
    }
  } catch (e) {
    const failed = failure(e)
    failed.stdout = out.join('')
    failed.stderr = r.stderr + failed.stderr
    return failed
  }
  return { ...okWith(out.join(''), r), exitCode: r.failed ? 2 : 0 }
}

function runLines(commands, lines, delimiter, quiet, emit) {
  for (let i = 0; i < lines.length; i++) {
    const terminator = lines[i].endsWith(delimiter) ? delimiter : ''
    let text = terminator ? lines[i].slice(0, -1) : lines[i]
    for (const command of commands) {
      if (!selectsLine(command, text, i + 1, i + 1 === lines.length)) continue
      if (command.kind === 'p') { emit(text, terminator); continue }
      const result = substituteLine(text, command)
      text = result.out
      if (result.count && command.print) emit(text, terminator)
    }
    if (!quiet) emit(text, terminator)
  }
}

function compileProgram({ order, positional }, stdin, ctx) {
  const commands = []
  let extended = false, scripted = false
  // GNU compiles each expression as its option is encountered. A later -E
  // affects later expressions; each -e also ends its own command text.
  for (const { name, value } of order) {
    if (name === 'E' || name === 'r' || name === 'regexp-extended') extended = true
    if (!['e', 'expression', 'f', 'file'].includes(name)) continue
    scripted = true
    let script = value
    if (name === 'f' || name === 'file') {
      const r = readFilesFor('sed', [value], ctx, stdin)
      if (r.failed) return { error: err(r.stderr, 4) }
      script = r.inputs[0].content
      if (r.inputs[0].shared) stdin = ''
    }
    for (const command of parseSedScript(script, extended)) commands.push(command)
  }
  if (scripted) return { commands, files: positional, stdin }
  if (positional.length === 0) return null
  return { commands: parseSedScript(positional[0], extended), files: positional.slice(1), stdin }
}

function failure(e) {
  if (e.gap) return unsupported('feature', 'sed', e.gap, `sed: ${e.message}`)
  if (e instanceof RangeError) return unsupported('feature', 'sed', 'regex runtime limit', `sed: ${e.message}`)
  return unsupportedFrom(e, 'sed', `sed: ${e.message.replace(/^sed: /u, '')}`)
}
