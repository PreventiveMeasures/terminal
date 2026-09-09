// Sed transforms the input stream without modifying the virtual filesystem.
import { parseArgs } from '../args.js'
import { err, okWith, readFilesFor } from '../util.js'
import { unsupported, unsupportedFrom } from '../unsupported.js'
import { SED_SUBSET, finishSedProgram, parseSedScript, selectsLine, substituteLine } from './sed-script.js'
import { sedInput } from './sed-input.js'
import { transliterateLine } from './sed-text.js'

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
  return runProgram(program, parsed.flags, ctx)
}

function runProgram(program, flags, ctx) {
  const { commands } = program
  const delimiter = flags.has('z') || flags.has('null-data') || flags.has('zero-terminated') ? '\0' : '\n'
  const quiet = flags.has('n') || flags.has('quiet') || flags.has('silent')
  const separate = flags.has('s') || flags.has('separate')
  const input = sedInput(program.files, program.stdin, ctx, delimiter, separate)
  const r = input.status
  const regexState = { last: null }
  const out = []
  let missingDelimiter = false
  const emit = (text, terminator) => {
    if (missingDelimiter) out.push(delimiter)
    // An omitted terminator writes append text verbatim.
    out.push(text + (terminator ?? ''))
    // A delimiter introduced by s/// is part of the pattern space, not
    // its record terminator. GNU still separates the next output record.
    missingDelimiter = terminator === ''
  }
  let exitCode = 0
  try {
    exitCode = runRecords(commands, input, { delimiter, separate, quiet, regexState }, emit)
  } catch (e) {
    const failed = failure(e)
    failed.stdout = out.join('')
    failed.stderr = r.stderr + failed.stderr
    return failed
  }
  return { ...okWith(out.join(''), r), exitCode: r.failed ? 2 : exitCode }
}

function runRecords(commands, input, options, emit) {
  let first = true
  for (let record = input.next(); record; record = input.next()) {
    if (first || (options.separate && record.reset)) {
      for (const command of commands) {
        command.active = command.start?.type === 'line' && command.start.value === 0
        command.closed = false
      }
      first = false
    }
    const cycle = { ...record, delimiter: options.delimiter, regexState: options.regexState, append: [], exitCode: null }
    const deleted = runCycle(commands, cycle, emit)
    if (!options.quiet && !deleted) emit(cycle.text, cycle.terminator)
    // GNU a text retains its final LF even when input records use NUL.
    for (const text of cycle.append) emit(text)
    if (cycle.exitCode !== null) return cycle.exitCode
  }
  return 0
}

function runCycle(commands, cycle, emit) {
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i]
    if (command.kind === '}') continue
    const selected = selectsLine(command, cycle.text, cycle.line, cycle.last, cycle.regexState)
    if (selected === Boolean(command.negated)) {
      if (command.kind === '{') i = command.jump
      continue
    }
    if (command.kind === '{') continue
    if (command.kind === 'q') { cycle.exitCode = command.exitCode; break }
    if (command.kind === 'd') return true
    if (command.kind === 'c') {
      if (!command.active) emit(command.text.slice(0, -1), cycle.delimiter)
      return true
    }
    if (command.kind === 'a') { cycle.append.push(command.text); continue }
    if (command.kind === 'i') { emit(command.text.slice(0, -1), cycle.delimiter); continue }
    if (command.kind === 'p') { emit(cycle.text, cycle.terminator); continue }
    if (command.kind === '=') { emit(String(cycle.line), cycle.delimiter); continue }
    if (command.kind === 'y') { cycle.text = transliterateLine(cycle.text, command); continue }
    const result = substituteLine(cycle.text, command, cycle.regexState)
    cycle.text = result.out
    if (result.count && command.print) emit(cycle.text, cycle.terminator)
  }
  return false
}

function compileProgram({ order, positional }, stdin, ctx) {
  const commands = []
  const locale = ctx.vars.get('LC_ALL') || ctx.vars.get('LC_CTYPE') || ctx.vars.get('LANG') || ''
  const byteLocale = locale === 'C' || locale === 'POSIX'
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
    for (const command of parseSedScript(script, extended, byteLocale)) commands.push(command)
  }
  if (scripted) return { commands: finishSedProgram(commands), files: positional, stdin }
  if (positional.length === 0) return null
  return { commands: finishSedProgram(parseSedScript(positional[0], extended, byteLocale)), files: positional.slice(1), stdin }
}

function failure(e) {
  if (e.gap) return unsupported('feature', 'sed', e.gap, `sed: ${e.message}`)
  if (e instanceof RangeError) return unsupported('feature', 'sed', 'regex runtime limit', `sed: ${e.message}`)
  return unsupportedFrom(e, 'sed', `sed: ${e.message.replace(/^sed: /u, '')}`)
}
