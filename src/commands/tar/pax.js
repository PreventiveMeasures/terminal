// The pax records GNU tar 1.35 reads, as @preventive/archive hands them out
// beside each entry: those of its own extended header and those of the
// global one it is under, apart, each in the order stored.
//
// GNU reads the records of an entry's own header as it comes to the entry,
// before it does anything with it, and warns of each keyword it does not
// know; a global header's it takes without a word. Of those it knows, the
// package takes what it takes and leaves the rest as GNU leaves them when
// not asked to restore attributes — but for access and change times, which
// GNU checks where the package does not, and the records of multi-volume
// and incremental archives, which change what GNU makes of an entry. An
// archive with a time GNU would complain of, or with one of those records,
// is refused, and so is one holding a name the package hands out otherwise
// than it is stored (see ../stored-names.js). Where a record gives an
// entry's time to a fraction of a second, which the package floors away,
// the fraction is kept here.

import { refusalOf, rewritten } from '../stored-names.js'

// xheader.c's table, less the sparse keywords, which the package refuses;
// `SCHILY.xattr.` stands for every keyword it begins.
const KNOWN = new Set([
  'atime', 'charset', 'comment', 'ctime', 'gid', 'gname', 'linkpath', 'mtime', 'path', 'size', 'uid', 'uname',
  'RHT.security.selinux', 'SCHILY.acl.access', 'SCHILY.acl.default',
])
const known = (keyword) => KNOWN.has(keyword) || keyword.startsWith('SCHILY.xattr.')
const incremental = (keyword) => keyword === 'GNU.dumpdir' || keyword.startsWith('GNU.volume.')

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

// The first record of `records` GNU cannot be answered for here, as a gap's
// detail and message, or null.
function refusedRecord(records, quote) {
  for (const [keyword, value] of records) {
    if (incremental(keyword)) return ['extended header', `${quote(keyword)}: records of multi-volume and incremental archives are not supported`]
    if ((keyword === 'atime' || keyword === 'ctime') && !timeGnuTakes(value)) {
      return ['extended header', `${quote(`${keyword}=${value}`)}: extended header times GNU would reject are not supported`]
    }
  }
  return null
}

// What the records and stored names of `entries` say that their fields do
// not: for each entry the warnings GNU gives as it comes to it, and its time
// to the fraction of a second where a record gives one — or a gap's detail
// and message, for the first thing in the archive this terminal cannot
// answer for. `quote` spells a name in a message.
export function tarNotes(entries, quote) {
  const warnings = []
  const mtimes = []
  let global = null
  for (const entry of entries) {
    // A global header's records are one Map for every entry under it.
    const refusal = (entry.globalPax === global ? null : refusedRecord(entry.globalPax, quote)) ?? refusedRecord(entry.pax, quote)
    if (refusal !== null) return { gap: refusal }
    global = entry.globalPax
    const stored = rewritten(entry)
    if (stored !== null) {
      const [detail, message] = refusalOf(stored)
      return { gap: [detail, `${quote(stored)}: ${message}`] }
    }
    warnings.push([...entry.pax.keys()].filter((keyword) => !known(keyword)).map((keyword) => `Ignoring unknown extended header keyword '${keyword}'`))
    const exact = entry.pax.get('mtime') ?? entry.globalPax.get('mtime')
    mtimes.push(exact === undefined ? entry.mtime : Number(exact))
  }
  return { warnings, mtimes }
}
