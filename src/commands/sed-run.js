import { appendOutput } from '../shell/output.js'
import { UnsupportedError, markUnsupported, unsupportedNote } from '../unsupported.js'
import { MAX_SED_SPACE, MAX_SED_STEPS, sedFailure } from './sed-common.js'
import { sedInput } from './sed-input.js'
import { lineWriter } from './sed-output.js'
import { selectsLine, substituteLine } from './sed-script.js'
import { transliterateLine } from './sed-text.js'

export function runSed(program, flags, ctx, capture = false) {
  const { output, delimiter } = program
  const quiet = flags.has('n') || flags.has('quiet') || flags.has('silent')
  const separate = flags.has('s') || flags.has('separate')
  const input = sedInput(program.files, program.stdin, ctx, delimiter, separate, (text) => output.stream(2, text))
  const result = output.start(input)
  const content = []
  const emit = lineWriter(capture ? (text) => { output.account(text); content.push(text) } : (text) => output.stream(1, text), delimiter)
  const state = { delimiter, quiet, separate, regexState: program.regexState, budget: program.budget, emit, input, output }
  try {
    const code = runRecords(program.commands, state)
    result.quit = code !== null
    result.exitCode = input.status.failed ? 2 : code ?? 0
    result.failed = input.status.failed
  } catch (e) {
    const failed = sedFailure(e)
    appendOutput(result, failed)
    const note = unsupportedNote(failed)
    if (note) markUnsupported(result, note.kind, note.command, note.detail, note.message)
    result.failed = true
  } finally { output.finish() }
  if (capture) result.content = content.join('')
  return result
}

function runRecords(commands, state) {
  let first = true
  for (let record = state.input.next(); record; record = state.input.next()) {
    if (first || state.separate && record.reset) {
      for (const command of commands) {
        command.active = command.start?.type === 'line' && command.start.value === 0
        command.closed = false
      }
      first = false
    }
    state.output.record(record)
    const cycle = { ...record, ...state, append: [], exitCode: null, replaced: false }
    const deleted = runCycle(commands, cycle)
    if (!state.quiet && !deleted) state.emit(cycle.text, cycle.terminator)
    if (cycle.exitCode !== null) state.emit('')
    flushAppend(cycle)
    if (cycle.exitCode !== null) return cycle.exitCode
    state.output.record(null)
  }
  return null
}

function runCycle(commands, cycle) {
  for (let i = 0; i < commands.length; i++) {
    if (++cycle.budget.steps > MAX_SED_STEPS) {
      throw new UnsupportedError('feature', 'execution limit', `sed: execution limit reached after ${MAX_SED_STEPS} commands (infinite loop?)`)
    }
    const command = commands[i]
    if (command.kind === '}' || command.kind === ':') continue
    const selected = selectsLine(command, cycle.text, cycle.line, cycle.last, cycle.regexState)
    if (selected === Boolean(command.negated)) {
      if (command.kind === '{') i = command.jump
      continue
    }
    const kind = command.kind
    if (kind === '{') continue
    if (kind === 'b' || kind === 't' || kind === 'T') {
      const jump = kind === 'b' || (kind === 't' ? cycle.replaced : !cycle.replaced)
      if (kind !== 'b') cycle.replaced = false
      if (jump) i = command.jump - 1
      continue
    }
    if (kind === 'q') { cycle.exitCode = command.exitCode; break }
    if (kind === 'd') return true
    if (kind === 'n' || kind === 'N') { if (!nextPattern(cycle, kind === 'N')) return true; continue }
    if (kind === 'c') {
      if (!command.active && command.text !== null) cycle.emit(command.text.slice(0, -1), cycle.delimiter)
      return true
    }
    outputCommand(command, cycle)
    if (cycle.text.length > MAX_SED_SPACE) throw new UnsupportedError('feature', 'pattern space limit', 'sed: pattern space limit exceeded')
  }
  return false
}

function outputCommand(command, cycle) {
  const { kind } = command
  if (kind === 'a') { cycle.append.push(command.text); return }
  if (kind === 'i') {
    if (command.text !== null) cycle.emit(command.text.slice(0, -1), cycle.delimiter)
  } else if (kind === 'p') cycle.emit(cycle.text, cycle.terminator)
  else if (kind === 'P') {
    const end = cycle.text.indexOf(cycle.delimiter)
    cycle.emit(end < 0 ? cycle.text : cycle.text.slice(0, end), end < 0 ? cycle.terminator : cycle.delimiter)
  } else if (kind === '=') cycle.emit(String(cycle.line), cycle.delimiter)
  else if (kind === 'y') cycle.text = transliterateLine(cycle.text, command)
  else {
    const result = substituteLine(cycle.text, command, cycle.regexState)
    cycle.text = result.out
    if (!result.count) return
    cycle.replaced = true
    if (command.print) cycle.emit(cycle.text, cycle.terminator)
    if (command.writer) command.writer(cycle.text, cycle.terminator)
  }
}

function nextPattern(cycle, append) {
  if (!append && !cycle.quiet) cycle.emit(cycle.text, cycle.terminator)
  if (cycle.last()) {
    if (append && !cycle.quiet) cycle.emit(cycle.text, cycle.terminator)
    return false
  }
  flushAppend(cycle)
  const record = cycle.input.next()
  if (!record) {
    if (append && !cycle.quiet) cycle.emit(cycle.text, cycle.delimiter)
    return false
  }
  const text = append ? cycle.text + cycle.delimiter + record.text : record.text
  if (text.length > MAX_SED_SPACE) throw new UnsupportedError('feature', 'pattern space limit', 'sed: pattern space limit exceeded')
  Object.assign(cycle, record, { text, replaced: false })
  cycle.output.record(record)
  return true
}

function flushAppend(cycle) {
  if (cycle.append.length === 0) return
  cycle.emit('')
  for (const text of cycle.append) cycle.emit(text ?? '')
  cycle.append.length = 0
}
