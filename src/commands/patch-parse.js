import { UnsupportedError } from '../unsupported.js'
import { lineRecords } from '../util.js'
import { lineReader, parseNormalHunk, parseUnifiedHunk, restartAt } from './patch-hunks.js'
import { parseContextHunk } from './patch-context.js'

export { restartAt } from './patch-hunks.js'

// Reading a patch the way GNU patch's pch.c does: scan forward for the
// headers that name a file, until a hunk of some format begins; then the
// hunks, one at a time. What cannot be read here is refused by name on the
// feed: ed scripts (they need ed), git binary patches, Prereq: lines.

export class PatchFatal extends Error {
  constructor(message) {
    super(message)
    this.name = 'PatchFatal'
  }
}

const refuse = (detail, message) => { throw new UnsupportedError('feature', detail, message) }

// The patch as lines, and what reading it carries from one hunk to the next
// (see lineReader in ./patch-hunks.js). A last line without its newline is
// kept, with one, for the text a missing file's message shows; `end` is
// where the lines patch can read stop, short of it. `say` is where patch's
// own remarks about the input go, between the lines of its output.
export function createScanner(text, say, loose) {
  const lines = lineRecords(text)
  const incomplete = lines.length > 0 && !lines.at(-1).endsWith('\n')
  if (incomplete) lines[lines.length - 1] += '\n'
  return {
    lines, pos: 0, base: 0, empty: text === '', end: lines.length - (incomplete ? 1 : 0), incomplete, markers: [],
    say, loose, hunkmax: 125, prefixContext: 0, hunkBeg: 0, newStyle: false, skew: 0,
  }
}

const NORMAL_COMMAND = /^\d[\d,]*[acd][\d,]*[ \t]*\r?\n$/u
const ED_COMMAND = /^(?:\d+(?:,\d+)?)?(?:[acdi]|s\/\.\/\/)[ \t]*\n$/u
const HEX = /^[0-9a-fA-F]+/u

// pch.c intuit_diff_type. The header names land in slots in the order the
// lines come — `+++` in the old slot, `---` in the new one — and swap when
// a unified hunk starts; a context hunk uses them as they are. `/dev/null`
// leaves the slot alone and marks the side nonexistent, which is how a git
// header's name survives it.
// What the headers of a patch say, before any has said anything.
export const blankHeader = () => ({ names: { old: null, new: null, index: null }, stamps: { old: -1, new: -1 }, timestrs: { old: null, new: null },
  says: [0, 0], git: false, rename: [false, false], copy: [false, false], extended: false })

export function scanHeaders(scanner, { needHeader, strip, format }) {
  const h = blankHeader()
  let need = needHeader && format !== 'normal' && format !== 'ed'
  // What the last line was carries over as pch.c keeps it: a line is taken
  // for a command only where it starts like one, and every other line leaves
  // the answer as it was; the stars are looked at only once a header has
  // been seen. A hunk starts where the read that found it did, comments it
  // passed over and all.
  let command = false, edCommand = false, firstCommand = -1, starsThis = false
  const reader = lineReader(scanner)
  let start = reader.at
  for (;;) {
    const lastCommand = command, previous = start, starsLast = starsThis
    start = reader.at
    const s = reader.next()
    if (s === null) {
      // Nothing but ed commands, deletes most likely: GNU would run ed.
      if (edCommand) refuse('ed script', 'ed scripts are not supported')
      if (h.extended) return { ...h, type: 'unified', start, sline: reader.line, empty: true }
      return null
    }
    // A git header with no hunks under it ends at the next one, which is
    // read again, its names its own, as the start of the next patch.
    if (h.extended && s.startsWith('diff --git ')) return { ...h, type: 'unified', start, sline: reader.line, empty: true }
    // GNU reads past indentation when looking for a command line.
    const bare = s.replace(/^[ \tX]+/u, '')
    if (/^\d[\d,]*[acd]/u.test(bare)) command = NORMAL_COMMAND.test(bare)
    if (!need && firstCommand < 0 && (ED_COMMAND.test(bare) || command)) { firstCommand = start; edCommand = ED_COMMAND.test(bare) }
    const header = headerLine(s, h, strip, starsLast)
    if (header === 'binary') refuse('git binary patch', 'git binary diffs are not supported')
    if (header === 'prereq') refuse('Prereq', 'Prereq: lines are not supported')
    if (header) need = false
    // GNU reads a hunk through its indentation, announcing the depth.
    if (/^[ \t]+(?:@@ -\d|\*{8})/u.test(s)) refuse('indented patch', 'indented patches are not supported')
    if (need) continue
    if (s.endsWith('\r\n') && (s.startsWith('@@ -') || starsLast)) refuse('CRLF patch', 'patches with CRLF line endings are not supported')
    if ((format === null || format === 'ed') && firstCommand >= 0 && s === '.\n') refuse('ed script', 'ed scripts are not supported')
    if ((format === null || format === 'unified') && s.startsWith('@@ -')) return unifiedStart(h, start, reader.line, s)
    starsThis = s.startsWith('********')
    if ((format === null || format === 'context') && starsLast && s.startsWith('*** ')) return contextStart(scanner, h, previous, reader.line - 1, s)
    if ((format === null || format === 'normal') && lastCommand && (s.startsWith('< ') || s.startsWith('> '))) return { ...h, type: 'normal', start: previous, sline: reader.line - 1 }
  }
}

