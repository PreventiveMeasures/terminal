// What ripgrep makes of a NUL. It reads a file it walked to, and standard
// input, through a buffer it fills a read at a time: three bytes first, which
// it holds back to look for a byte-order mark, and then as much as 64 KiB
// less what an unfinished line carries over from the fill before. A fill
// that ends no line reads on before it is searched. The lines each fill ends
// are searched as it comes — and the fill that brings the first NUL is not:
//
// - A walked file ends there. A line selected before it is printed, followed
//   by a warning that the search stopped; with none, the file is passed over
//   in silence. A count or a --files-without-match over it says nothing at
//   all, since the search had to read on to its end and could not — though
//   --files-without-match counts it answered for, and exits 0.
// - Standard input is read on to its end with every NUL taken for a line
//   end, but no line is printed from that fill on: the first one selected
//   there ends the search, and "binary file matches" closes the output of
//   any search that selected a line anywhere. A count counts every line.

import { decodeUtf8Maybe, encodeUtf8 } from '../util.js'

const READ = 64 * 1024
const PEEK = 3

// The bytes ripgrep searched before the fill that brought the first NUL,
// which is at `nul`: up to the end of the last line an earlier fill ended.
export function searchedBeforeNul(bytes, nul) {
  let consumed = 0
  let end = 0
  let capacity = READ
  for (;;) {
    const from = end
    do {
      if (end - consumed >= capacity) capacity *= 2
      end = Math.min(bytes.length, end === 0 ? PEEK : end + capacity - (end - consumed))
      if (nul < end) return consumed
    } while (bytes.lastIndexOf(0x0a, end - 1) < from)
    consumed = bytes.lastIndexOf(0x0a, end - 1) + 1
  }
}

const bytesOf = ({ text, bytes }) => bytes ?? (text?.includes('\0') ? encodeUtf8(text) : null)

// A line this long may not fit the buffer, which ripgrep then doubles — and
// keeps doubled for the files its thread searches after, where a NUL past the
// first 64 KiB is then read in an earlier fill than it would have been. A
// little under the 64 KiB itself, to stay clear of the edge.
const LONG_LINE = 65000

// Whether any line of the text a file is searched for, up to `end`, is that
// long; a string is measured in bytes only once its characters could be.
function holdsLongLine(file, end) {
  const lines = file.bytes ? [file.bytes.subarray(0, end)] : (file.text ?? '').split('\n')
  for (const line of lines) {
    if (line.length * 3 < LONG_LINE) continue
    const bytes = typeof line === 'string' ? encodeUtf8(line) : line
    let from = 0
    for (let at = bytes.indexOf(0x0a); ; at = bytes.indexOf(0x0a, from)) {
      if ((at < 0 ? bytes.length : at) - from >= LONG_LINE) return true
      if (at < 0) break
      from = at + 1
    }
  }
  return false
}

// What each walked file holding a NUL leaves to search, keyed by path: the
// text ripgrep searched before it stopped, and where the NUL is. `{ gap }`
// where that is not known: the text is not text, or how much of it was read
// turns on which files ripgrep's threads searched first — which a count or a
// --files-without-match, `whole`, never shows, reading every such file to its
// NUL.
export function walkedBinaries(files, whole) {
  const cut = new Map()
  const long = []
  for (const file of files) {
    if (file.named) continue
    const bytes = bytesOf(file)
    const nul = bytes?.indexOf(0) ?? -1
    if (holdsLongLine(file, nul < 0 ? undefined : nul)) long.push(file.path)
    if (nul < 0) continue
    const text = decodeUtf8Maybe(bytes.subarray(0, searchedBeforeNul(bytes, nul)))
    if (text === undefined) return { gap: 'unreadable bytes' }
    cut.set(file.path, { text, nul })
  }
  const late = [...cut].filter(([, { nul }]) => nul >= LONG_LINE)
  if (!whole && late.some(([path]) => long.some((other) => other !== path))) return { gap: 'binary file search order' }
  return { cut }
}

// The filesystem a search reads those files through, each cut where ripgrep
// stopped; everything else is the filesystem itself.
export function cutFs(fs, cut) {
  return new Proxy(fs, {
    get(target, prop) {
      if (prop === 'readFile') return (path, ...rest) => cut.get(path)?.text ?? target.readFile(path, ...rest)
      if (prop === 'isBytes') return (path) => (cut.has(path) ? false : target.isBytes?.(path))
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

// grep's output put the way ripgrep's reads for the cut files, which `name`
// says what the search calls: after the last line a cut file printed, the
// warning that its search stopped; and under -c or --files-without-match,
// nothing of it at all.
export function cutOutput(stdout, cut, mode, name) {
  const lines = stdout.split('\n')
  for (const [path, { nul }] of cut) {
    const shown = name(path)
    if (mode === 'c' || mode === 'L') {
      const at = lines.findIndex((line) => (mode === 'c' ? line.startsWith(shown + ':') && /^\d+$/u.test(line.slice(shown.length + 1)) : line === shown))
      if (at >= 0) lines.splice(at, 1)
      continue
    }
    if (mode) continue
    const at = lines.findLastIndex((line) => line.startsWith(shown + ':'))
    if (at >= 0) lines.splice(at + 1, 0, `${shown}: WARNING: stopped searching binary file after match (found "\\0" byte around offset ${nul})`)
  }
  return lines.join('\n')
}

// Standard input holding a NUL, as ripgrep reads it: `before`, the text it
// searched and printed from before the fill that brought the NUL; `all`, the
// whole of it with every NUL a line end; and the line that closes the output.
export function binaryStdin(bytes, showName) {
  const nul = bytes.indexOf(0)
  const all = decodeUtf8Maybe(bytes)
  if (nul < 0 || all === undefined) return null
  return {
    before: decodeUtf8Maybe(bytes.subarray(0, searchedBeforeNul(bytes, nul))),
    all: all.replaceAll('\0', '\n'),
    closing: `${showName ? '<stdin>: ' : ''}binary file matches (found "\\0" byte around offset ${nul})\n`,
  }
}
