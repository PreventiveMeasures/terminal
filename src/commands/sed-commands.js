// The commands that carry text of their own: s, y, and a, i and c.

import { UnsupportedError } from '../unsupported.js'
import { encodeUtf8 } from '../util.js'
import { TEXT_BUFFER, normalizeText, setupReplacement } from './sed-regex.js'
import {
  EOF, MESSAGES, bad, badHere, compileRegexHere, inInteger, inNonblank, inchar, isDigit, matchSlash,
  openFile, readEndOfCmd, safeNumber, savchar,
} from './sed-reader.js'

export function compileSubstitution(c, command) {
  const slash = inchar(c.src)
  const pattern = matchSlash(c, slash, true)
  if (pattern === null) bad(c, MESSAGES.UNTERM_S_CMD)
  const replacement = matchSlash(c, slash, false)
  if (replacement === null) bad(c, MESSAGES.UNTERM_S_CMD)
  Object.assign(command, setupReplacement(replacement, () => bad(c, MESSAGES.RECURSIVE_ESCAPE_C)))
  const flags = markSubstOpts(c, command)
  command.regex = compileRegexHere(c, pattern, flags, command.maxId + 1)
  if (command.eval && c.sandbox) bad(c, MESSAGES.DISALLOWED)
  if (command.eval) {
    throw new UnsupportedError('feature', 'substitution flag e', "sed: substitution flag 'e' (command evaluation) is not supported")
  }
  if (flags.multiline) {
    throw new UnsupportedError('feature', `substitution flag ${flags.multiline}`, `sed: substitution flag '${flags.multiline}' (multiline regex matching) is not supported`)
  }
}

function markSubstOpts(c, command) {
  const src = c.src
  const flags = { icase: false, multiline: false }
  Object.assign(command, { global: false, print: 0, eval: false, nth: 0 })
  for (;;) {
    const ch = inNonblank(src)
    switch (ch) {
      case 'i': case 'I': flags.icase = true; break
      case 'm': case 'M': flags.multiline = ch; break
      case 'e': command.eval = true; break
      case 'p':
        if (command.print) bad(c, MESSAGES.EXCESS_P_OPT)
        command.print = command.eval ? 2 : 1
        break
      case 'g':
        if (command.global) bad(c, MESSAGES.EXCESS_G_OPT)
        command.global = true
        break
      case 'w':
        command.writer = openFile(c, 'write')
        return flags
      case '}': case '#':
        savchar(src, ch)
        return flags
      case EOF: case '\n': case ';':
        return flags
      default: {
        if (isDigit(ch)) {
          if (command.nth) bad(c, MESSAGES.EXCESS_N_OPT)
          const nth = inInteger(src, ch)
          if (!nth) bad(c, MESSAGES.ZERO_N_OPT)
          command.nth = safeNumber(nth, 'substitution occurrence limit')
          break
        }
        if (ch === '\r' && inchar(src) === '\n') return flags
        badHere(c, MESSAGES.UNKNOWN_S_OPT)
      }
    }
  }
}

export function compileTransliteration(c, command) {
  const recursive = () => bad(c, MESSAGES.RECURSIVE_ESCAPE_C)
  const slash = inchar(c.src)
  const source = matchSlash(c, slash, false)
  if (source === null) bad(c, MESSAGES.UNTERM_Y_CMD)
  const from = normalizeText(source, TEXT_BUFFER, recursive)
  const target = matchSlash(c, slash, false)
  if (target === null) bad(c, MESSAGES.UNTERM_Y_CMD)
  const to = normalizeText(target, TEXT_BUFFER, recursive)
  const fromChars = c.byteLocale ? [...encodeUtf8(from)] : [...from]
  const toChars = c.byteLocale ? [...encodeUtf8(to)] : [...to]
  if (fromChars.length !== toChars.length) bad(c, MESSAGES.Y_CMD_LEN)
  const translation = c.byteLocale ? Uint8Array.from({ length: 256 }, (_, i) => i) : new Map()
  for (let i = 0; i < fromChars.length; i++) {
    // GNU's byte table overwrites duplicates; its multibyte search uses
    // the first matching pair instead.
    if (c.byteLocale) translation[fromChars[i]] = toChars[i]
    else if (!translation.has(fromChars[i])) translation.set(fromChars[i], toChars[i])
  }
  Object.assign(command, { translation, byteLocale: c.byteLocale })
  readEndOfCmd(c)
}

// a, i and c: `\` and a newline, `\` and the text, or the text itself after
// any blanks.
export function compileText(c, command) {
  let leadin = inNonblank(c.src)
  if (leadin === EOF) bad(c, MESSAGES.EXPECTED_SLASH)
  if (leadin === '\\') leadin = inchar(c.src)
  else {
    savchar(c.src, leadin)
    leadin = '\n'
  }
  readText(c, command, leadin)
}

// read_text: the text runs to an unescaped newline, and on into the next
// script when the last one ends in the middle of it.
export function readText(c, command, leadin) {
  const src = c.src
  if (command) {
    command.text = null
    c.pending = { command, text: '' }
  }
  if (leadin === EOF) return
  const pending = c.pending
  if (leadin !== '\n') pending.text += leadin
  let ch = inchar(src)
  while (ch !== EOF && ch !== '\n') {
    if (ch === '\\') {
      ch = inchar(src)
      if (ch !== EOF) pending.text += '\\'
    }
    if (ch === EOF) {
      pending.text += '\n'
      return
    }
    pending.text += ch
    ch = inchar(src)
  }
  pending.text += '\n'
  pending.command.text = normalizeText(pending.text, TEXT_BUFFER, () => bad(c, MESSAGES.RECURSIVE_ESCAPE_C))
  c.pending = null
}
