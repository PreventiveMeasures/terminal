// Shared command I/O and numeric parsing; independent of the command registry.

import { decodeUtf8Maybe, encodeUtf8, encodeUtf8Loose } from './bytes.js'
import { lookup, textOfFile } from './fs.js'
import { UINT64_MAX } from './numeric.js'
import { err } from './result.js'
import { UnsupportedError } from './unsupported.js'
import { lookupWithNote } from './notes.js'
import { quoteFile, quoteLocale, quoteName } from './commands/quote-name.js'

// Commands reach the byte codec and the result shape through here, where the
// rest of their shared helpers already live.
export { MARKER, MARKER_RANGE, encodeUtf8, encodeUtf8Loose, encodeUtf8Marked, decodeUtf8, decodeUtf8Loose, decodeUtf8Marked, decodeUtf8Maybe, isMarker, joinBytes, utf8CodePoints } from './bytes.js'
export { resolve, textOfFile } from './fs.js'
export { err, ok, usage } from './result.js'
export { discardedNotes, missingPathNote } from './notes.js'
export { byteLocale, classTables } from './locale.js'
export { OptionError, optionFailure } from './args.js'
export { quoteFile, quoteLocale, quoteName } from './commands/quote-name.js'

// Empty input has no lines; a trailing newline terminates the preceding line.
export function splitLines(s, delimiter = '\n') {
  if (s === '') return []
  const lines = s.split(delimiter)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

// The lines a newline ends, in text or bytes. A newline is one byte and no
// part of another, and one character and no part of another, so counting them
// is counting lines whatever the input holds.
export function countNewlines(input) {
  let lines = 0
  const newline = typeof input === 'string' ? '\n' : 0x0a
  for (let at = input.indexOf(newline); at >= 0; at = input.indexOf(newline, at + 1)) lines++
  return lines
}

// Line-oriented output terminates nonempty arrays with a newline.
export const joinLines = (lines, delimiter = '\n') => lines.length === 0 ? '' : lines.join(delimiter) + delimiter

// Preserve each line's terminator for byte-exact filters and stdin offsets.
export function lineRecords(text, delimiter = '\n') {
  const records = []
  for (let pos = 0; pos < text.length;) {
    const end = text.indexOf(delimiter, pos)
    const next = end < 0 ? text.length : end + delimiter.length
    records.push(text.slice(pos, next))
    pos = next
  }
  return records
}

// Whether a command's stdin is the terminal itself: nothing piped or
// redirected into it — a file, /dev/null, a here-document — and not the
// /dev/null xargs gives what it runs. Nothing can be typed into this
// terminal, so its stdin holds nothing to read, and a tool that will not read
// from a terminal does not read from this one.
export const stdinIsTerminal = (ctx) => ctx.stdinTerminal === true

// Whether a command's stdout is the terminal itself: not a pipe, a file,
// /dev/null or what a command substitution captures. The terminal shows text,
// and a tool that will not write to a terminal does not write to this one.
export const stdoutIsTerminal = (ctx) => (ctx.outputFds?.[1] === 'out' || ctx.outputFds?.[1] === 'err') && !ctx.substitutionDepth

// Readers record unconsumed stdin so later commands in a group share its offset.
// Taking stdin is taking what it holds. Where a pipe carried bytes that spell
// no text, a command reading it as text is told which input it is, the way it
// is told which file a file of such bytes is; a command working in bytes says
// so here and reads them.
//
// A reader that stops part way hands back what it left after the place it
// stopped, and says whether that is where the next reader really starts —
// `exact`. On a regular file it is, unless the reader says otherwise: GNU's
// tools put the file's offset back where they stopped (head, sed, grep -m,
// hexdump) as they exit. On a pipe it is not, unless the reader says so: a
// tool reads a pipe a buffer at a time, takes whatever the writer had written
// by then, and cannot give back what it took past its stop. How much that is
// depends on how the writer's writes fell between the reader's reads — a race,
// not an answer — so `seq 1 3000 | { head -n 1; cat; }` hands cat 1142 lines
// on one run and could hand it none on another. Some readers take exactly what
// they need even from a pipe (head -c, od -N), and some read ahead even from a
// file and never move its offset back (awk, xxd), and those say so. A reader
// that took everything left nothing to argue about, whatever it is.
//
// What a reader left uncertain is marked on the input (`stdinStop`, which
// travels with what is left of it, ../shell/run.js), naming that reader and
// the call of it that stopped: a reader handing back what it left one record
// at a time (sed) is the same reader each time, and reads on from where it
// knows it is. Any other reader taking from that input would take what the
// first one did not happen to read, which is no answer this terminal can give,
// so it is refused as it starts — and an input nobody reads again is no
// trouble at all.
export function consumeStdin(ctx, rest = '', asBytes = false, bytesLeft = null, exact = ctx.stdinFile) {
  const stop = ctx.stdinStop
  if (stop && stop.invocation !== ctx.invocation) throw readAhead(stop)
  ctx.io?.read(ctx.stdinHandle?.identity)
  if (!asBytes && ctx.stdinBytes) textOfFile(ctx.stdinBytes, inputLabel(null, ctx))
  ctx.stdinLeft = rest
  // Taking stdin takes the bytes it held with it: what a reader stopped short
  // of it hands back, and the next command in the group reads that and no
  // more. A reader that took the lot leaves none, so there are none to read
  // twice — which is what a shared input is.
  ctx.stdinBytes = bytesLeft
  const left = rest !== '' || bytesLeft?.length > 0
  ctx.stdinStop = left && !exact ? { reader: ctx.invocation?.name ?? 'a command', invocation: ctx.invocation } : null
}

// A reader opening its stdin again after it stopped part way through it —
// `head -n 1 - -`, `awk '{ nextfile }' - -` — reads on from where it really
// stopped, which it knows no better than the next command would.
export function reopenStdin(ctx) {
  if (ctx.stdinStop) throw readAhead(ctx.stdinStop)
}

const readAhead = ({ reader, why = `${reader} reads ahead of where it stops, and how far is not known` }) =>
  new UnsupportedError('feature', 'input after an early stop', `reading standard input after ${reader} stopped part way through it is not supported: ${why}`)

// Keep operand order and partial read failures; head/tail need directory entries
// for banners even though they cannot read them. Repeated '-' shares one stream;
// /dev/stdin reopens a regular file independently but shares a pipe's offset.
//
// `read` says what an operand is read as, for the commands that do not work in
// text alone. `bytes` and `loose-bytes` hand back the bytes themselves — the
// first as the input exactly has them, the second as a command only measuring
// or slicing them reads text holding a lone surrogate, which a pipe can carry
// and a file cannot — and the entry then carries `bytes` and no `content`, so
// a command wanting text cannot quietly read an empty string. `as-held` hands
// back the input as it is held — `content` for text a pipe carried, `bytes`
// for a file, every one of which is bytes — and `maybe-text` adds the text
// those bytes spell where they spell one, for the command that has something
// to say about a file whose bytes spell none.
// Nothing is converted either way, so a command that can work in either pays
// for neither.
//
// `noRead` is a command that opens its operands and reads none of them —
// `head -n 0`, `xxd -l 0`: a directory is no error to it, and its stdin is
// left where it was, which is not the same as taken and handed back whole
// (consumeStdin): what an earlier reader left uncertain is no trouble to a
// command that does not read it, and stays uncertain for the next one that
// does.
export function readFilesFor(cmd, files, ctx, stdin = '', options = {}) {
  const entries = []
  let stderr = ''
  let pipe = stdin
  const read = options.read ?? 'text'
  const bytes = read === 'bytes' || read === 'loose-bytes'
  const field = bytes ? 'bytes' : 'content'
  // Stdin arrives as text, so it raises the same encoding question a file's
  // text does: strict where the bytes are kept, loose where they are measured.
  const asRead = (text) => bytes ? (read === 'loose-bytes' ? encodeUtf8Loose(text) : encodeUtf8(text)) : text
  const ofFile = (entry, path) => {
    if (bytes) { entry.bytes = readBytesOf(ctx.fs, path, read === 'loose-bytes'); return }
    // A file carries its bytes, and one a filesystem holds as text its text.
    // Whether those bytes also spell text is a question `maybe-text` asks and
    // `as-held` leaves alone: a command counting or encoding them has no use
    // for the answer, and reading it out of a large file is not free.
    if (read === 'text' || ctx.fs.isBytes?.(path) !== true) { entry.content = ctx.fs.readFile(path); return }
    entry.bytes = ctx.fs.readBytes(path)
    // The empty string the entry started as is not the text of a file held as
    // bytes: `maybe-text` puts the text they spell there, and leaves it unset
    // where they spell none, which `as-held` leaves unset either way.
    entry.content = read === 'maybe-text' ? decodeUtf8Maybe(entry.bytes) : undefined
  }
  for (const name of files) {
    const entry = { name, [field]: asRead(''), kind: 'file' }
    let error
    if (name === '/dev/stdin' && ctx.stdinFile) { ctx.io?.read(ctx.stdinHandle?.identity); entry[field] = asRead(ctx.stdinOrigin) }
    else if (name === '-' || name === '/dev/stdin') {
      // What the pipe carried is what `-` names, bytes and all.
      const piped = pipe === stdin ? ctx.stdinBytes ?? null : null
      Object.assign(entry, piped === null ? textInput(pipe, read, bytes) : bytesInput(piped, read, bytes, cmd, ctx))
      entry.shared = true
      pipe = ''
      if (!options.noRead) consumeStdin(ctx, '', true)
    } else if (name !== '/dev/null') {
      const found = lookupWithNote(ctx, cmd, name)
      if (found.error) { entry.kind = 'missing'; error = found.error }
      else if (ctx.fs.isDir(found.path)) {
        entry.kind = 'dir'
        if (!options.noRead) error = 'Is a directory'
      } else ofFile(entry, found.path)
    }
    entries.push(entry)
    // Each failure keeps its own words too, for a command that writes them
    // where that operand came rather than all together.
    if (error) stderr += entry.failure = readFailure(cmd, name, error, entry.kind === 'dir', ctx)
    if (entry.kind !== 'file' && (options.stopOnError || (entry.kind === 'dir' && options.stopOnDir))) break
  }
  return { inputs: entries.filter((e) => e.kind === 'file'), entries, stderr, failed: stderr !== '' }
}

// GNU words a failed read per command, and several word a directory
// differently from a path they could not open at all. `%r` is the reason the
// filesystem gave, and the operand is `%s` as typed — grep, sed and the tools
// outside coreutils name it bare — `%q` as quoteaf quotes it, always, and
// `%f` as quotef does, only where it needs it, which is how most of coreutils
// names a file. A command not named here says `<command>: <operand>: <reason>`
// with the operand as typed; a third shape is what one says of an operand
// with nothing in it. Recorded from coreutils 9.4, GNU sed 4.9, util-linux's
// hexdump, xxd and perl's shasum.
const QUOTEF = ['%f: %r', '%f: Is a directory']
const READ_FAILURES = {
  __proto__: null,
  head: ['cannot open %q for reading: %r', 'error reading %q: Is a directory'],
  tail: ['cannot open %q for reading: %r', 'error reading %q: Is a directory'],
  sort: ['cannot read: %f: %r', 'read failed: %f: Is a directory'],
  sed: ["can't read %s: %r", 'read error on %s: Is a directory'],
  tac: ['failed to open %q for reading: %r', '%f: read error: Invalid argument'],
  base32: ['%f: %r', 'read error: Is a directory'],
  base64: ['%f: %r', 'read error: Is a directory'],
  uniq: ['%f: %r', 'error reading %q: Is a directory'],
  wc: [...QUOTEF, 'invalid zero-length file name'],
  xxd: [null, 'Is a directory'],
  cat: QUOTEF, nl: QUOTEF, cut: QUOTEF, od: QUOTEF,
  sha1sum: QUOTEF, sha256sum: QUOTEF, sha384sum: QUOTEF, sha512sum: QUOTEF,
}

export function readFailure(cmd, name, why, directory = false, ctx) {
  const shapes = READ_FAILURES[cmd]
  const shape = (name === '' && shapes?.[2]) || shapes?.[directory ? 1 : 0]
  const marks = { '%s': () => name, '%q': () => quoteName(name, ctx), '%f': () => quoteFile(name, ctx), '%r': () => why }
  const text = shape ? shape.replace(/%[sqfr]/gu, (mark) => marks[mark]()) : `${name}: ${why}`
  return `${cmd}: ${text}\n`
}

// A filesystem of a caller's own need not answer for bytes; the text it holds
// is what it has, and what that text encodes to is the file. Nothing is what
// a path that is no file has either way.
export function readBytesOf(fs, path, loose = false) {
  const bytes = fs.readBytes?.(path, loose)
  if (bytes !== undefined) return bytes
  const text = fs.readFile(path)
  if (text !== undefined) return loose ? encodeUtf8Loose(text) : encodeUtf8(text)
}

// What a command reads when it answers for a file whose bytes spell no text
// rather than refusing it: the text where there is one, and the bytes either
// way.
export function readTextOrBytes(fs, path) {
  if (fs.isBytes?.(path) !== true) return { text: fs.readFile(path), bytes: undefined }
  const bytes = fs.readBytes(path)
  return { text: decodeUtf8Maybe(bytes), bytes }
}

export function readInputs(cmd, files, stdin, ctx, options) {
  if (files.length === 0) {
    const piped = ctx.stdinBytes ?? null
    // The question this reader answers for itself, just below.
    if (!options?.noRead) consumeStdin(ctx, '', true)
    // Stdin is text unless a stage upstream wrote bytes into the pipe, and
    // then it is those bytes: read as they are where a reader works in them,
    // as the text they spell where one does not, and refused where they spell
    // none — the same answer a file of such bytes gives.
    const read = options?.read
    const asBytes = read === 'bytes' || read === 'loose-bytes'
    const only = [{ name: null, kind: 'file', ...piped === null ? textInput(stdin, read, asBytes) : bytesInput(piped, read, asBytes, cmd, ctx) }]
    return { inputs: only, entries: only, stderr: '', failed: false }
  }
  return readFilesFor(cmd, files, ctx, stdin, options)
}

// Stdin is text, so only a reader working in bytes pays for encoding it.
const textInput = (stdin, read, asBytes) =>
  (asBytes ? { bytes: read === 'loose-bytes' ? encodeUtf8Loose(stdin) : encodeUtf8(stdin) } : { content: stdin })

function bytesInput(bytes, read, asBytes, cmd, ctx) {
  if (asBytes || read === 'as-held') return { bytes }
  if (read === 'maybe-text') return { bytes, content: decodeUtf8Maybe(bytes) }
  return { content: textOfFile(bytes, inputLabel(null, ctx)) }
}

export function inputLabel(name, ctx) {
  if (name === null || name === '-' || name === '/dev/stdin') return ctx.stdinHandle?.path ? JSON.stringify(ctx.stdinHandle.path) : 'standard input'
  return JSON.stringify(lookup(ctx.cwd, name, ctx.fs).path ?? name)
}

export function readContent(cmd, files, stdin, ctx) {
  const r = readInputs(cmd, files, stdin, ctx)
  return { content: r.inputs.map((f) => f.content).join(''), stderr: r.stderr, failed: r.failed }
}

export const okWith = (stdout, r) => ({ stdout, stderr: r.stderr, exitCode: r.failed ? 1 : 0 })

// GNU counts allow leading blanks and '+', whereas find requires digits.
// Saturate beyond representable input sizes unless the caller specifies a limit.
export function parseNonNegativeInt(str, label, shown = str, { max = Infinity, digitsOnly = false } = {}) {
  if (typeof str !== 'string' || !(digitsOnly ? /^\d+$/u : /^[ \t\n\r\f\v]*\+?\d+$/u).test(str)) {
    return { error: err(`${label}: invalid count: ${shown}`) }
  }
  const n = Number(str)
  if (n > max) return { error: err(`${label}: out of range: ${shown}`) }
  return { value: Math.min(n, Number.MAX_SAFE_INTEGER) }
}

// Retain the sign for head/tail: '-5' means omit the last five lines to head,
// while '+5' means start at line five to tail. The count is read as GNU's
// xstrtoumax reads it — blanks and a `+` before the digits, and a multiplier
// after them, `m` among them and `B`, `iB` or `D` after one, or the
// multiplier alone for one of it — once the `-` is off it, and a count it
// cannot read is named by what it counts, as quote() names it.
export function parseSignedCount(str, cmd, unit, ctx) {
  const sign = str[0] === '+' || str[0] === '-' ? str[0] : ''
  const part = sign === '-' ? str.slice(1) : str
  const invalid = (why = '') => ({ error: err(`${cmd}: invalid number of ${unit === 'c' ? 'bytes' : 'lines'}: ${quoteLocale(part, ctx)}${why}`) })
  const m = /^(?:[ \t\n\r\v\f]*\+?(\d+))?(?:(b|[kKmMGTPEZYRQ])(iB|B|D)?)?$/u.exec(part)
  if (m === null || (m[1] === undefined && m[2] === undefined)) return invalid()
  const [, digits = '1', letter, second] = m
  const suffix = letter === undefined || letter === 'b' ? letter ?? '' : letter + (second === 'iB' ? 'iB' : second ? 'B' : '')
  const count = scaledCount(BigInt(digits), suffix, cmd, str)
  return count.error ? invalid(': Value too large for defined data type') : { ...count, sign }
}

// coreutils' answer to a command line it can read but not act on: the
// diagnostic, then the line pointing at --help, and status 1.
export const usageError = (cmd, message, code = 1) => err(`${cmd}: ${message}\nTry '${cmd} --help' for more information.`, code)

// Shared GNU byte-count suffixes and unsigned 64-bit range checking.
export function scaledCount(digits, suffix, label, shown) {
  let factor = 1n
  if (suffix === 'b') factor = 512n
  else if (suffix) factor = (suffix.length === 2 ? 1000n : 1024n) ** BigInt('KMGTPEZYRQ'.indexOf(suffix[0].toUpperCase()) + 1)
  const n = digits * factor
  if (n > UINT64_MAX) return { error: err(`${label}: count out of range: ${shown}`) }
  // Saturation preserves slicing positions beyond any representable JS string.
  return { value: Number(n > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : n) }
}

// Custom handlers may throw primitives, null, or objects with throwing getters.
export function reason(e) {
  try {
    const message = e?.message
    return typeof message === 'string' && message !== '' ? message : String(e)
  } catch {
    return 'threw a value with no message'
  }
}
