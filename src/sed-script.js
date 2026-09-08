// Read-only sed scripts: numeric print addresses and BRE substitutions.
// Unsupported commands/flags fail before reading any file.
import { AwkRegex, substituteAll } from './awk-regex.js'
import { breToEs } from './bre.js'
import { grepSource, validateRegex } from './grep-pattern.js'
import { asciiCompatible, hasUnicodeSpace } from './regex-locale.js'
import { UnsupportedError } from './unsupported.js'

export const SED_SUBSET = 'sed: only numeric print addresses and s/regexp/replacement/[gp] scripts are supported'
export function scriptGap(detail = 'script') { throw new UnsupportedError('feature', detail, SED_SUBSET) }

export function parseSedScript(script) {
  const p = { script, i: 0 }
  const commands = []
  while (p.i < script.length) {
    if (/[;\n \t]/u.test(script[p.i])) { p.i++; continue }
    const address = /^(\d+)(?:,(\d+))?/u.exec(script.slice(p.i))
    const start = address ? Number(address[1]) : 1
    const end = address ? Math.max(start, Number(address[2] ?? address[1])) : Number.POSITIVE_INFINITY
    if (start === 0) throw new Error('line numbers must be >= 1')
    if (address) p.i += address[0].length
    const kind = script[p.i++]
    if (kind === 'p') commands.push({ kind, start, end })
    else if (kind === 's') commands.push({ ...substitution(p), kind, start, end })
    else scriptGap()
    while (/[ \t]/u.test(script[p.i] ?? '')) p.i++
    if (p.i < script.length && !/[;\n]/u.test(script[p.i])) throw new Error('extra characters after command')
  }
  return commands
}

function delimited(p, sep, pattern) {
  let out = ''
  let bracket = false
  while (p.i < p.script.length) {
    const c = p.script[p.i++]
    if (c === '\n') scriptGap('multiline substitution')
    if (c === '\\') {
      const next = p.script[p.i++]
      if (next === undefined || next === '\n') scriptGap('multiline substitution')
      // An escaped delimiter is literal even if BRE normally gives its
      // escaped spelling an operator meaning (e.g. s+foo\+bar+X+).
      out += pattern && next === sep && '(){}+?|'.includes(next) ? next : c + next
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
  throw new Error('unterminated substitute command')
}

function substitution(p) {
  const sep = p.script[p.i++]
  if (!sep || /[\w\s\\]/u.test(sep) || sep.codePointAt(0) > 127) scriptGap('substitution delimiter')
  const pattern = delimited(p, sep, true)
  const replacement = delimited(p, sep, false)
  if (!pattern) scriptGap('previous regular expression')
  validateRegex(pattern, false)
  if (/\\[1-9]/u.test(pattern)) scriptGap('regex backreferences')
  const controls = { n: '\n', t: '\t', r: '\r', a: '\u0007', f: '\f', v: '\v' }
  const normalized = pattern.replace(/\\(.)/gu, (s, c) => Object.hasOwn(controls, c) ? controls[c] : s)
  const translated = breToEs(normalized)
  if (translated.error) throw new Error(translated.error)
  const re = new AwkRegex(grepSource(translated.source, true), false)
  const parts = replacementParts(replacement, sep, re.groupCount)
  const suffix = /^[^;\n]*/u.exec(p.script.slice(p.i))[0]
  const flags = suffix.replace(/[ \t]/gu, '')
  p.i += suffix.length
  if (/[^gp]/u.test(flags)) scriptGap('substitution flags')
  if (flags.indexOf('g') !== flags.lastIndexOf('g') || flags.indexOf('p') !== flags.lastIndexOf('p')) throw new Error('multiple substitution flags')
  return { re, parts, global: flags.includes('g'), print: flags.includes('p'), compatible: asciiCompatible(re.src, pattern), spaceClass: /\[:(?:space|blank):\]|\\[sS]/u.test(pattern) }
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

export function substituteLine(text, command) {
  if (/[\u0080-\u{10FFFF}]/u.test(text + command.re.src) && (!command.compatible || (command.spaceClass && hasUnicodeSpace(text)))) scriptGap('non-ASCII regex semantics')
  return substituteAll(text, command.re, (start, end) => {
    const captures = command.parts.some((p) => typeof p === 'number' && p > 0) ? command.re.groups(text, start, end) : null
    return command.parts.map((p) => typeof p === 'string' ? p : p === 0 ? text.slice(start, end) : captures[p]?.text ?? '').join('')
  }, command.global ? 'global' : 'first')
}