function headerLine(s, h, strip, starsLast) {
  if (!starsLast && s.startsWith('*** ')) return fetchInto(h, 'old', s.slice(4), strip)
  if (s.startsWith('+++ ')) return fetchInto(h, 'old', s.slice(4), strip)
  if (s.startsWith('Index:')) {
    // A name with too few slashes for -p leaves the slot as it was.
    const { name } = fetchName(s.slice(6), strip, false)
    if (name !== undefined) h.names.index = name
    return 'index'
  }
  if (s.startsWith('Prereq:')) return 'prereq'
  if (s.startsWith('diff --git ')) {
    const first = parseName(s.slice(11), strip)
    const second = first.name === null ? null : parseName(first.rest, strip)
    h.names.old = second && second.rest.trim() === '' ? first.name : null
    h.names.new = h.names.old === null ? null : second.name
    h.git = true
    h.stamps.old = h.stamps.new = -1
    return 'git'
  }
  if (h.git) {
    const git = gitHeader(s, h)
    if (git) return git
  }
  let t = s
  while (t.startsWith('- ')) t = t.slice(2)
  if (t.startsWith('--- ')) return fetchInto(h, 'new', t.slice(4), strip)
  return null
}

function gitHeader(s, h) {
  if (s.startsWith('index ')) {
    const first = HEX.exec(s.slice(6))
    const rest = first ? s.slice(6 + first[0].length) : ''
    const second = rest.startsWith('..') ? HEX.exec(rest.slice(2)) : null
    if (!second) return null
    h.says[0] = /^0+$/u.test(first[0]) ? 2 : 0
    h.says[1] = /^0+$/u.test(second[0]) ? 2 : 0
    h.extended = true
    return 'index'
  }
  if (s.startsWith('old mode ') || s.startsWith('new mode ')) { h.extended = true; return 'mode' }
  if (s.startsWith('deleted file mode ')) { h.says[1] = 2; h.extended = true; return 'mode' }
  if (s.startsWith('new file mode ')) { h.says[0] = 2; h.extended = true; return 'mode' }
  if (s.startsWith('rename from ')) { h.rename[0] = true; h.extended = true; return 'rename' }
  if (s.startsWith('rename to ')) { h.rename[1] = true; h.extended = true; return 'rename' }
  if (s.startsWith('copy from ')) { h.copy[0] = true; h.extended = true; return 'copy' }
  if (s.startsWith('copy to ')) { h.copy[1] = true; h.extended = true; return 'copy' }
  if (s.startsWith('GIT binary patch')) return 'binary'
  return null
}

function fetchInto(h, slot, text, strip) {
  const fetched = fetchName(text, strip, true)
  if (fetched.stamp !== undefined) h.stamps[slot] = fetched.stamp
  if (fetched.name !== undefined) { h.names[slot] = fetched.name; h.timestrs[slot] = fetched.timestr }
  return 'name'
}

// pch.c reads the counts for what they say of the two files before the hunk
// itself is read: an old side starting at line 0 is a file that is not
// there yet, and so is a new one — the digits alone, whatever follows them.
function unifiedStart(h, start, sline, s) {
  const swapped = { names: { ...h.names, old: h.names.new, new: h.names.old }, stamps: { old: h.stamps.new, new: h.stamps.old }, timestrs: { old: h.timestrs.new, new: h.timestrs.old } }
  const says = [...h.says]
  let at = 4
  if (s[at] === '0' && !/\d/u.test(s[at + 1])) says[0] = 1 + (swapped.stamps.old === 0 ? 1 : 0)
  while (at < s.length && s[at] !== ' ' && s[at] !== '\n') at++
  while (s[at] === ' ') at++
  if (s[at] === '+' && s[at + 1] === '0' && !/\d/u.test(s[at + 2])) says[1] = 1 + (swapped.stamps.new === 0 ? 1 : 0)
  return { ...h, ...swapped, says, type: 'unified', start, sline }
}

