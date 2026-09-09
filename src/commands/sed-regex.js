import { AwkRegex, substituteAll } from '../awk/regex.js'
import { breToEs, validateBackreferences } from '../bre.js'
import { ereClasses, grepSource, validateRegex } from './grep-pattern.js'
import { asciiCompatible, hasUnicodeSpace } from '../regex-locale.js'
import { scriptGap } from './sed-common.js'

export function delimiter(p, label = 'substitute command') {
  const sep = p.script[p.i++]
  if (sep === undefined || sep === '\n') throw new Error(`unterminated ${label}`)
  if (sep.codePointAt(0) > 127) throw new Error('delimiter character is not a single-byte character')
  return sep
}

export function delimited(p, sep, pattern, label = 'substitute command') {
  let out = ''
  let bracket = false
  while (p.i < p.script.length) {
    const c = p.script[p.i++]
    if (c === '\n') scriptGap('multiline substitution')
    if (c === sep && !bracket) return out
    if (c === '\\') {
      const next = p.script[p.i++]
      if (next === undefined || next === '\n') scriptGap('multiline substitution')
      // Delimiter quoting is removed before regex parsing, so \| with a
      // | delimiter becomes a literal in BRE and an alternative in ERE.
      out += !bracket && next === sep && (pattern || next !== '&') ? next : c + next
      continue
    }
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

export function substitution(p) {
  const sep = delimiter(p)
  const pattern = delimited(p, sep, true)
  const replacement = delimited(p, sep, false)
  const compiled = compilePattern(pattern, p.extended)
  const parts = replacementParts(replacement, compiled.re?.groupCount)
  return { ...compiled, parts, ...substitutionFlags(p, compiled.re === null) }
}

function substitutionFlags(p, previous) {
  const suffix = /^[^;\n#}]*/u.exec(p.script.slice(p.i))[0]
  p.i += suffix.length
  const flags = { global: false, print: false, nth: null }
  for (const token of suffix.match(/\d+|[^ \t]/gu) ?? []) {
    if (/^\d/u.test(token)) {
      if (flags.nth !== null) throw new Error('multiple number options to substitute command')
      flags.nth = Number(token)
      if (flags.nth === 0) throw new Error('number option to substitute command may not be zero')
      if (!Number.isSafeInteger(flags.nth)) scriptGap('substitution occurrence limit')
    } else if (token === 'g' || token === 'p') {
      const flag = token === 'g' ? 'global' : 'print'
      if (flags[flag]) throw new Error('multiple substitution flags')
      flags[flag] = true
    } else if ('iImM'.includes(token) && previous) throw new Error('cannot specify modifiers on empty regexp')
    else if ('iImMew'.includes(token)) scriptGap('substitution flags')
    else throw new Error(`unknown option to substitute command: '${token}'`)
  }
  return flags
}

export function compilePattern(pattern, extended, noSub = false) {
  if (!pattern) return { re: null }
  validateRegex(pattern, extended)
  const controls = { n: '\n', t: '\t', r: '\r', a: '\u0007', f: '\f', v: '\v' }
  const normalized = pattern.replace(/\\(.)/gu, (s, c) => {
    if (c === 'o') scriptGap('regex escape')
    return Object.hasOwn(controls, c) ? controls[c] : s
  })
  const translated = extended ? { source: ereClasses(normalized) } : breToEs(normalized)
  if (translated.error) throw new Error(translated.error)
  validateSedRegex(translated.source, extended)
  validateBackreferences(translated.source)
  for (const [, escape] of translated.source.matchAll(/\\(.)/gu)) {
    if (/[1-9]/u.test(escape)) scriptGap('regex backreferences')
  }
  const re = new AwkRegex(grepSource(translated.source, true), false)
  return { re, noSub, compatible: asciiCompatible(re.src, pattern), spaceClass: /\[:(?:space|blank):\]|\\[sS]/u.test(pattern) }
}

// GNU sed's POSIX modes are stricter than grep and AWK: ERE rejects stray
// parentheses, malformed intervals and leading repeats; BRE also rejects a
// star or interval stacked after another repeat. Inspect the canonical tokens
// so escaped metacharacters and class members keep their literal meaning.
function validateSedRegex(source, extended) {
  let bracket = false, groups = 0, repeatable = false, repeated = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '\\') {
      const next = source[++i]
      if (!bracket) { repeatable = !'bB<>`\''.includes(next); repeated = false }
      continue
    }
    if (bracket) {
      if (c === ']') { bracket = false; repeatable = true; repeated = false }
      continue
    }
    if (c === '[') { bracket = true; continue }
    if (c === '(') { groups++; repeatable = false; repeated = false; continue }
    if (c === ')') {
      if (--groups < 0) throw new Error('unmatched )')
    } else if (c === '|' || c === '^' || c === '$') {
      repeatable = false; repeated = false; continue
    } else if ('*+?{'.includes(c)) {
      const interval = c === '{' ? /^\{(?=\d|,)(\d*)(?:,(\d*))?\}/u.exec(source.slice(i)) : null
      if (c === '{' && interval === null) throw new Error('invalid repetition count')
      if (!repeatable || (!extended && repeated && (c === '*' || c === '{'))) throw new Error('Invalid preceding regular expression')
      if (interval) i += interval[0].length - 1
      repeated = true
      continue
    }
    repeatable = true; repeated = false
  }
  if (groups > 0) throw new Error('unmatched (')
}

function replacementParts(text, groupCount) {
  const parts = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '&') { parts.push(0); continue }
    if (c !== '\\') { parts.push(c); continue }
    const next = text[++i]
    if (/[0-9]/u.test(next)) {
      if (Number(next) > groupCount) throw new Error(`invalid reference \\${next} in replacement`)
      parts.push(Number(next))
    } else if (next === '\\' || next === '&') parts.push(next)
    else if (next === 'n') parts.push('\n')
    else if (next === 't') parts.push('\t')
    else scriptGap('replacement escape')
  }
  return parts
}

