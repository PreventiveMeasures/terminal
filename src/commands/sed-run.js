import { UnsupportedError, markUnsupported, unsupportedNote } from '../unsupported.js'
import { decodeUtf8, encodeUtf8Loose } from '../util.js'
import { MAX_SED_SPACE, MAX_SED_STEPS, panic, sedFailure } from './sed-common.js'
import { writeFile } from './sed-files.js'
import { sedInput } from './sed-input.js'
import { outputStream } from './sed-output.js'
import { matchesRegex, substitute } from './sed-regex.js'

// execute.c: a cycle reads a line into the pattern space, runs the program
// over it and prints it unless told not to; a and r output waits for the
// next read, or for q.
export function runSed(program, ctx, capture = false) {
  const { output, delimiter } = program
  const input = sedInput(program.files, program.stdin, ctx, delimiter, program.separate, (text) => output.stderr(text), program.labels)
  const result = output.start(input)
  const content = []
  const main = capture ? outputStream((text) => { output.account(text); content.push(text) }, delimiter) : output.main()
  const state = { ...program, input, main, ctx, line: null, replaced: false, appends: [], steps: 0 }
  let failure = null
  try {
    const code = runRecords(state, capture)
    result.quit = code !== null
    result.exitCode = input.status.failed ? (input.status.directory ? 4 : 2) : code ?? 0
    result.failed = input.status.failed
  } catch (e) { failure = e }
  // GNU's diagnostic precedes what stdio still holds of stdout, which it
  // writes out as it exits; a closed stdout fails as sed closes it, which
  // it does when it finishes rather than dies.
  if (failure) output.stderr(sedFailure(failure).stderr)
  try { output.finish(!capture && failure === null && !input.status.directory) } catch (e) {
    failure = e
    output.stderr(sedFailure(e).stderr)
  }
  if (failure) {
    const failed = sedFailure(failure)
    result.exitCode = failed.exitCode
    result.failed = true
    const note = unsupportedNote(failed)
    if (note) markUnsupported(result, note.kind, note.command, note.detail, note.message)
  }
  if (capture) result.content = content.join('')
  return result
}

function runRecords(state, capture) {
  const { commands } = state
  let first = true
  for (let record = state.input.next(); record; record = state.input.next()) {
    if (first || state.separate && record.reset) {
      // GNU empties the hold space between separate files, keeping whether
      // its last line had a delimiter, and rewinds the R files.
      state.hold.text = ''
      for (const command of commands) {
        command.rangeState = command.a1?.type === 'num' && command.a1.n === 0 ? 'active' : 'inactive'
        command.reader?.rewind()
      }
      if (capture) state.main.missing = false
      first = false
    }
    state.steps = 0
    state.replaced = false
    state.output.record(record)
    state.line = { text: record.text, terminator: record.terminator, number: record.line, last: record.last, name: record.name }
    const code = executeProgram(state)
    if (code !== null) return code
    dumpAppends(state)
    state.output.record(null)
  }
  return null
}

function executeProgram(state) {
  const { commands, delimiter, main } = state
  for (let i = 0; i < commands.length; i++) {
    if (++state.steps > MAX_SED_STEPS) {
      throw new UnsupportedError('feature', 'execution limit', `sed: execution limit reached after ${MAX_SED_STEPS} commands without reading input (infinite loop?)`)
    }
    const command = commands[i]
    if (matchAddress(command, state) === command.bang) continue
    const line = state.line
    const nl = line.terminator !== ''
    // The commands that move on, end the cycle or quit; the rest edit.
    switch (command.kind) {
      case '{': case 'b': i = command.jump - 1; break
      case 'c':
        if (command.rangeState !== 'active' && command.text !== null) main.line(command.text.slice(0, -1), true)
        return null
      case 'd': return null
      case 'D': {
        const end = line.text.indexOf(delimiter)
        if (end < 0) return null
        // The rest starts the cycle over, unread and unprinted.
        line.text = line.text.slice(end + delimiter.length)
        i = -1
        break
      }
      case 'n':
        if (!state.quiet) main.line(line.text, nl)
        if (line.last() || !readPatternSpace(state, false)) return null
        break
      case 'N':
        if (line.last() || !readPatternSpace(state, true)) {
          if (!state.quiet) main.line(line.text, nl)
          return null
        }
        break
      case 'q':
        if (!state.quiet) main.line(line.text, nl)
        dumpAppends(state, true)
        return command.intArg === -1 ? 0 : command.intArg & 255
      case 'Q': return command.intArg === -1 ? 0 : command.intArg & 255
      case 't':
        if (state.replaced) { state.replaced = false; i = command.jump - 1 }
        break
      case 'T':
        if (state.replaced) state.replaced = false
        else i = command.jump - 1
        break
      default: edit(command, state, nl)
    }
  }
  if (!state.quiet) main.line(state.line.text, state.line.terminator !== '')
  return null
}

