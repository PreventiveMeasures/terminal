// Records and fields. `Input` walks the file operands (and stdin) one
// record at a time; `readRecord` splits records off a text per RS;
// `splitRecord` / `splitOn` apply the field rules. POSIX with gawk's
// extensions:
//   RS   `"\n"` (default) or another single character: split on it. `""`:
//        paragraph mode — blank lines separate records and a newline is
//        always a field separator too. Longer: a regex. RT holds the
//        text that ended the record.
//   FS   `" "` (default): runs of blanks and tabs, leading/trailing ones
//        ignored. Another single character: split on it literally, even
//        `|` or `.`. `""`: one field per character. Longer: a regex.
//   FIELDWIDTHS / FPAT   fixed-width columns / a regex each field must
//        match; whichever of the three was assigned last is in force.

import { AwkError } from './awk-common.js'
import { unescapeAwkString } from './awk-lex.js'
import { AwkRegex, compileRegex, splitByRegex, stepAt } from './awk-regex.js'
import { StrNum, ignoreCase, toNum, toStr } from './awk-value.js'
import { resolve } from './fs.js'

// `src` is `{ text, pos }`; advances `pos`. Returns { rec, rt } or null at
// the end of the text. A terminator at the very end does not start an
// empty final record, but an unterminated last line is still a record.
export function readRecord(src, rs, ic) {
  const { text } = src
  if (src.pos >= text.length) return null
  if (rs === '') return readParagraph(src)
  if (rs.length === 1) {
    const at = text.indexOf(rs, src.pos)
    const rec = text.slice(src.pos, at === -1 ? text.length : at)
    src.pos = at === -1 ? text.length : at + 1
    return { rec, rt: at === -1 ? '' : rs }
  }
  const re = compileRegex(rs, ic)
  let from = src.pos
  for (;;) {
    const m = re.search(text, from)
    if (!m) break
    // An empty match never ends a record.
    if (m.start === m.end) {
      if (m.end >= text.length) break
      from = m.end + stepAt(text, m.end)
      continue
    }
    const rec = text.slice(src.pos, m.start)
    src.pos = m.end
    return { rec, rt: text.slice(m.start, m.end) }
  }
  const rec = text.slice(src.pos)
  src.pos = text.length
  return { rec, rt: '' }
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
// the FS mode of record splitting.
export function splitOn(str, sep, paragraph, ic) {
  if (str === '') return []
  if (sep instanceof AwkRegex) return splitByRegex(str, sep)
  if (sep === ' ') {
    const trimmed = str.replace(/^[ \t\n]+|[ \t\n]+$/gu, '')
    return trimmed === '' ? [] : trimmed.split(/[ \t\n]+/u)
  }
  if (sep === '') return [...str]
  if (sep.length === 1 && (!paragraph || sep === '\n')) return str.split(sep)
  const source = sep.length === 1 ? `[${'^$.[]|()*+?{}\\'.includes(sep) ? '\\' + sep : sep}\n]` : paragraph ? `(${sep})|\n` : sep
  return splitByRegex(str, compileRegex(source, ic))
}

// FIELDWIDTHS: blank-separated column widths, each `width` or
// `skip:width`, with a final `*` meaning "the rest". Fields stop where
// the record does.
function splitWidths(str, spec) {
  const out = []
  let pos = 0
  for (const item of spec.trim().split(/\s+/u)) {
    if (item === '') continue
    if (pos >= str.length) break
    if (item === '*') { out.push(str.slice(pos)); break }
    const m = /^(?:(\d+):)?(\d+)$/u.exec(item)
    if (!m) throw new AwkError(`invalid FIELDWIDTHS value \`${spec}'`)
    pos += Number(m[1] ?? 0)
    if (pos >= str.length) break
    out.push(str.slice(pos, pos + Number(m[2])))
    pos += Number(m[2])
  }
  return out
}

// FPAT: each field is a match of the regex; an empty match is an empty
// field that advances one character.
function splitPattern(str, re) {
  const out = []
  let pos = 0
  while (pos <= str.length) {
    const m = re.search(str, pos)
    if (!m) break
    out.push(str.slice(m.start, m.end))
    if (m.start === m.end) {
      if (m.end >= str.length) break
      pos = m.end + stepAt(str, m.end)
    } else pos = m.end
  }
  return out
}

export function splitRecord(m, str) {
  const ic = ignoreCase(m)
  if (m.fieldMode === 'FIELDWIDTHS') return splitWidths(str, toStr(m.globals.get('FIELDWIDTHS'), m))
  if (m.fieldMode === 'FPAT') return splitPattern(str, compileRegex(toStr(m.globals.get('FPAT'), m), ic, m.warn))
  return splitOn(str, toStr(m.globals.get('FS'), m), toStr(m.globals.get('RS'), m) === '', ic)
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([^]*)$/u
const isExit = (sig) => sig !== undefined && sig.type === 'exit'

export class Input {
  constructor(ctx, stdin) {
    this.ctx = ctx
    this.stdin = stdin
    this.operands = null
    this.idx = 0
    this.src = null
    this.sawFile = false
    // Set when a BEGINFILE / ENDFILE rule ran `exit`.
    this.exitSignal = undefined
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

  // The next main-input record, with NR / FNR / FILENAME / RT maintained,
  // or null once every operand is exhausted (or a file rule exited).
  next(m) {
    if (this.operands === null) this.start(m)
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

  // Advance to the next readable operand. `var=value` operands are
  // assignments, applied when reached (so they can differ per file);
  // an empty operand is skipped; `-` is stdin. With no file operand at
  // all, stdin is read once at the end. A missing file is fatal — unless
  // a BEGINFILE rule sees ERRNO and says `nextfile`, gawk's idiom for
  // skipping unreadable files. A directory is skipped with a warning.
  open(m) {
    while (this.idx < this.operands.length) {
      const op = this.operands[this.idx++]
      if (op === '') continue
      const asg = ASSIGNMENT.exec(op)
      if (asg) { m.assign(asg[1], new StrNum(unescapeAwkString(asg[2], m.warn))); continue }
      this.sawFile = true
      if (op === '-' || op === '/dev/stdin') { if (this.use(m, op, this.stdin)) return true; continue }
      const abs = resolve(this.ctx.cwd, op)
      if (this.ctx.fs.isDir(abs)) {
        this.failFile(m, op, 'Is a directory')
        if (this.exitSignal === undefined) m.warn(`command line argument \`${op}' is a directory: skipped`)
        continue
      }
      if (!this.ctx.fs.isFile(abs)) {
        const sig = this.failFile(m, op, 'No such file or directory')
        if (sig !== undefined && sig.type === 'nextfile') continue
        if (this.exitSignal !== undefined) return false
        throw new AwkError(`${op}: no such file or directory`)
      }
      if (this.use(m, op, this.ctx.fs.readFile(abs))) return true
    }
    if (this.sawFile || this.exitSignal !== undefined) return false
    this.sawFile = true
    return this.use(m, '-', this.stdin)
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
    let src = this.readers.get(name)
    if (!src) {
      let text
      if (name === '-' || name === '/dev/stdin') text = this.stdin
      else {
        const abs = resolve(this.ctx.cwd, name)
        if (this.ctx.fs.isDir(abs)) { m.globals.set('ERRNO', 'Is a directory'); return { status: -1 } }
        if (!this.ctx.fs.isFile(abs)) { m.globals.set('ERRNO', 'No such file or directory'); return { status: -1 } }
        text = this.ctx.fs.readFile(abs)
      }
      src = { text, pos: 0 }
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
