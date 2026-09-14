import { decodeUtf8, encodeUtf8Loose } from '../util.js'
import { formatContext, formatNormal, formatUnified } from '../diff/format.js'
import { functionLine } from '../diff/hunks.js'
import { quoteHeaderName } from '../diff/quote.js'

// The virtual filesystem keeps no modification times, so a header carries
// the name alone, as it does under --label. A file -N stands in for gets
// the epoch, which is what tells patch the file did not exist.
const EPOCH = ['\t1970-01-01 00:00:00.000000000 +0000', '\tThu Jan  1 00:00:00 1970']

// The `diff -r …` line names the pair the way the command line would, and
// the header labels are --label if given, else the quoted names.
export function renderDiff(state, a, b, blocks, names, missing, inDirectory) {
  const { ctx, opts } = state
  const headerName = (i) => opts.labels[i] ?? quoteHeaderName(names[i], ctx) + (missing[i] ? EPOCH[opts.style === 'context' ? 1 : 0] : '')
  const shown = (i) => opts.labels[i] ?? quoteHeaderName(names[i], ctx)
  const lead = inDirectory ? `diff${opts.switches} ${shown(0)} ${shown(1)}\n` : ''
  return lead + formatBlocks(state, a, b, blocks, headerName)
}

function formatBlocks(state, a, b, blocks, headerName) {
  const { opts } = state
  if (opts.style === 'normal' || opts.style === null) return formatNormal(a, b, blocks)
  const fn = opts.showFunction ? (index) => functionLine(a, index, encodeUtf8Loose, decodeLoose) : null
  if (opts.style === 'unified') return formatUnified(a, b, blocks, { context: opts.context, header: `--- ${headerName(0)}\n+++ ${headerName(1)}\n`, fn })
  return formatContext(a, b, blocks, { context: opts.context, header: `*** ${headerName(0)}\n--- ${headerName(1)}\n`, fn })
}

// A 40-byte cut can land inside a character; what remains is shown as is.
function decodeLoose(bytes) {
  for (let end = bytes.length; end > Math.max(0, bytes.length - 4); end--) {
    try { return decodeUtf8(bytes.subarray(0, end)) } catch { /* cut one byte shorter */ }
  }
  return ''
}