// GNU reads the first hunk here to see whether it empties the file, and
// whatever it finds wrong with that hunk on the way stops it here, before a
// file is named. A `*** ` line ending in `*` is the new style of context
// diff, which pch.c reads a little differently; the old style can turn out
// to be the new one, but not on this first look.
function contextStart(scanner, h, start, sline, s) {
  const says = [...h.says]
  if (/^\*\*\* 0(?!\d)/u.test(s)) says[0] = 1 + (h.stamps.old === 0 ? 1 : 0)
  const newStyle = s.at(-2) === '*'
  const resume = scanner.pos
  restartAt(scanner, start, sline)
  scanner.newStyle = newStyle
  const first = parseContextHunk(scanner)
  scanner.newStyle = newStyle
  scanner.pos = resume
  if (first && first.newLines.length === 0 && first.newStart === 1) says[1] = 1 + (h.stamps.new === 0 ? 1 : 0)
  return { ...h, says, type: 'context', start, sline }
}

export function nextHunk(scanner, type) {
  if (type === 'unified') return parseUnifiedHunk(scanner)
  if (type === 'context') return parseContextHunk(scanner)
  return parseNormalHunk(scanner)
}

// util.c fetchname: the name runs to the first blank, unless a tab follows
// later on the line, in which case blanks are part of the name and the tab
// starts the timestamp. What follows the name is kept verbatim, so a reject
// header can repeat it.
function fetchName(text, strip, withStamp) {
  const at = text.replace(/^[ \t\n\v\f\r]+/u, '')
  let name, rest
  if (at.startsWith('"')) {
    const parsed = parseCString(at)
    if (!parsed) return {}
    name = parsed.value
    rest = parsed.rest
  } else {
    let t = 0
    for (; t < at.length; t++) {
      if (!/[ \t\n\v\f\r]/u.test(at[t])) continue
      let u = t
      while (at[u] !== '\t' && /[ \t\n\v\f\r]/u.test(at[u + 1] ?? '')) u++
      if (at[u] !== '\t' && at.indexOf(withStamp ? '\t' : '\n', u + 1) !== -1) continue
      break
    }
    name = at.slice(0, t)
    rest = at.slice(t)
  }
  if (name === '/dev/null') return { stamp: 0 }
  const stripped = stripLeading(name, strip)
  if (stripped === null) return {}
  const timestr = rest.replace(/\r?\n$/u, '')
  return { name: stripped, timestr, stamp: withStamp && timestr !== '' ? stampOf(timestr) : -1 }
}

// The epoch, give or take a day of zone offset, says the file did not exist.
function stampOf(timestr) {
  const iso = /^\s*(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)(?:\.\d+)?\s*(?:([+-])(\d\d):?(\d\d))?/u.exec(timestr)
  let seconds
  if (iso) {
    const [, y, mo, d, hh, mm, ss, sign, oh, om] = iso
    seconds = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss)) / 1000
    if (sign) seconds -= (sign === '-' ? -1 : 1) * (Number(oh) * 3600 + Number(om) * 60)
  } else {
    const ctime = /^\s*[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d+) (\d\d):(\d\d):(\d\d) (\d{4})/u.exec(timestr)
    if (!ctime) return -1
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const [, mon, d, hh, mm, ss, y] = ctime
    seconds = Date.UTC(Number(y), months.indexOf(mon), Number(d), Number(hh), Number(mm), Number(ss)) / 1000
  }
  return seconds > -25 * 3600 && seconds < 26 * 3600 ? 0 : seconds
}

// util.c strip_leading_slashes: -p N drops N slashes' worth of leading
// components (a run of slashes counting once); with no -p, all of them.
// A name with too few components to strip is no name at all.
function stripLeading(name, strip) {
  let remaining = strip
  let start = 0
  for (let p = 0; p < name.length; p++) {
    if (name[p] !== '/') continue
    while (name[p + 1] === '/') p++
    if (strip < 0 || --remaining >= 0) start = p + 1
  }
  if ((strip < 0 || remaining <= 0) && start < name.length) return name.slice(start)
  return null
}

// A name on a `diff --git` line: a C string, or up to the next blank.
function parseName(s, strip) {
  const at = s.replace(/^[ \t\n\v\f\r]+/u, '')
  let raw, rest
  if (at.startsWith('"')) {
    const parsed = parseCString(at)
    if (!parsed) return { name: null, rest: '' }
    raw = parsed.value
    rest = parsed.rest
  } else {
    const end = at.search(/[ \t\n\v\f\r]/u)
    raw = end < 0 ? at : at.slice(0, end)
    rest = end < 0 ? '' : at.slice(end)
  }
  return { name: stripLeading(raw, strip), rest }
}

const ESCAPES = { a: '', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"' }

function parseCString(s) {
  let value = ''
  for (let i = 1; i < s.length; i++) {
    const c = s[i]
    if (c === '"') return { value, rest: s.slice(i + 1) }
    if (c !== '\\') { value += c; continue }
    const e = s[++i]
    if (e === undefined) return null
    if (/[0-7]/u.test(e)) {
      const octal = /^[0-7]{1,3}/u.exec(s.slice(i))[0]
      value += String.fromCodePoint(Number.parseInt(octal, 8))
      i += octal.length - 1
    } else if (e in ESCAPES) value += ESCAPES[e]
    else return null
  }
  return null
}
