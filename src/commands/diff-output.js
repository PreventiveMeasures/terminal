import { diff as diffText } from '@preventive/diff'
import { decodeUtf8, encodeUtf8Loose, lineRecords } from '../util.js'
import { UnsupportedError } from '../unsupported.js'
import { formatDate } from './extra.js'
import { quoteHeaderName } from './quote-name.js'

// What `diff` prints, around what @preventive/diff produces: the library is
// given the two files and the options that decide the comparison, and hands
// back the diff itself. The two label lines a context format opens with are
// the caller's, and so is the `diff -r …` line above each pair, because both
// name files — which is this terminal's business, not the library's.

// A header names a file and dates it by its modification time, which here is
// the one time the model gives every entry: the moment the terminal was
// made, the time `ls -l` and `tar -c` give it too, kept to the millisecond
// and printed with the nanoseconds that leaves. Standard input is dated now,
// as POSIX has GNU do, and a file -N stands in for gets the epoch, which is
// what tells patch the file did not exist. `/dev/null` keeps a time of its
// own, the host's, which the model does not have: a header that would print
// it is refused, and `--label` is the way to name that side without one.
// The zone is the host's unless TZ is set, as for `date` and `ls -l`.
//
// The stamp is ISO but for a context diff in a locale whose times are C's
// (diff.c reads hard_locale (LC_TIME)): there it is ctime's, to the second.
function stamp(ctx, opts, ms) {
  const utc = ctx.vars.has('TZ')
  const date = new Date(ms)
  const timeLocale = ctx.vars.get('LC_ALL') || ctx.vars.get('LC_TIME') || ctx.locale
  if (opts.style === 'context' && (timeLocale === 'C' || timeLocale === 'POSIX')) return formatDate(date, '%a %b %e %T %Y', utc)
  const nanoseconds = String(((ms % 1000) + 1000) % 1000).padStart(3, '0') + '000000'
  return formatDate(date, `%Y-%m-%d %H:%M:%S.${nanoseconds} %z`, utc)
}

// The `diff -r …` line names the pair the way the command line would, and
// the header labels are --label if given, else the quoted names and their
// times (`times[i]` in milliseconds, null where the model has none). Empty
// when the two compare the same, as the library's own result is: a header
// with nothing under it is not a diff, and the caller reads the empty string
// as the answer that they match.
export function renderDiff(state, contents, names, times, inDirectory) {
  const { ctx, opts } = state
  const body = diffBody(opts, contents)
  if (body === '') return ''
  const headerName = (i) => {
    if (opts.labels[i] !== undefined) return opts.labels[i]
    if (times[i] === null) throw new UnsupportedError('feature', 'header time', `${names[i]}: a header dated by the modification time of ${names[i]} is not supported (--label names it without one)`)
    return quoteHeaderName(names[i], ctx) + '\t' + stamp(ctx, opts, times[i])
  }
  const shown = (i) => opts.labels[i] ?? quoteHeaderName(names[i], ctx)
  const lead = inDirectory ? `diff${opts.switches} ${shown(0)} ${shown(1)}\n` : ''
  if (opts.style === 'unified') return `${lead}--- ${headerName(0)}\n+++ ${headerName(1)}\n${body}`
  if (opts.style === 'context') return `${lead}*** ${headerName(0)}\n--- ${headerName(1)}\n${body}`
  return lead + body
}

function diffBody(opts, contents) {
  // -p names each hunk after the function it starts inside. That heuristic
  // is diff's, not the library's: the formatters take a callback and ask.
  const lines = opts.showFunction ? lineRecords(contents[0]) : null
  return diffText(contents[0], contents[1], {
    format: opts.style ?? 'normal', context: opts.context, label: lines ? (index) => functionLine(lines, index) : null,
    minimal: opts.minimal, ignoreCase: opts.ignoreCase, whitespace: opts.whitespace,
  })
}

// -p: the last line before the hunk that looks like the start of a
// function, as GNU's default `^[[:alpha:]$_]` sees it, cut to 40 bytes
// with trailing blanks dropped.
const FUNCTION_START = /^[A-Za-z$_]/u

function functionLine(lines, before) {
  for (let i = before - 1; i >= 0; i--) {
    if (!FUNCTION_START.test(lines[i])) continue
    const bytes = encodeUtf8Loose(lines[i].replace(/\n$/u, ''))
    let end = Math.min(40, bytes.length)
    while (end > 0 && isSpaceByte(bytes[end - 1])) end--
    return decodeLoose(bytes.subarray(0, end))
  }
  return null
}

const isSpaceByte = (byte) => byte === 32 || (byte >= 9 && byte <= 13)

// A 40-byte cut can land inside a character; what remains is shown as is.
function decodeLoose(bytes) {
  for (let end = bytes.length; end > Math.max(0, bytes.length - 4); end--) {
    try { return decodeUtf8(bytes.subarray(0, end)) } catch { /* cut one byte shorter */ }
  }
  return ''
}
