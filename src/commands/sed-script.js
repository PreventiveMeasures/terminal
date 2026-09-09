// Script syntax is checked before reading input data.
import { readSedText, readTransliteration } from './sed-text.js'
import { scriptGap } from './sed-common.js'
import { checkRegexText, compilePattern, delimited, delimiter, resolvePattern, substitution } from './sed-regex.js'
import { INT32_MAX } from '../numeric.js'

export { SED_SUBSET } from './sed-common.js'
export { substituteLine } from './sed-regex.js'

export function parseSedScript(script, extended = false, byteLocale = false) {
  const p = { script, i: 0, extended, byteLocale }
  const commands = []
  while (p.i < script.length) {
    if (/[;\n \t]/u.test(script[p.i])) { p.i++; continue }
    if (script[p.i] === '#') scriptGap('comments')
    const start = parseAddress(p)
    let end = null
    if (start && script[p.i] === ',') {
      p.i++
      end = parseAddress(p, true)
      if (end === null) throw new Error('missing second address')
    }
    if (script[p.i] === '~') scriptGap('step address')
    const active = start?.type === 'line' && start.value === 0
    if (active && end?.type !== 'regex') throw new Error('line numbers must be >= 1')
    let negated = false
    if (script[p.i] === '!') {
      negated = true; p.i++
      while (/[ \t]/u.test(script[p.i] ?? '')) p.i++
      if (script[p.i] === '!') throw new Error("multiple '!'s")
    }
    const kind = script[p.i++]
    const command = { kind, start, end, active, negated }
    if (kind === 'p' || kind === 'd' || kind === '=') commands.push(command)
    else if (kind === 's') commands.push({ ...command, ...substitution(p) })
    else if (kind === 'a' || kind === 'i' || kind === 'c') commands.push({ ...command, text: readSedText(p) })
    else if (kind === 'y') commands.push({ ...command, ...readTransliteration(p) })
    else if (kind === 'q') {
      if (end !== null) throw new Error('command only uses one address')
      const code = /^[ \t]*(\d*)/u.exec(script.slice(p.i))
      p.i += code[0].length
      commands.push({ ...command, exitCode: Math.min(Number(code[1]), INT32_MAX) % 256 })
    } else if (kind === '{') { commands.push(command); continue }
    else if (kind === '}') {
      if (start !== null) throw new Error("'}' doesn't want any addresses")
      commands.push(command)
    }
    else if (kind === undefined) throw new Error('missing command')
    else if (':btTQlLDFgGhHnNPzxrRwWev'.includes(kind)) scriptGap()
    else throw new Error(`unknown command: '${kind}'`)
    while (/[ \t]/u.test(script[p.i] ?? '')) p.i++
    if (script[p.i] === '#') scriptGap('comments')
    if (p.i < script.length && !/[;\n}]/u.test(script[p.i])) throw new Error('extra characters after command')
  }
  return commands
}

export function finishSedProgram(commands) {
  const blocks = []
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i]
    if (command.kind === '{') blocks.push(command)
    if (command.kind === '}') {
      if (blocks.length === 0) throw new Error("unexpected '}'")
      blocks.pop().jump = i
    }
  }
  if (blocks.length) throw new Error("unmatched '{'")
  return commands
}

function parseAddress(p, relative = false) {
  while (/[ \t]/u.test(p.script[p.i] ?? '')) p.i++
  if (p.script[p.i] === '~') scriptGap('step address')
  const value = /^(\d+|\+[ \t]*\d+)/u.exec(p.script.slice(p.i))
  let result = null
  if (value) {
    const offset = value[0][0] === '+'
    if (offset && !relative) throw new Error('relative address requires a range')
    const n = Number(value[0].replace(/[ \t]/gu, ''))
    if (!Number.isSafeInteger(n)) scriptGap('address limit')
    p.i += value[0].length
    result = { type: offset ? 'offset' : 'line', value: n }
  } else if (p.script[p.i] === '$') {
    p.i++
    result = { type: 'last' }
  } else if (p.script[p.i] === '/' || p.script[p.i] === '\\') {
    if (p.script[p.i] === '\\') p.i++
    const sep = delimiter(p, 'address regex')
    result = { type: 'regex', ...compilePattern(delimited(p, sep, true, 'address regex'), p.extended, true) }
    if (/^[ \t]*[IM]/u.test(p.script.slice(p.i))) {
      if (result.re === null) throw new Error('cannot specify modifiers on empty regexp')
      scriptGap('address regex flags')
    }
  }
  while (/[ \t]/u.test(p.script[p.i] ?? '')) p.i++
  return result
}

export function selectsLine(command, text, line, last, state) {
  const { start, end } = command
  if (start === null) return true
  if (end === null) return matchesAddress(start, text, line, last, state)
  if (!command.active) {
    if (start.type === 'line') {
      // A prior d/c can skip this command on its numeric start line.
      if (command.closed || line < start.value) return false
    } else if (!matchesAddress(start, text, line, last, state)) return false
    command.active = true
    // A regex range end is first tested on the line after the start.
    if (end.type === 'regex') return true
    if (end.type === 'offset') command.until = line + end.value
    if (end.type === 'line') {
      command.active = line < end.value
      command.closed = !command.active
      return line <= end.value || matchesAddress(start, text, line, last, state)
    }
  }
  if (end.type === 'line') {
    command.active = line < end.value
    command.closed = !command.active
    return line <= end.value
  }
  const done = end.type === 'offset' ? line >= command.until
    : matchesAddress(end, text, line, last, state)
  if (done) { command.active = false; command.closed = true }
  return true
}

function matchesAddress(address, text, line, last, state) {
  if (address.type === 'line') return line === address.value
  if (address.type === 'last') return typeof last === 'function' ? last() : last
  const pattern = resolvePattern(address, state)
  checkRegexText(text, pattern)
  return pattern.re.search(text) !== null
}
