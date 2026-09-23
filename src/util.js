// Shared command I/O and numeric parsing; independent of the command registry.

import { decodeUtf8Maybe, encodeUtf8, encodeUtf8Loose } from './bytes.js'
import { lookup, textOfFile } from './fs.js'
import { UINT64_MAX } from './numeric.js'
import { err } from './result.js'
import { lookupWithNote } from './notes.js'

// Commands reach the byte codec and the result shape through here, where the
// rest of their shared helpers already live.
export { encodeUtf8, encodeUtf8Loose, decodeUtf8, decodeUtf8Loose, decodeUtf8Maybe, joinBytes, utf8CodePoints } from './bytes.js'
export { textOfFile } from './fs.js'
export { err, ok, usage } from './result.js'
export { discardedNotes, missingPathNote } from './notes.js'
export { byteLocale, classTables } from './locale.js'

// Empty input has no lines; a trailing newline terminates the preceding line.
export function splitLines(s, delimiter = '\n') {
  if (s === '') return []
  const lines = s.split(delimiter)
  if (lines.at(-1) === '') lines.pop()
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
export function consumeStdin(ctx, rest = '', asBytes = false, bytesLeft = null) {
  ctx.io?.read(ctx.stdinHandle?.identity)
  if (!asBytes && ctx.stdinBytes) textOfFile(ctx.stdinBytes, inputLabel(null, ctx))
  ctx.stdinLeft = rest
  // Taking stdin takes the bytes it held with it: what a reader stopped short
  // of it hands back, and the next command in the group reads that and no
  // more. A reader that took the lot leaves none, so there are none to read
  // twice — which is what a shared input is.
  ctx.stdinBytes = bytesLeft
}

// Keep operand order and partial read failures; head/tail need directory entries
// for banners even though they cannot read them. Repeated '-' shares one stream;
// /dev/stdin reopens a regular file independently but shares a pipe's offset.
//
// `read` says what an operand is read as, for the commands that do not work in
// text alone. `bytes` and `loose-bytes` hand back the bytes themselves — the
// first as the file exactly has them, the second as a command only measuring
// or slicing them reads a text file holding a lone surrogate — and the entry
// then carries `bytes` and no `content`, so a command wanting text cannot
// quietly read an empty string. `as-held` hands back the file as it is held —
// `content` for one held as text, `bytes` for one held as bytes — and
// `maybe-text` adds the text those bytes spell where they spell one, for the
// command that has something to say about a file whose bytes spell none.
// Nothing is converted either way, so a command that can work in either pays
// for neither.
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
    // A file held as bytes carries them, and a file held as text its text.
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
      consumeStdin(ctx, '', true)
    } else if (name !== '/dev/null') {
      const found = lookupWithNote(ctx, cmd, name)
      if (found.error) { entry.kind = 'missing'; error = found.error }
      else if (ctx.fs.isDir(found.path)) {
        entry.kind = 'dir'
        if (!options.noRead) error = 'Is a directory'
      } else ofFile(entry, found.path)
    }
    entries.push(entry)
    if (error) stderr += readFailure(cmd, name, error, entry.kind === 'dir')
    if (entry.kind !== 'file' && (options.stopOnError || (entry.kind === 'dir' && options.stopOnDir))) break
  }
  return { inputs: entries.filter((e) => e.kind === 'file'), entries, stderr, failed: stderr !== '' }
}

// GNU words a failed read per command, and several word a directory
// differently from a path they could not open at all. `%s` is the operand as
// typed and `%r` the reason the filesystem gave; a command not named here
// says `<command>: <operand>: <reason>`, which is what most of them say.
// Recorded from coreutils 9.4 and GNU sed 4.9.
const READ_FAILURES = {
  head: ["cannot open '%s' for reading: %r", "error reading '%s': Is a directory"],
  tail: ["cannot open '%s' for reading: %r", "error reading '%s': Is a directory"],
  sort: ['cannot read: %s: %r', 'read failed: %s: Is a directory'],
  sed: ["can't read %s: %r", 'read error on %s: Is a directory'],
  tac: ["failed to open '%s' for reading: %r", '%s: read error: Invalid argument'],
  base32: [null, 'read error: Is a directory'],
  base64: [null, 'read error: Is a directory'],
  uniq: [null, "error reading '%s': Is a directory"],
}

export function readFailure(cmd, name, why, directory = false) {
  const shape = READ_FAILURES[cmd]?.[directory ? 1 : 0]
  const text = shape ? shape.replace(/%[sr]/gu, (mark) => (mark === '%s' ? name : why)) : `${name}: ${why}`
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
// way. Text a file was declared with is its own, even where it has no
// encoding at all — a lone surrogate is still the text that file holds.
export function readTextOrBytes(fs, path) {
  if (fs.isBytes?.(path) !== true) return { text: fs.readFile(path), bytes: undefined }
  const bytes = fs.readBytes(path)
  return { text: decodeUtf8Maybe(bytes), bytes }
}

export function readInputs(cmd, files, stdin, ctx, options) {
  if (files.length === 0) {
    const piped = ctx.stdinBytes ?? null
    // The question this reader answers for itself, just below.
    consumeStdin(ctx, '', true)
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
// while '+5' means start at line five to tail. Preserve the operand in errors.
export function parseSignedCount(str, label) {
  if (typeof str !== 'string') return { error: err(`${label}: invalid count: ${str}`) }
  const sign = str[0] === '+' || str[0] === '-' ? str[0] : ''
  const part = sign === '-' ? str.slice(1) : str
  const m = /^[ \t\n\r\v\f]*\+?(\d+)(b|[kKMGTPEZYRQ](?:i?B)?)?$/u.exec(part)
  const bare = !sign && /^(?:b|[kKMGTPEZYRQ](?:i?B)?)$/u.test(part)
  if (!m && !bare) return { error: err(`${label}: invalid count: ${str}`) }
  const suffix = m?.[2] ?? (bare ? part : '')
  const count = scaledCount(BigInt(m?.[1] ?? '1'), suffix, label, str)
  return count.error ? count : { ...count, sign }
}

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
