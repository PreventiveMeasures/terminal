// RS: one literal character, empty for paragraphs, otherwise a regex; RT
// retains each record terminator. In paragraph mode a one-character FS also
// splits on newlines. FS: space trims/splits whitespace, empty splits characters,
// one character is literal, otherwise a regex. The most recently assigned
// FS/FIELDWIDTHS/FPAT selects the field-splitting mode.

import { AwkError, MAX_STEPS } from './common.js'
import { unescapeAwkString } from './lex.js'
import { subscript } from './array.js'
import { AwkRegex, compileRegex, splitByRegex, stepAt } from './regex.js'
import { StrNum, checkText, ignoreCase, toNum, toStr } from './value.js'
import { lookupWithNote } from '../notes.js'
import { consumeStdin } from '../util.js'
import { UINT32_MAX } from '../numeric.js'

// `src` is `{ text, pos }`; advances `pos`. Returns { rec, rt } or null at
// the end of the text. A terminator at the very end does not start an
// empty final record, but an unterminated last line is still a record.
export function readRecord(src, rs, ic) {
  const { text } = src
  if (src.pos >= text.length) return null
  if (rs === '') return readParagraph(src)
  let end, start
  if (rs.length === 1) {
    const at = text.indexOf(rs, src.pos)
    start = at === -1 ? text.length : at
    end = at === -1 ? text.length : at + 1
  } else {
    // gawk searches the rest of its buffer for the next match, as text of
    // its own: a word boundary where the record starts is read as if
    // nothing preceded it, which differs from reading it here only after a
    // word character. A match that is empty before the end gawk then steps
    // over in a way that drops text from the record; at the end it is no
    // terminator, as here.
    const re = compileRegex(rs, ic)
    if (re.wordAnchored && src.pos > 0 && re.tables.has('word', text.codePointAt(src.pos - 1))) {
      throw new AwkError('a regex RS with word-boundary operators after a word character is not supported', null, 'word-boundary RS')
    }
    const match = re.search(text, src.pos)
    if (match && match.start === match.end && match.start < text.length) {
      throw new AwkError('a regex RS that matches the empty string inside a record is not supported', null, 'empty-matching RS')
    }
    const found = match && match.start !== match.end ? match : null
    start = found?.start ?? text.length
    end = found?.end ?? text.length
  }
  const rec = text.slice(src.pos, start)
  src.pos = end
  return { rec, rt: text.slice(start, end) }
}

function readParagraph(src) {
  const { text } = src
  let pos = src.pos
  while (text[pos] === '\n') pos++
  if (pos >= text.length) { src.pos = pos; return null }
  const re = /\n\n+/gu
  re.lastIndex = pos
  const m = re.exec(text)
  if (!m) {
    src.pos = text.length
    const rec = text.slice(pos).replace(/\n+$/u, '')
    return { rec, rt: text.slice(pos + rec.length) }
  }
  src.pos = m.index + m[0].length
  return { rec: text.slice(pos, m.index), rt: m[0] }
}

// Split with an FS-style separator: a string under the FS rules, or a
// compiled regex (a regex literal handed to split()). Backs split() and
// the FS mode of record splitting. `seps`, when given, collects split()'s
// fourth array as [index, separator] pairs.
export function splitOn(str, sep, paragraph, ic, seps = null) {
  if (str === '') return []
  if (sep instanceof AwkRegex) return splitByRegex(str, sep, seps)
  if (sep === ' ') {
    if (seps !== null) return splitBlanks(str, seps)
    const trimmed = str.replace(/^[ \t\n]+|[ \t\n]+$/gu, '')
    return trimmed === '' ? [] : trimmed.split(/[ \t\n]+/u)
  }
  if (sep === '') {
    const chars = [...str]
    for (let i = 1; i < chars.length; i++) seps?.push([i, ''])
    return chars
  }
  if (sep.length === 1 && (!paragraph || sep === '\n')) {
    const parts = str.split(sep)
    for (let i = 1; i < parts.length; i++) seps?.push([i, sep])
    return parts
  }
  if (paragraph && sep === '^') throw new AwkError('paragraph splitting with FS="^" is not supported', null, 'paragraph FS caret')
  const source = sep.length === 1 ? `[${'^$.[]|()*+?{}\\'.includes(sep) ? '\\' + sep : sep}\n]` : sep
  return splitByRegex(str, compileRegex(source, ic), seps)
}

