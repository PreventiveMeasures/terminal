// A script is compiled the way GNU sed 4.9's compile.c reads one (see
// ./sed-reader.js), so that a fault is found in GNU's order and reported
// where GNU's reader stood. Faults found once the scripts are read — an
// unmatched `{`, and those found while running — are at char 0 of the
// expression they belong to, as GNU's are.

import { UnsupportedError } from '../unsupported.js'
import { LOCALE, isByteLocale } from '../locale.js'
import { decodeUtf8, encodeUtf8 } from '../util.js'
import { panic, scriptGap } from './sed-common.js'
import { compileSubstitution, compileText, compileTransliteration, readText } from './sed-commands.js'
import {
  EOF, MESSAGES, ascii, bad, badHere, compileRegexHere, inInteger, inNonblank, inchar, isDigit, isSpace,
  located, matchSlash, openFile, readEndOfCmd, readFilename, readLabel, safeNumber, savchar, strverscmp, where,
} from './sed-reader.js'

// `openWrite` opens a w file as GNU does, while the script is read; `openRead`
// an R file, which may be missing.
export function createCompiler({ locale = LOCALE, openWrite = null, openRead = null, sandbox = false } = {}) {
  return {
    commands: [], blocks: [], pending: null, first: true, quiet: false, expressions: 0, src: null,
    extended: false, locale, byteLocale: isByteLocale(locale), openWrite, openRead, sandbox,
  }
}

export function compileString(c, text) {
  c.src = { text, i: 0, name: null, expression: ++c.expressions }
  compileProgram(c)
  c.src.done = true
  c.first = false
}

export function compileFile(c, name, text) {
  c.src = { text, i: 0, name, expression: 0 }
  compileProgram(c)
  c.src.done = true
  c.first = false
}

// check_final_program: blocks, unfinished text and labels.
export function finishProgram(c) {
  if (c.blocks.length) throw located(c.blocks.at(-1).at, MESSAGES.EXCESS_OPEN_BRACE)
  if (c.pending) {
    // Text that runs off the last script is kept as written, unescaped.
    c.pending.command.text = c.pending.text || null
    c.pending = null
  }
  const { commands } = c
  const labels = new Map()
  for (let i = 0; i < commands.length; i++) if (commands[i].kind === ':') labels.set(commands[i].label, i)
  // GNU resolves the jumps last to first, and the last definition of a label.
  for (let i = commands.length - 1; i >= 0; i--) {
    const command = commands[i]
    if (!['b', 't', 'T'].includes(command.kind)) continue
    const jump = command.label === '' ? commands.length : labels.get(command.label)
    if (jump === undefined) throw panic(`can't find label for jump to \`${command.label}'`)
    command.jump = jump
  }
  return { commands, quiet: c.quiet, badProg: (why) => located(where(c.src), why) }
}

function compileProgram(c) {
  const src = c.src
  if (c.pending) readText(c, null, '\n')
  for (;;) {
    let ch
    while ((ch = inchar(src)) === ';' || isSpace(ch));
    if (ch === EOF) break
    const command = { kind: null, a1: null, a2: null, bang: false, rangeState: 'inactive' }
    const a1 = compileAddress(c, ch)
    if (a1) {
      if (a1.type === 'step' || a1.type === 'stepMod') bad(c, MESSAGES.BAD_STEP)
      command.a1 = a1
      ch = inNonblank(src)
      if (ch === ',') {
        command.a2 = compileAddress(c, inNonblank(src))
        if (!command.a2) badHere(c, MESSAGES.BAD_COMMA)
        ch = inNonblank(src)
      }
      if (a1.type === 'num' && a1.n === 0 && ((!command.a2 && ch !== 'r') || (command.a2 && command.a2.type !== 'regex'))) badHere(c, MESSAGES.INVALID_LINE_0)
    }
    if (ch === '!') {
      command.bang = true
      ch = inNonblank(src)
      if (ch === '!') bad(c, MESSAGES.BAD_BANG)
    }
    command.kind = ch
    if (compileCommand(c, command, ch)) c.commands.push(command)
  }
}

