// What a tar archive's headers say that @preventive/archive's entries do not,
// read back out of them: each entry's name and link target as stored (see
// ../stored-names.js), and the pax records GNU tar 1.35 reads.
//
// GNU reads the records of an entry's extended header as it comes to the
// entry, before it does anything with it, and warns of each keyword it does
// not know; a global header's it takes without a word. Of those it knows,
// the package takes what it takes and leaves the rest as GNU leaves them
// when not asked to restore attributes — but for access and change times,
// which GNU checks where the package does not, and the records of
// multi-volume and incremental archives, which change what GNU makes of an
// entry. An archive with a time GNU would complain of, or with one of those
// records, is refused. Where a record gives an entry's time to a fraction of
// a second, which the package floors away, the fraction is kept here.
//
// The package has read the whole archive before any of this runs, and
// refuses one whose structure is off, so the walk trusts the structure and
// reads each field from where the package reads it: a name from a long name
// header, else a pax `path`, else the header's own name, joined to its
// prefix under the ustar magic; a link's target the same way.

import { decodeUtf8, joinBytes } from '../../util.js'
import { refusalOf, rewritten } from '../stored-names.js'

const BLOCK = 512
const blocks = (size) => Math.ceil(size / BLOCK) * BLOCK
const LONGNAME = 0x4c
const LONGLINK = 0x4b
const PAX = 0x78
const GLOBAL = 0x67
const EXTENDED = new Set([LONGNAME, LONGLINK, PAX, GLOBAL])
const GNU_MAGIC = 'ustar  \0'
const SLASH = Uint8Array.of(0x2f)
const NONE = new Uint8Array()

// xheader.c's table, less the sparse keywords, which the package refuses;
// `SCHILY.xattr.` stands for every keyword it begins.
const KNOWN = new Set([
  'atime', 'charset', 'comment', 'ctime', 'gid', 'gname', 'linkpath', 'mtime', 'path', 'size', 'uid', 'uname',
  'RHT.security.selinux', 'SCHILY.acl.access', 'SCHILY.acl.default',
])
const known = (keyword) => KNOWN.has(keyword) || keyword.startsWith('SCHILY.xattr.')
const incremental = (keyword) => keyword === 'GNU.dumpdir' || keyword.startsWith('GNU.volume.')

const ascii = (bytes) => String.fromCodePoint(...bytes)
function untilNul(bytes) {
  const end = bytes.indexOf(0)
  return end === -1 ? bytes : bytes.subarray(0, end)
}

// A size field: octal digits, or GNU's base 256 behind a set top bit. Only
// an extended header's is read here, which the package holds to a MiB.
function sizeOf(block) {
  const field = block.subarray(124, 136)
  if (field[0] === 0x80) return field.subarray(1).reduce((size, byte) => size * 256 + byte, 0)
  const digits = ascii(untilNul(field)).trim()
  return digits === '' ? 0 : Number.parseInt(digits, 8)
}

// A pax header's records, `LENGTH KEYWORD=VALUE\n` each, the length counting
// the whole record: the keyword as text, the value as bytes.
function paxRecords(body) {
  const records = []
  for (let at = 0; at < body.length;) {
    const space = body.indexOf(0x20, at)
    const end = at + Number(ascii(body.subarray(at, space)))
    const equals = body.indexOf(0x3d, space)
    records.push([decodeUtf8(body.subarray(space + 1, equals)), body.subarray(equals + 1, end - 1)])
    at = end
  }
  return records
}

const TIME_MIN = -(2n ** 63n)
const TIME_MAX = 2n ** 63n - 1n
// decode_time: a minus or not, digits, and a fraction that may be empty; a
// time_t once a negative time with a fraction is taken a second down.
function timeGnuTakes(value) {
  const match = /^(-?[0-9]+)(?:\.([0-9]*))?$/u.exec(value)
  if (match === null) return false
  const seconds = BigInt(match[1]) - (match[1].startsWith('-') && /[1-9]/u.test(match[2] ?? '') ? 1n : 0n)
  return seconds >= TIME_MIN && seconds <= TIME_MAX
}

// Why a record cannot be read as GNU reads it, as a gap's detail and
// message, or null.
function refusedRecord(keyword, value, quote) {
  if (incremental(keyword)) return ['extended header', `${quote(keyword)}: records of multi-volume and incremental archives are not supported`]
  if ((keyword === 'atime' || keyword === 'ctime') && !timeGnuTakes(decodeUtf8(value))) {
    return ['extended header', `${quote(`${keyword}=${decodeUtf8(value)}`)}: extended header times GNU would reject are not supported`]
  }
  return null
}

// An extended header's records as GNU takes them: an entry's own into `own`,
// warning of a keyword GNU does not know; a global header's time into
// `global`. A gap's detail and message, or null.
function takeRecords(records, own, global, quote) {
  for (const [keyword, value] of records) {
    const refusal = refusedRecord(keyword, value, quote)
    if (refusal !== null) return refusal
    if (own === null) {
      if (keyword === 'mtime') global.mtime = decodeUtf8(value)
    } else if (keyword === 'path' || keyword === 'linkpath') own[keyword] = value
    else if (keyword === 'mtime') own.mtime = decodeUtf8(value)
    else if (!known(keyword)) own.said.push(`Ignoring unknown extended header keyword '${keyword}'`)
  }
  return null
}

// What the headers of `bytes` say of `entries`, the package's reading of it,
// one entry to each header that is not an extended one, in order: for each
// entry the warnings GNU gives as it comes to it, and its time to the
// fraction of a second where a record gives one — or a gap's detail and
// message, where a name or a record is one this terminal cannot answer for.
// `quote` spells a name in a message.
export function tarHeaders(bytes, entries, quote) {
  const warnings = []
  const mtimes = []
  // A global header stands until the next replaces it.
  const global = { mtime: null }
  let at = 0
  for (const entry of entries) {
    const own = { said: [], longname: null, longlink: null, path: null, linkpath: null, mtime: null }
    let block = bytes.subarray(at, at + BLOCK)
    for (let type = block[156]; EXTENDED.has(type); type = block[156]) {
      const size = sizeOf(block)
      const body = bytes.subarray(at + BLOCK, at + BLOCK + size)
      if (type === LONGNAME) own.longname = untilNul(body)
      else if (type === LONGLINK) own.longlink = untilNul(body)
      else {
        if (type === GLOBAL) global.mtime = null
        const refusal = takeRecords(paxRecords(body), type === GLOBAL ? null : own, global, quote)
        if (refusal !== null) return { gap: refusal }
      }
      at += BLOCK + blocks(size)
      block = bytes.subarray(at, at + BLOCK)
    }
    // Under the gnu magic the prefix's bytes are the old GNU header's.
    const prefix = ascii(block.subarray(257, 265)) === GNU_MAGIC ? NONE : untilNul(block.subarray(345, 500))
    const field = untilNul(block.subarray(0, 100))
    const name = own.longname ?? own.path ?? (prefix.length ? joinBytes([prefix, SLASH, field]) : field)
    const stored = rewritten(entry, name, own.longlink ?? own.linkpath ?? untilNul(block.subarray(157, 257)))
    if (stored !== null) {
      const [detail, message] = refusalOf(stored)
      return { gap: [detail, `${quote(stored)}: ${message}`] }
    }
    warnings.push(own.said)
    const exact = own.mtime ?? global.mtime
    mtimes.push(exact === null ? entry.mtime : Number(exact))
    at += BLOCK + blocks(entry.data.length)
  }
  return { warnings, mtimes }
}