// Default splitting, keeping the blanks: seps[0] holds any before the
// first field, seps[n] any after the last.
function splitBlanks(str, seps) {
  const pieces = str.split(/([ \t\n]+)/u)
  const parts = []
  for (let i = 0; i < pieces.length; i += 2) {
    if (pieces[i] !== '') parts.push(pieces[i])
    if (i + 1 < pieces.length) seps.push([parts.length, pieces[i + 1]])
  }
  return parts
}

// FIELDWIDTHS: blank-separated column widths, each `width` or
// `skip:width`, with a final `*` meaning "the rest". Fields stop where
// the record does.
export function parseWidths(spec) {
  const items = spec.split(/[ \t]+/u).filter(Boolean)
  return items.map((item, i) => {
    const m = /^(?:(\+?\d+):)?(\+?\d+|\*)$/u.exec(item)
    const skip = m?.[1] === undefined ? 0 : Number(m[1])
    const width = m?.[2] === '*' ? UINT32_MAX : Number(m?.[2])
    if (!m || (m[1] !== undefined && skip === 0) || skip > UINT32_MAX || !(width > 0 && width <= UINT32_MAX) || (m[2] === '*' && i !== items.length - 1)) throw new AwkError(`invalid FIELDWIDTHS value \`${spec}'`)
    return { skip, width }
  })
}

function splitWidths(str, widths) {
  const chars = [...str]
  const out = []
  let pos = 0
  for (const { skip, width } of widths) {
    if (pos >= chars.length) break
    pos += skip
    out.push(chars.slice(pos, pos + width).join(''))
    pos += width
  }
  return out
}

// FPAT searches each remaining suffix. After a field, an immediately
// adjacent empty match is retried one character later (the separator).
function splitPattern(str, re) {
  const out = []
  let pos = 0
  while (pos < str.length) {
    let m = re.search(str.slice(pos))
    if (out.length > 0 && m?.end === 0) {
      pos += stepAt(str, pos)
      m = re.search(str.slice(pos))
    }
    if (!m) break
    out.push(str.slice(pos + m.start, pos + m.end))
    pos += m.end
  }
  return out
}