export function checkRegexText(text, command) {
  if (/[\u0080-\u{10FFFF}]/u.test(text + command.re.src) && (!command.compatible || (command.spaceClass && hasUnicodeSpace(text)))) scriptGap('non-ASCII regex semantics')
}

export function resolvePattern(command, state, neededGroups = null) {
  const pattern = command.re === null ? state.last : command
  if (!pattern) throw new Error('no previous regular expression')
  state.last = pattern
  if (neededGroups !== null && pattern.noSub) {
    if (neededGroups > pattern.re.groupCount) throw new Error(`invalid reference \\${neededGroups} in replacement`)
    pattern.noSub = false
  }
  return pattern
}

export function substituteLine(text, command, state) {
  const neededGroups = command.parts.reduce((max, p) => typeof p === 'number' ? Math.max(max, p) : max, 0)
  const pattern = resolvePattern(command, state, neededGroups)
  checkRegexText(text, pattern)
  const needsCaptures = command.parts.some((p) => typeof p === 'number' && p > 0 && p <= pattern.re.groupCount)
  let count = 0
  // Sed's numeric selector skips empty matches adjacent to a prior match;
  // AWK's numeric gensub mode counts them, so retain global-mode scanning.
  const re = command.nth && !command.global ? { search: (str, from) => count ? null : pattern.re.search(str, from) } : pattern.re
  const result = substituteAll(text, re, (start, end, index) => {
    if (command.nth && index < command.nth) return null
    count++
    const captures = needsCaptures ? pattern.re.groups(text, start, end) : null
    return command.parts.map((p) => typeof p === 'string' ? p : p === 0 ? text.slice(start, end) : captures?.[p]?.text ?? '').join('')
  }, command.global || command.nth ? 'global' : 'first')
  return { out: result.out, count }
}
