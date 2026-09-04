// Records and fields. `Input` walks the file operands (and stdin) one
// record at a time; `readRecord` splits records off a text per RS;
// `splitFields` applies FS. Both splitters implement the POSIX rules
// with gawk's common extensions:
//   RS   `"\n"` (default) or another single character: split on it. `""`:
//        paragraph mode — blank lines separate records and a newline is
//        always a field separator too. Longer: a regex.
//   FS   `" "` (default): runs of blanks and tabs, leading/trailing ones
//        ignored. Another single character: split on it literally, even
//        `|` or `.`. `""`: one field per character. Longer: a regex.

import { AwkError } from './awk-common.js'
import { unescapeAwkString } from './awk-lex.js'
import { compileRegex, ereToEs, withFlags } from './awk-regex.js'
import { StrNum, toNum, toStr } from './awk-value.js'
import { resolve } from './fs.js'

// `src` is `{ text, pos }`; advances `pos`. Returns null at end of text.
// A terminator at the very end does not start an empty final record,
// but an unterminated last line is still a record.
export function readRecord(src, rs) {
  const { text } = src
  if (src.pos >= text.length) return null
  if (rs === '') return readParagraph(src)
  if (rs.length === 1) {
    const at = text.indexOf(rs, src.pos)
    const rec = text.slice(src.pos, at === -1 ? text.length : at)
    src.pos = at === -1 ? text.length : at + 1
    return rec
  }
  const re = withFlags(compileRegex(rs), 'g')
  re.lastIndex = src.pos
  const m = re.exec(text)
  if (!m || m[0] === '') {
    const rec = text.slice(src.pos)
    src.pos = text.length
    return rec
  }
  const rec = text.slice(src.pos, m.index)
  src.pos = m.index + m[0].length
  return rec
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
    return text.slice(pos).replace(/\n+$/u, '')
  }
  src.pos = m.index + m[0].length
  return text.slice(pos, m.index)
}

// Split on every non-empty match of `re`. Written out rather than
// `String.prototype.split` because that would also splice in the
// contents of capturing groups the user put in FS.
export function splitByRegex(str, re) {
  const g = withFlags(re, 'g')
  const out = []
  let last = 0
  for (const m of str.matchAll(g)) {
    if (m[0] === '') continue
    out.push(str.slice(last, m.index))
    last = m.index + m[0].length
  }
  out.push(str.slice(last))
  return out
}

// `fs` is either a string (FS / a split() separator string) or a RegExp
// (a regex literal handed to split()).
export function splitFields(str, fs, paragraph) {
  if (str === '') return []
  if (fs instanceof RegExp) return splitByRegex(str, fs)
  if (fs === ' ') {
    const trimmed = str.replace(/^[ \t\n]+|[ \t\n]+$/gu, '')
    return trimmed === '' ? [] : trimmed.split(/[ \t\n]+/u)
  }
  if (fs === '') return [...str]
  if (fs.length === 1) {
    if (!paragraph || fs === '\n') return str.split(fs)
    return str.split(new RegExp(`[${RegExp.escape(fs)}\n]`, 'u'))
  }
  const source = paragraph ? `(?:${ereToEs(fs)})|\n` : ereToEs(fs)
  return splitByRegex(str, new RegExp(source, 'su'))
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([^]*)$/u

export class Input {
  constructor(ctx, stdin) {
    this.ctx = ctx
    this.stdin = stdin
    this.operands = null
    this.idx = 0
    this.src = null
    this.sawFile = false
    // Files opened by `getline < file`, by name, each with its own cursor.
    this.readers = new Map()
  }

  // The operand list comes from ARGV/ARGC at the moment input is first
  // needed — after BEGIN, so a BEGIN block may edit them, as in gawk.
  start(m) {
    const argc = Math.trunc(toNum(m.globals.get('ARGC')))
    const argv = m.globals.get('ARGV')
    this.operands = []
    for (let i = 1; i < argc; i++) {
      const v = argv instanceof Map ? argv.get(String(i)) : undefined
      this.operands.push(toStr(v, m))
    }
  }

  // The next main-input record, with NR / FNR / FILENAME maintained, or
  // null once every operand is exhausted.
  next(m) {
    if (this.operands === null) this.start(m)
    for (;;) {
      if (this.src) {
        const rec = readRecord(this.src, toStr(m.globals.get('RS'), m))
        if (rec !== null) {
          m.globals.set('NR', toNum(m.globals.get('NR')) + 1)
          m.globals.set('FNR', toNum(m.globals.get('FNR')) + 1)
          return rec
        }
        this.src = null
      }
      if (!this.open(m)) return null
    }
  }

  // Advance to the next readable operand. `var=value` operands are
  // assignments, applied when reached (so they can differ per file);
  // an empty operand is skipped; `-` is stdin. With no file operand at
  // all, stdin is read once at the end. A missing file is fatal, as in
  // gawk; a directory is skipped with a warning.
  open(m) {
    while (this.idx < this.operands.length) {
      const op = this.operands[this.idx++]
      if (op === '') continue
      const asg = ASSIGNMENT.exec(op)
      if (asg) { m.assign(asg[1], new StrNum(unescapeAwkString(asg[2]))); continue }
      this.sawFile = true
      if (op === '-' || op === '/dev/stdin') { this.use(m, op, this.stdin); return true }
      const abs = resolve(this.ctx.cwd, op)
      if (this.ctx.fs.isDir(abs)) { m.warn(`warning: command line argument \`${op}' is a directory: skipped`); continue }
      if (!this.ctx.fs.isFile(abs)) throw new AwkError(`${op}: no such file or directory`)
      this.use(m, op, this.ctx.fs.readFile(abs))
      return true
    }
    if (this.sawFile) return false
    this.sawFile = true
    this.use(m, '-', this.stdin)
    return true
  }

  use(m, name, text) {
    this.src = { text, pos: 0 }
    m.globals.set('FILENAME', name)
    m.globals.set('FNR', 0)
  }

  // `nextfile`: drop the rest of the current operand.
  skipFile() { this.src = null }

  // `getline < name`: 1 with a record, 0 at end of file, -1 when the
  // file cannot be opened. Each name keeps its cursor until close().
  readNamed(m, name) {
    let src = this.readers.get(name)
    if (!src) {
      let text
      if (name === '-' || name === '/dev/stdin') text = this.stdin
      else {
        const abs = resolve(this.ctx.cwd, name)
        if (!this.ctx.fs.isFile(abs)) return { status: -1 }
        text = this.ctx.fs.readFile(abs)
      }
      src = { text, pos: 0 }
      this.readers.set(name, src)
    }
    const rec = readRecord(src, toStr(m.globals.get('RS'), m))
    return rec === null ? { status: 0 } : { status: 1, record: rec }
  }

  // close(name): 0 when something was open under that name, -1 otherwise.
  close(name) {
    return this.readers.delete(name) ? 0 : -1
  }
}
