// Read-only sed scripts with line/regex addresses and BRE/ERE substitutions.
// Unsupported commands/flags fail before reading any file.
import { AwkRegex, substituteAll } from '../awk/regex.js'
import { breToEs } from '../bre.js'
import { validateBracket } from '../charclass.js'
import { ereClasses, grepSource, validateRegex } from './grep-pattern.js'
import { asciiCompatible, hasUnicodeSpace } from '../regex-locale.js'
import { UnsupportedError } from '../unsupported.js'

export const SED_SUBSET = 'sed: only addressed p and s/regexp/replacement/[gp] scripts are supported'
export function scriptGap(detail = 'script') { throw new UnsupportedError('feature', detail, SED_SUBSET) }

export function parseSedScript(script, extended = false) {
  const p = { script, i: 0, extended }
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
    const kind = script[p.i++]
    if (kind === 'p') commands.push({ kind, start, end, active })
    else if (kind === 's') commands.push({ ...substitution(p), kind, start, end, active })
    else scriptGap()
    while (/[ \t]/u.test(script[p.i] ?? '')) p.i++
    if (script[p.i] === '#') scriptGap('comments')
    if (p.i < script.length && !/[;\n]/u.test(script[p.i])) throw new Error('extra characters after command')
  }
  return commands
}

function parseAddress(p, relative = false) {
  while (/[ \t]/u.test(p.script[p.i] ?? '')) p.i++
  if (p.script[p.i] === '~') scriptGap('step address')
  if (p.script[p.i] === '\\') scriptGap('address delimiter')
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
  } else if (p.script[p.i] === '/') {
    p.i++
    result = { type: 'regex', ...compilePattern(delimited(p, '/', true, 'address regex'), p.extended) }
    if (/[IM]/u.test(p.script[p.i] ?? '')) scriptGap('address regex flags')
  }
  while (/[ \t]/u.test(p.script[p.i] ?? '')) p.i++
  return result
}

export function selectsLine(command, text, line, last) {
  const { start, end } = command
  if (start === null) return true
  if (end === null) return matchesAddress(start, text, line, last)
  if (!command.active) {
    if (!matchesAddress(start, text, line, last)) return false
    command.active = true
    // A regex range end is first tested on the line after the start.
    if (end.type === 'regex') return true
    if (end.type === 'offset') command.until = line + end.value
  }
  const done = end.type === 'offset' ? line >= command.until
    : end.type === 'line' ? line >= end.value : matchesAddress(end, text, line, last)
  if (done) command.active = false
  return true
}

function matchesAddress(address, text, line, last) {
  if (address.type === 'line') return line === address.value
  if (address.type === 'last') return last
  checkRegexText(text, address)
  return address.re.search(text) !== null
}

function delimited(p, sep, pattern, label = 'substitute command') {
  let out = ''
  let bracket = false
  while (p.i < p.script.length) {
    const c = p.script[p.i++]
    if (c === '\n') scriptGap('multiline substitution')
    if (c === '\\') {
      const next = p.script[p.i++]
      if (next === undefined || next === '\n') scriptGap('multiline substitution')
      // Delimiter quoting is removed before regex parsing, so \| with a
      // | delimiter becomes a literal in BRE and an alternative in ERE.
      out += pattern && !bracket && next === sep ? next : c + next
      continue
    }
    if (c === sep && !bracket) return out
    if (pattern && c === '[' && !bracket) {
      bracket = true
      out += c
      if (p.script[p.i] === '^') out += p.script[p.i++]
      if (p.script[p.i] === ']') out += p.script[p.i++]
      continue
    }
    // Skip POSIX named/collating/equivalence class interiors as a unit.
    if (pattern && bracket && c === '[' && /[:.=]/u.test(p.script[p.i] ?? '')) {
      const end = p.script.indexOf(p.script[p.i] + ']', p.i + 1)
      if (end < 0) throw new Error('unterminated character class')
      out += c + p.script.slice(p.i, end + 2); p.i = end + 2; continue
    }
    if (pattern && c === ']') bracket = false
    out += c
  }
  throw new Error(`unterminated ${label}`)
}