export function splitRecord(m, str) {
  const ic = ignoreCase(m)
  if (m.fieldMode === 'FIELDWIDTHS') return splitWidths(str, m.widths)
  if (m.fieldMode === 'FPAT') return splitPattern(str, compileRegex(toStr(m.globals.get('FPAT'), m), ic))
  return splitOn(str, toStr(m.globals.get('FS'), m), toStr(m.globals.get('RS'), m) === '', ic)
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([^]*)$/u
const isExit = (sig) => sig !== undefined && sig.type === 'exit'

export class Input {
  constructor(ctx, stdin) {
    this.ctx = ctx
    this.stdin = stdin
    this.idx = 1
    this.src = null
    this.sawFile = false
    // Set when a BEGINFILE / ENDFILE rule ran `exit`.
    this.exitSignal = undefined
    // Files opened by `getline < file`, by name, each with its own cursor.
    this.readers = new Map()
  }

  // The next main-input record, with NR / FNR / FILENAME / RT maintained,
  // or null once every operand is exhausted (or a file rule exited).
  next(m) {
    while (this.exitSignal === undefined) {
      if (this.src) {
        const r = readRecord(this.src, toStr(m.globals.get('RS'), m), ignoreCase(m))
        if (r !== null) {
          m.globals.set('NR', toNum(m.globals.get('NR')) + 1)
          m.globals.set('FNR', toNum(m.globals.get('FNR')) + 1)
          m.globals.set('RT', r.rt)
          return r.rec
        }
        this.closeFile(m)
        continue
      }
      if (!this.open(m)) return null
    }
    return null
  }

  // Advance through live ARGV/ARGC. Assignments apply per operand, empty
  // operands skip, and stdin is consumed once. BEGINFILE can use ERRNO and
  // nextfile to skip unreadable files; directories warn and skip.
  open(m) {
    while (this.idx < Math.trunc(toNum(m.globals.get('ARGC')))) {
      if (++m.steps > MAX_STEPS) throw new AwkError('input operand scan exceeded execution limit', null, 'execution limit')
      const index = this.idx++
      const op = toStr(m.globals.get('ARGV').get(subscript(index, String(index)))?.value, m)
      if (op === '') continue
      m.globals.set('ARGIND', this.idx - 1)
      const asg = ASSIGNMENT.exec(op)
      // gawk reads an assignment as it does -v, naming no place in its
      // warnings; a file it names in FILENAME, with FNR 0, before opening.
      if (asg) { m.assign(asg[1], new StrNum(unescapeAwkString(asg[2], (msg, key) => m.warnAt('', msg, key)))); continue }
      this.sawFile = true
      m.globals.set('FILENAME', op)
      m.globals.set('FNR', 0)
      const { text, error } = this.readOperand(op)
      if (error === 'Is a directory') {
        this.failFile(m, op, error)
        if (this.exitSignal === undefined) m.warn(`command line argument \`${op}' is a directory: skipped`)
        continue
      }
      if (error) {
        const sig = this.failFile(m, op, error)
        if (sig !== undefined && sig.type === 'nextfile') continue
        if (this.exitSignal !== undefined) return false
        throw new AwkError(`cannot open file \`${op}' for reading: ${error}`)
      }
      if (this.use(m, op, text)) return true
    }
    if (this.sawFile || this.exitSignal !== undefined) return false
    this.sawFile = true
    return this.use(m, '-', this.takeStdin())
  }

  readOperand(name) {
    if (name === '/dev/null') return { text: '' }
    if (name === '-' || name === '/dev/stdin') {
      return { text: name === '/dev/stdin' && this.ctx.stdinFile ? this.ctx.stdinOrigin : this.takeStdin() }
    }
    const { path, error } = lookupWithNote(this.ctx, 'awk', name)
    if (this.ctx.fs.isDir(path)) return { error: 'Is a directory' }
    return error ? { error } : { text: this.ctx.fs.readFile(path) }
  }

  takeStdin() {
    const text = this.stdin
    this.stdin = ''
    consumeStdin(this.ctx)
    return text
  }

  // Open a readable operand and run BEGINFILE. Returns false when the
  // rule skipped the file (`nextfile`) or exited.
  use(m, name, text) {
    this.src = { text, pos: 0 }
    m.globals.set('FILENAME', name)
    m.globals.set('FNR', 0)
    m.globals.set('ERRNO', '')
    const sig = m.fileRule('begin')
    if (isExit(sig)) { this.exitSignal = sig; this.src = null; return false }
    if (sig !== undefined && sig.type === 'nextfile') { this.closeFile(m); return false }
    checkText(m, text)
    return true
  }

  // An operand that cannot be read: BEGINFILE, if any, gets to look at
  // ERRNO and decide.
  failFile(m, name, reason) {
    m.globals.set('ERRNO', reason)
    if (!m.hasFileRules) return
    m.globals.set('FILENAME', name)
    m.globals.set('FNR', 0)
    const sig = m.fileRule('begin')
    if (isExit(sig)) this.exitSignal = sig
    return sig
  }

  // End of the current file, from exhaustion or `nextfile`: ENDFILE runs.
  closeFile(m) {
    this.src = null
    const sig = m.fileRule('end')
    if (isExit(sig)) this.exitSignal = sig
  }

  // `getline < name`: 1 with a record, 0 at end of file, -1 when the
  // file cannot be opened. Each name keeps its cursor until close().
  readNamed(m, name) {
    if (name === '') throw new AwkError("expression for `<' redirection has null string value")
    let src = this.readers.get(name)
    if (!src) {
      const { text, error } = this.readOperand(name)
      if (error) { m.globals.set('ERRNO', error); return { status: -1 } }
      src = { text: checkText(m, text), pos: 0 }
      this.readers.set(name, src)
    }
    const r = readRecord(src, toStr(m.globals.get('RS'), m), ignoreCase(m))
    if (r === null) return { status: 0 }
    m.globals.set('RT', r.rt)
    return { status: 1, record: r.rec }
  }

  // close(name): 0 when something was open under that name, -1 otherwise.
  close(m, name) {
    if (this.readers.delete(name)) return 0
    m.globals.set('ERRNO', 'close of redirection that was never opened')
    return -1
  }
}
