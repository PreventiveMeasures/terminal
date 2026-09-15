import { diff as diffText } from '@preventive/diff'
import { decodeUtf8, encodeUtf8Loose, lineRecords } from '../util.js'
import { quoteHeaderName } from './quote-name.js'

// What `diff` prints, around what @preventive/diff produces: the library is
// given the two files and the options that decide the comparison, and hands
// back the diff itself. The two label lines a context format opens with are
// the caller's, and so is the `diff -r …` line above each pair, because both
// name files — which is this terminal's business, not the library's.

// The virtual filesystem keeps no modification times, so a header carries
// the name alone, as it does under --label. A file -N stands in for gets
// the epoch, which is what tells patch the file did not exist.
const EPOCH = ['\t1970-01-01 00:00:00.000000000 +0000', '\tThu Jan  1 00:00:00 1970']

// The `diff -r …` line names the pair the way the command line would, and
// the header labels are --label if given, else the quoted names. Empty when
// the two compare the same, as the library's own result is: a header with
// nothing under it is not a diff, and the caller reads the empty string as
// the answer that they match.
export function renderDiff(state, contents, names, missing, inDirectory) {
  const { ctx, opts } = state
  const body = diffBody(opts, contents)
  if (body === '') return ''
  const headerName = (i) => opts.labels[i] ?? quoteHeaderName(names[i], ctx) + (missing[i] ? EPOCH[opts.style === 'context' ? 1 : 0] : '')
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