// One command after its addresses; false for those that are not commands
// to run (`#`, `v`).
function compileCommand(c, command, ch) {
  const src = c.src
  switch (ch) {
    case '#': return comment(c, command)
    case 'v':
      if (strverscmp(readLabel(src) || '4.0', '4.9') > 0) bad(c, MESSAGES.ANCIENT_VERSION)
      return false
    case '{':
      c.blocks.push({ index: c.commands.length, at: src.name === null ? { expression: src.expression, char: 0 } : where(src) })
      command.bang = !command.bang
      return true
    case '}':
      if (!c.blocks.length) bad(c, MESSAGES.EXCESS_CLOSE_BRACE)
      if (command.a1) bad(c, MESSAGES.NO_CLOSE_BRACE_ADDR)
      readEndOfCmd(c)
      c.commands[c.blocks.pop().index].jump = c.commands.length
      return true
    case 'e':
      if (c.sandbox) bad(c, MESSAGES.DISALLOWED)
      return scriptGap('e command')
    case 'a': case 'i': case 'c': compileText(c, command); return true
    case ':':
      if (command.a1) bad(c, MESSAGES.NO_COLON_ADDR)
      command.label = readLabel(src)
      if (!command.label) bad(c, MESSAGES.COLON_LACKS_LABEL)
      return true
    case 'T': case 'b': case 't': command.label = readLabel(src); return true
    case 'Q': case 'q': case 'L': case 'l': return numberArgument(c, command, ch)
    case '=': case 'd': case 'D': case 'F': case 'g': case 'G': case 'h': case 'H':
    case 'n': case 'N': case 'p': case 'P': case 'z': case 'x':
      readEndOfCmd(c)
      return true
    case 'r': return readCommand(c, command)
    case 'R': command.reader = openFile(c, 'read'); return true
    case 'W': case 'w': command.writer = openFile(c, 'write'); return true
    case 's': compileSubstitution(c, command); return true
    case 'y': compileTransliteration(c, command); return true
    case EOF: return bad(c, MESSAGES.NO_COMMAND)
    default:
      // GNU names the command by its first byte, which is no text when the
      // command is a character past ASCII.
      if (!ascii(ch)) decodeUtf8(encodeUtf8(ch).slice(0, 1))
      return bad(c, `unknown command: \`${ch}'`)
  }
}

function comment(c, command) {
  const src = c.src
  if (command.a1) bad(c, MESSAGES.NO_SHARP_ADDR)
  let next = inchar(src)
  // `#n` as the first two characters of the first script is -n.
  if (next === 'n' && c.first && src.i === 2) c.quiet = true
  while (next !== EOF && next !== '\n') next = inchar(src)
  return false
}

// q and Q take an exit status, l and L a line length.
function numberArgument(c, command, ch) {
  if ((ch === 'q' || ch === 'Q') && command.a2) bad(c, MESSAGES.ONE_ADDR)
  const next = inNonblank(c.src)
  if (isDigit(next)) command.intArg = Number(BigInt.asIntN(32, inInteger(c.src, next)))
  else {
    command.intArg = -1
    savchar(c.src, next)
  }
  readEndOfCmd(c)
  return true
}

function readCommand(c, command) {
  command.fname = readFilename(c)
  if (!command.fname) bad(c, MESSAGES.MISSING_FILENAME)
  // `0r` reads its file in before the first line.
  command.append = !(command.a1?.type === 'num' && command.a1.n === 0 && !command.a2)
  if (!command.append) command.a1 = { type: 'num', n: 1 }
  return true
}

function compileAddress(c, first) {
  const src = c.src
  let ch = first
  if (ch === '/' || ch === '\\') {
    if (ch === '\\') ch = inchar(src)
    const pattern = matchSlash(c, ch, true)
    if (pattern === null) bad(c, MESSAGES.UNTERM_ADDR_RE)
    const flags = { icase: false, multiline: false }
    for (;;) {
      ch = inNonblank(src)
      if (ch === 'I') flags.icase = true
      else if (ch === 'M') flags.multiline = true
      else break
    }
    savchar(src, ch)
    const regex = compileRegexHere(c, pattern, flags, 0)
    if (flags.multiline) throw new UnsupportedError('feature', 'address regex flags', "sed: address regex flag 'M' (multiline regex matching) is not supported")
    return { type: 'regex', regex }
  }
  if (isDigit(ch)) {
    const n = safeNumber(inInteger(src, ch), 'address limit')
    ch = inNonblank(src)
    if (ch !== '~') {
      savchar(src, ch)
      return { type: 'num', n }
    }
    const step = safeNumber(inInteger(src, inNonblank(src)), 'address limit')
    return step > 0 ? { type: 'numMod', n, step } : { type: 'num', n }
  }
  if (ch === '+' || ch === '~') {
    const step = safeNumber(inInteger(src, inNonblank(src)), 'address limit')
    // A zero step is no address at all: it matches, and ends a range at once.
    if (step === 0) return { type: 'null' }
    return { type: ch === '+' ? 'step' : 'stepMod', step }
  }
  if (ch === '$') return { type: 'last' }
  return null
}