function edit(command, state, nl) {
  const { delimiter, line, main } = state
  switch (command.kind) {
    case 'a': state.appends.push({ text: command.text }); break
    case 'g': Object.assign(line, { text: state.hold.text, terminator: state.hold.terminator }); break
    case 'G': appendSpace(line, state.hold, delimiter, 'pattern space limit'); break
    case 'h': Object.assign(state.hold, { text: line.text, terminator: line.terminator }); break
    case 'H': appendSpace(state.hold, line, delimiter, 'hold space limit'); break
    case 'i': if (command.text !== null) main.line(command.text.slice(0, -1), true); break
    case 'l': list(state, command.intArg === -1 ? defaultLineLength(state) : command.intArg); break
    case 'L': throw panic('INTERNAL ERROR: Bad cmd L')
    case 'p': main.line(line.text, nl); break
    case 'P': firstLine(main, line, delimiter); break
    case 'r':
      if (command.append) state.appends.push({ file: command.fname })
      else writeFile(state, command.fname)
      break
    case 'R': {
      const text = command.reader.next()
      if (text !== null) state.appends.push({ text })
      break
    }
    case 's': {
      const result = substitute(line.text, command, state.regexState, state.badProg)
      line.text = result.out
      if (line.text.length > MAX_SED_SPACE) throw new UnsupportedError('feature', 'pattern space limit', 'sed: pattern space limit exceeded')
      if (!result.replaced) break
      state.replaced = true
      if (command.print) main.line(line.text, nl)
      command.writer?.line(line.text, nl)
      break
    }
    case 'w': command.writer.line(line.text, nl); break
    case 'W': firstLine(command.writer, line, delimiter); break
    case 'x': {
      const { text, terminator } = line
      Object.assign(line, { text: state.hold.text, terminator: state.hold.terminator })
      Object.assign(state.hold, { text, terminator })
      break
    }
    case 'y': line.text = transliterate(line.text, command); break
    case 'z': line.text = ''; break
    case '=': main.supply(); main.print(`${line.number}${delimiter}`); break
    case 'F': main.supply(); main.print(`${line.name}${delimiter}`); break
    // `}` and `:` are where jumps land.
    default: break
  }
}

// match_address_p: a range's state moves on as lines are tested, whether or
// not the command then runs.
function matchAddress(command, state) {
  const { a1, a2 } = command
  if (!a1) return true
  const number = state.line.number
  if (command.rangeState !== 'active') {
    if (!a2) return matchOne(a1, state)
    if (a1.type === 'num') {
      // A prior d or c can skip this command on its numeric start line.
      if (command.rangeState === 'closed' || number < a1.n) return false
    } else if (!matchOne(a1, state)) return false
    command.rangeState = 'active'
    switch (a2.type) {
      // A regex range end is first tested on the line after the start.
      case 'regex': return true
      case 'num':
        if (number >= a2.n) command.rangeState = 'closed'
        return number <= a2.n || matchOne(a1, state)
      case 'step': a2.end = number + a2.step; return true
      case 'stepMod': a2.end = number + a2.step - (number % a2.step); return true
      // Any other end is tested on the start line too.
      default: break
    }
  }
  if (a2.type === 'num') {
    if (number >= a2.n) command.rangeState = 'closed'
    return number <= a2.n
  }
  if (matchOne(a2, state)) command.rangeState = 'closed'
  return true
}

function matchOne(address, state) {
  const { line } = state
  switch (address.type) {
    case 'null': return true
    case 'regex': return matchesRegex(address.regex, line.text, state.regexState, state.badProg)
    case 'numMod': return line.number >= address.n && (line.number - address.n) % address.step === 0
    case 'step': case 'stepMod': return address.end <= line.number
    case 'last': return line.last()
    default: return address.n === line.number
  }
}

function readPatternSpace(state, append) {
  dumpAppends(state)
  state.replaced = false
  const record = state.input.next()
  if (!record) return false
  state.steps = 0
  const { line } = state
  const text = append ? line.text + state.delimiter + record.text : record.text
  if (text.length > MAX_SED_SPACE) throw new UnsupportedError('feature', 'pattern space limit', 'sed: pattern space limit exceeded')
  Object.assign(line, { text, terminator: record.terminator, number: record.line, last: record.last, name: record.name })
  state.output.record(record)
  return true
}

function appendSpace(to, from, delimiter, limit) {
  to.text += delimiter + from.text
  to.terminator = from.terminator
  if (to.text.length > MAX_SED_SPACE) throw new UnsupportedError('feature', limit, `sed: ${limit} exceeded`)
}

function firstLine(out, line, delimiter) {
  const end = line.text.indexOf(delimiter)
  out.line(end < 0 ? line.text : line.text.slice(0, end), end >= 0 || line.terminator !== '')
}

// dump_append_queue, which q calls even with nothing queued.
function dumpAppends(state, always = false) {
  if (!always && state.appends.length === 0) return
  state.main.supply()
  for (const append of state.appends) {
    if (append.text) state.main.write(append.text)
    if (append.file) writeFile(state, append.file)
  }
  state.appends.length = 0
}

function defaultLineLength(state) {
  if (state.colsSet) throw new UnsupportedError('feature', 'COLS', 'sed: an `l` line length taken from COLS is not supported')
  return state.lineLength
}

// do_list: what is not printable ASCII as an escape, octal for the rest,
// each byte of a character past ASCII on its own; lines broken with `\`
// short of the length.
const LIST_ESCAPES = { 7: '\\a', 8: '\\b', 12: '\\f', 10: '\\n', 13: '\\r', 9: '\\t', 11: '\\v' }

function list(state, length) {
  const { main, delimiter } = state
  main.supply()
  let width = 0
  for (const byte of encodeUtf8Loose(state.line.text)) {
    const escaped = byte >= 0x20 && byte < 0x7f ? (byte === 92 ? '\\\\' : String.fromCodePoint(byte))
      : LIST_ESCAPES[byte] ?? '\\' + byte.toString(8).padStart(3, '0')
    if (width + escaped.length >= length && length > 0) {
      main.write('\\')
      main.write(delimiter)
      width = 0
    }
    main.write(escaped)
    width += escaped.length
  }
  main.write('$')
  main.write(delimiter)
}

function transliterate(text, command) {
  if (command.byteLocale) return decodeUtf8(encodeUtf8Loose(text).map((byte) => command.translation[byte]))
  let out = ''
  for (const c of text) out += command.translation.get(c) ?? c
  return out
}
