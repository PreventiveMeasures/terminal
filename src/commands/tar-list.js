// How GNU tar 1.35 prints an entry: its name as stored, which is the one the
// package hands out where the archive is read at all (see stored-names.js),
// and with -v the long line
// `-tv` shows. Names are quoted in tar's own style, `escape`: printed as they
// are where the locale can print them, a backslash doubled, and everything
// else — a control character, a character the locale cannot print — as C
// escapes, a byte at a time.
//
// The long line is GNU's print_header: mode, owner/group, size, the time to
// the minute, the name, and where the entry is a link, what it links to.
// Owner, group and size share one field whose width only ever grows over a
// run, as the time's does, so the lines of one listing line up the way
// GNU's do and a later, wider entry shifts only the lines after it.

import { UnsupportedError } from '../unsupported.js'
import { byteLocale, classTables, encodeUtf8 } from '../util.js'
import { formatDate } from './extra.js'
import { storedName } from './stored-names.js'

const C_ESCAPES = new Map([[7, 'a'], [8, 'b'], [12, 'f'], [10, 'n'], [13, 'r'], [9, 't'], [11, 'v']])
const octal = (byte) => '\\' + byte.toString(8).padStart(3, '0')

export function quoteEscape(text, ctx) {
  const bytes = byteLocale(ctx)
  const table = classTables(ctx.locale)
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0)
    if (char === '\\') out += '\\\\'
    else if (C_ESCAPES.has(code)) out += '\\' + C_ESCAPES.get(code)
    else if (code < 128 ? code >= 32 && code < 127 : !bytes && table.has('print', code)) out += char
    else for (const byte of encodeUtf8(char)) out += octal(byte)
  }
  return out
}

const TYPES = {
  __proto__: null,
  file: '-', 'contiguous-file': 'C', directory: 'd', symlink: 'l', link: 'h',
  fifo: 'p', 'character-device': 'c', 'block-device': 'b',
}

// pax_decode_mode: the nine permission letters, with set-id and sticky bits
// shown in the execute places, lower case where the execute bit is also set.
function modeString(type, mode) {
  const letters = [...'rwxrwxrwx'].map((letter, i) => ((mode & (0o400 >> i)) === 0 ? '-' : letter))
  const special = (bit, at, letter) => {
    if ((mode & bit) !== 0) letters[at] = letters[at] === 'x' ? letter : letter.toUpperCase()
  }
  special(0o4000, 2, 's')
  special(0o2000, 5, 's')
  special(0o1000, 8, 't')
  return TYPES[type] + letters.join('')
}

const byteLength = (text) => encodeUtf8(text).length
const DEVICES = new Set(['character-device', 'block-device'])

// One run's long lines: owners by name where the archive has names for
// them, as GNU gives them unless --numeric-owner asks for the numbers, and
// times in local time unless --utc or TZ says otherwise.
export function longLines(ctx, { numericOwner = false, utc = false } = {}) {
  let ugswidth = 19
  let datewidth = 16
  const zone = utc || ctx.vars.has('TZ')
  return (entry) => {
    const user = !numericOwner && entry.uname !== '' ? entry.uname : String(entry.uid)
    const group = !numericOwner && entry.gname !== '' ? entry.gname : String(entry.gid)
    const size = DEVICES.has(entry.type) ? `${entry.devmajor},${entry.devminor}` : String(entry.data.length)
    const pad = byteLength(user) + 1 + byteLength(group) + 1 + size.length
    if (pad > ugswidth) ugswidth = pad
    const stamp = timeStamp(entry.mtime, zone)
    if (stamp.length > datewidth) datewidth = stamp.length
    const head = `${modeString(entry.type, entry.mode)} ${user}/${group} ${' '.repeat(ugswidth - pad)}${size} ${stamp.padEnd(datewidth)} `
    return head + quoteEscape(storedName(entry), ctx) + linkSuffix(entry, ctx)
  }
}

function linkSuffix(entry, ctx) {
  if (entry.type === 'symlink') return ` -> ${quoteEscape(entry.linkname, ctx)}`
  if (entry.type === 'link') return ` link to ${quoteEscape(entry.linkname, ctx)}`
  return ''
}

// tartime, to the minute: local time unless told otherwise, the year as
// glibc spells it — no padding, a minus sign before the common era. A
// moment past what a Date holds is past what this can spell.
function timeStamp(seconds, utc) {
  const date = new Date(seconds * 1000)
  if (Number.isNaN(date.getTime())) throw new UnsupportedError('feature', 'archive time', `a modification time of ${seconds} seconds is past what this terminal can print`)
  return formatDate(date, '%Y-%m-%d %H:%M', utc)
}