function substitution(p) {
  const sep = p.script[p.i++]
  if (!sep || /[\w\s\\]/u.test(sep) || sep.codePointAt(0) > 127) scriptGap('substitution delimiter')
  const pattern = delimited(p, sep, true)
  const replacement = delimited(p, sep, false)
  const compiled = compilePattern(pattern, p.extended)
  const parts = replacementParts(replacement, sep, compiled.re.groupCount)
  const suffix = /^[^;\n#]*/u.exec(p.script.slice(p.i))[0]
  const flags = suffix.replace(/[ \t]/gu, '')
  p.i += suffix.length
  if (/[^gp]/u.test(flags)) scriptGap('substitution flags')
  if (flags.indexOf('g') !== flags.lastIndexOf('g') || flags.indexOf('p') !== flags.lastIndexOf('p')) throw new Error('multiple substitution flags')
  return { ...compiled, parts, global: flags.includes('g'), print: flags.includes('p') }
}

function compilePattern(pattern, extended) {
  if (!pattern) scriptGap('previous regular expression')
  validateRegex(pattern, extended)
  if (!extended) validateBre(pattern)
  if (/\\[1-9]/u.test(pattern)) scriptGap('regex backreferences')
  const controls = { n: '\n', t: '\t', r: '\r', a: '\u0007', f: '\f', v: '\v' }
  const normalized = pattern.replace(/\\(.)/gu, (s, c) => {
    if (c === 'o') scriptGap('regex escape')
    return Object.hasOwn(controls, c) ? controls[c] : s
  })
  const translated = extended ? { source: ereClasses(normalized) } : breToEs(normalized)
  if (translated.error) throw new Error(translated.error)
  const re = new AwkRegex(grepSource(translated.source, true), false)
  return { re, compatible: asciiCompatible(re.src, pattern), spaceClass: /\[:(?:space|blank):\]|\\[sS]/u.test(pattern) }
}

// ERE accepts stray closing parentheses and malformed intervals as literals;
// translating BRE first would incorrectly accept its escaped versions too.
function validateBre(pattern) {
  let groups = 0
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '[') { i = validateBracket(pattern, i); continue }
    if (pattern[i] !== '\\') continue
    const c = pattern[++i]
    if (c === '(') groups++
    else if (c === ')') {
      if (--groups < 0) throw new Error('unmatched \\)')
    } else if (c === '{') {
      const interval = /^\d+(?:,\d*)?\\\}/u.exec(pattern.slice(i + 1))
      if (interval === null) throw new Error('invalid repetition count')
      i += interval[0].length
    }
  }
  if (groups > 0) throw new Error('unmatched \\(')
}

function replacementParts(text, sep, groupCount) {
  const parts = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '&') { parts.push(0); continue }
    if (c !== '\\') { parts.push(c); continue }
    const next = text[++i]
    if (/[1-9]/u.test(next)) {
      if (Number(next) > groupCount) throw new Error(`invalid reference \\${next} in replacement`)
      parts.push(Number(next))
    } else if (next === '\\' || next === '&' || next === sep) parts.push(next)
    else if (next === 'n') parts.push('\n')
    else if (next === 't') parts.push('\t')
    else scriptGap('replacement escape')
  }
  return parts
}

function checkRegexText(text, command) {
  if (/[\u0080-\u{10FFFF}]/u.test(text + command.re.src) && (!command.compatible || (command.spaceClass && hasUnicodeSpace(text)))) scriptGap('non-ASCII regex semantics')
}

export function substituteLine(text, command) {
  checkRegexText(text, command)
  const needsCaptures = command.parts.some((p) => typeof p === 'number' && p > 0)
  return substituteAll(text, command.re, (start, end) => {
    const captures = needsCaptures ? command.re.groups(text, start, end) : null
    return command.parts.map((p) => typeof p === 'string' ? p : p === 0 ? text.slice(start, end) : captures[p]?.text ?? '').join('')
  }, command.global ? 'global' : 'first')
}
