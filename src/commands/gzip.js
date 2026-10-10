import { parseArgs } from '../args.js'
import { lookup } from '../fs.js'
import { consumeStdin, encodeUtf8, encodeUtf8Loose, readBytesOf, stdinIsTerminal, stdoutIsTerminal } from '../util.js'
import { missingPathNote } from '../notes.js'
import { unsupported, unsupportedFrom, unsupportedNote } from '../unsupported.js'
import { compress as compressBytes, supports } from '@preventive/archive/compression.js'
import { decompressMembers } from '../compression.js'

// gzip, both ways round. The work itself is the runtime's stream rather than
// this code's (../compression.js), and it answers asynchronously — so the
// command waits for it, which a line here can now do.
//
// What compressing writes is bytes, and this terminal carries a command's
// output as a string: no string spells a member, since the second byte of its
// header begins no character. So `-c` reports the gap every byte output here
// reports, and the file written beside the one it came from — which the
// overlay is the only place to write — is what compressing is for.

const FORMAT = 'gzip'

// One program under several names, which is what GNU ships: `gunzip` is it
// decompressing — `exec gzip -d` — and `zcat` is it decompressing to stdout,
// `exec gzip -cd`, which is why both say `gzip:` of what they cannot read.
// `gzcat` is the name the BSDs give what GNU calls `zcat`, theirs having kept
// `zcat` for the older `.Z`; it is the same thing, and it is that here. They
// are all here the same way — one command, reached by the name that says what
// it is for.
const gunzip = (stdin, tokens, ctx) => gzip(stdin, ['-d', ...tokens], ctx)
const zcat = (stdin, tokens, ctx) => gzip(stdin, ['-d', '-c', ...tokens], ctx)

// Only where the runtime's streams know the format: a terminal whose streams
// do not is a terminal without the command, which is what it was before this
// one was written.
export const GZIP = supports(FORMAT) ? { gzip, gunzip, zcat, gzcat: zcat } : {}

// A gzip member starts with these two, whatever follows.
const MAGIC = Object.freeze([0x1f, 0x8b])
export const looksCompressed = (bytes) => bytes !== undefined && bytes.length >= 2 && bytes[0] === MAGIC[0] && bytes[1] === MAGIC[1]

// What else GNU decompresses, known by its first bytes wherever a member
// could begin (get_method): gzip 0.5's members, pack's, compress's and SCO
// LZH's — and a zip, at the very start of the input alone. None of them is
// read here, and bytes that open one are refused rather than called garbage.
const FOREIGN = Object.freeze([[0x1f, 0x9e], [0x1f, 0x1e], [0x1f, 0x9d], [0x1f, 0xa0]])
const PKZIP = Object.freeze([0x50, 0x4b, 0x03, 0x04])
const opens = (bytes, magic) => bytes.length >= magic.length && magic.every((byte, i) => bytes[i] === byte)
const foreign = (bytes, start) => FOREIGN.some((magic) => opens(bytes, magic)) || (start && opens(bytes, PKZIP))
function refuseForeign(name, state) {
  state.gap ??= unsupported('feature', 'gzip', 'other formats', `gzip: ${name}: data compressed other than by gzip is not supported`, 1)
  return false
}

// What zlib calls what it would not read, and what gzip says of it. Anything
// else is data that is not the deflate stream the header promised.
const REPORTS = { __proto__: null, 'unexpected end of file': 'unexpected end of file', 'incorrect data check': 'invalid compressed data--crc error' }
const reportOf = (error) => REPORTS[error] ?? 'invalid compressed data--format violated'

// What followed the last whole member decides what gzip says of it. A tail of
// zero bytes is the padding a block device leaves rather than anything it was
// meant to read, and it passes over that without a word. Other bytes that
// begin no member are the garbage it ignores: it decompressed everything it
// was asked for, so it warns rather than errors and keeps what it wrote. A
// single byte begins nothing it can tell from a header, so it is the header
// it ran out of. Bytes that do begin a member are a member it could not read
// (../compression.js says what of it): what it refuses in the header it says
// as it comes to it and goes on to the next file, and data it cannot go on
// with — run out of, failing the check and the count that close it, or not
// deflate at all — it says once it has written what it inflated, and stops
// there: gzip exits on the spot, and the files after it are never read.
//
// What it says is also what `tar -z` passes on of it, so it is handed back as
// the text and the status, and whether what gzip wrote before it was every
// member whole — which is all `tar` then has to read. `kept` is whether a file
// it was writing stays, and `header` whether it was refused in the header.
export function gzipTrouble(name, inflated) {
  const { rest, trouble } = inflated
  const fatal = (...messages) => ({ text: messages.map((message) => `\ngzip: ${name}: ${message}\n`).join(''), status: 1, whole: false, kept: false, fatal: true })
  if (trouble?.header) return headerTrouble(name, trouble.header) ?? { ...fatal('unexpected end of file'), header: true }
  if (trouble?.eof) return fatal('unexpected end of file')
  if (trouble?.crc !== undefined) {
    return fatal(...trouble.crc ? ['invalid compressed data--crc error'] : [], ...trouble.length ? ['invalid compressed data--length error'] : [])
  }
  if (rest === null) return fatal(reportOf(inflated.error))
  if (rest.every((byte) => byte === 0)) return null
  if (rest.length >= 2 && !looksCompressed(rest)) return { text: `\ngzip: ${name}: decompression OK, trailing garbage ignored\n`, status: 2, whole: true, kept: true, fatal: false }
  if (rest.length < 2) return fatal('unexpected end of file')
  return fatal(reportOf(inflated.error))
}

// What GNU refuses in a header it says without the newline ahead of a data
// error, and leaves the file it would have written unwritten.
function headerTrouble(name, [kind, value, computed]) {
  const refused = (text) => ({ text: `gzip: ${text}\n`, status: 1, whole: true, kept: false, fatal: false, header: true })
  const hex = (n) => n.toString(16).padStart(4, '0')
  if (kind === 'method') return refused(`${name}: unknown method ${value} -- not supported`)
  if (kind === 'encrypted') return refused(`${name} is encrypted -- not supported`)
  if (kind === 'flags') return refused(`${name} has flags 0x${value.toString(16)} -- not supported`)
  if (kind === 'checksum') return refused(`${name}: header checksum 0x${hex(value)} != computed checksum 0x${hex(computed)}`)
  return null
}

function report(state, found) {
  say(state, found.text)
  state.status = state.status === 1 ? 1 : found.status
  if (found.fatal) state.stopped = true
}

// The suffixes GNU knows. Decompressing takes one off to name the file it
// writes, and refuses a name it cannot shorten; compressing reads the same
// table the other way, and leaves a file already named as a member alone.
// GNU reads a name's end in lower case, so `F.GZ` carries one, and only where
// something comes before it other than the slash a directory ends with: `.gz`
// and `d/.gz` are names with no suffix at all.
const SUFFIXES = Object.freeze(['.gz', '.z', '.taz', '.tgz', '-gz', '-z', '_z'])
const TAR = Object.freeze(['.tgz', '.taz'])
const SUFFIX = '.gz'
// What a name that is not there is tried with when decompressing, in turn.
const TRIED = Object.freeze(['.gz', '.z', '-z', '.Z'])
const LEVELS = Object.freeze(['1', '2', '3', '4', '5', '6', '7', '8', '9'])

export async function gzip(stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, {
    short: [...LEVELS, 'd', 'c', 'k', 'f'],
    long: ['decompress', 'uncompress', 'stdout', 'to-stdout', 'keep', 'force'],
  })
  // A stream compresses as hard as it compresses, and takes no instruction
  // about it: a level it would go on to ignore is not one to accept.
  const level = LEVELS.find((name) => flags.has(name))
  if (level !== undefined) return unsupported('option', 'gzip', `-${level}`, `gzip: -${level}: choosing a compression level is not supported`, 1)
  const opts = {
    decompressing: ['d', 'decompress', 'uncompress'].some((name) => flags.has(name)),
    stdout: ['c', 'stdout', 'to-stdout'].some((name) => flags.has(name)),
    keep: flags.has('k') || flags.has('keep'),
    // -f reads from a terminal and writes to one, follows a link, compresses
    // what is named as compressed already, replaces what stands in the way,
    // and, decompressing to stdout, hands on as it is what is not a member.
    force: flags.has('f') || flags.has('force'),
  }
  const state = { ctx, events: [], status: 0, gap: null, stopped: false }
  if (positional.length === 0) await fromStdin(opts, state)
  else {
    for (const name of positional) {
      // oxlint-disable-next-line no-await-in-loop -- one operand after the last, as gzip takes them.
      await one(name, opts, state)
      if (state.stopped) break
    }
  }
  if (state.gap) return state.gap
  // What it wrote, in the order it wrote it: the bytes go to a pipe or a file
  // as they are, and to a terminal as the text they spell, and what it said
  // goes between them where it said it.
  const stderr = state.events.filter((event) => event.fd === 2).map((event) => event.text).join('')
  return { stdout: '', stderr, exitCode: state.status, events: state.events }
}

// A pipe carries text unless a stage upstream wrote bytes into it, and a
// member is bytes: `cat f.gz | gzip -d` hands them over, where a pipe of text
// is read the way GNU reads one carrying anything else and always finds the
// same thing. Compressing reads that pipe as readily as decompressing does —
// a member is what `gzip | gzip` is handed, and no text spells one.
async function fromStdin(opts, state) {
  // GNU neither writes a member to a terminal nor reads one from it, unless
  // forced, and stops there; this terminal's stdin is one unless something
  // was piped or redirected into it, and nothing is ever typed there.
  if (!opts.force && (opts.decompressing ? stdinIsTerminal(state.ctx) : stdoutIsTerminal(state.ctx))) {
    const [way, what] = opts.decompressing ? ['read from', 'decompression'] : ['written to', 'compression']
    say(state, `gzip: compressed data not ${way} a terminal. Use -f to force ${what}.\nFor help, type: gzip -h\n`)
    state.status = 1
    state.stopped = true
    return
  }
  // Read from the context rather than from what the command was handed, so a
  // second `-` finds the stream where the first left it, which is its end.
  const stdin = state.ctx.stdinLeft
  const piped = state.ctx.stdinBytes
  // Taking the pipe is taking it: the next command in the list finds it
  // empty, as it would a stdin this one had read to the end.
  consumeStdin(state.ctx, '', true)
  // What a pipe hands over has no name to write a file beside, so it is
  // read out where GNU reads it: stdout.
  if (opts.decompressing) return decompress('stdin', piped ?? encodeUtf8(stdin), { ...opts, stdout: true }, state)
  // A member of stdin carries no name, there being none to take, and the
  // moment of the file stdin is where it is one — a pipe has none to give.
  const modified = state.ctx.stdinFile ? moment(state.ctx, state.ctx.stdinHandle?.path) : 0
  return toStdout(headed(await compressBytes(piped ?? encodeUtf8(stdin), FORMAT), null, modified), state)
}

function one(operand, opts, state) {
  const { ctx } = state
  // `-` is the stream, not a file of that name: GNU reads stdin for it and
  // writes to stdout, there being no file beside which to write the answer.
  if (operand === '-') return fromStdin(opts, state)
  const { name, found } = opened(operand, opts, ctx)
  if (found.error) return fail(state, `${name}: ${found.error}`, 1)
  if (ctx.fs.isDir(found.path)) return fail(state, `${name} is a directory -- ignored`, 2)
  return opts.decompressing ? decompressFile(name, found.path, opts, state) : compress(name, found.path, opts, state)
}

// The name GNU opens, and what opening it found. Decompressing, a name that is
// not there and carries no suffix is tried with each of a few on the end in
// turn, and the first that is there — or that fails other than by not being
// there — is the one it goes on with, under that name; where none is, it is
// the first of them that is said not to be there.
function opened(name, opts, ctx) {
  const found = openOne(name, opts, ctx)
  if (found.error !== 'No such file or directory' || !opts.decompressing || suffixOf(name) !== undefined) {
    missingPathNote(ctx, 'gzip', name, found.error)
    return { name, found }
  }
  for (const end of TRIED) {
    const tried = openOne(name + end, opts, ctx)
    if (tried.error !== 'No such file or directory') return { name: name + end, found: tried }
  }
  missingPathNote(ctx, 'gzip', name, found.error)
  return { name: name + TRIED[0], found }
}

// GNU opens the name itself, not what a link there names, unless it is
// writing to stdout or forced.
function openOne(name, opts, ctx) {
  if (!opts.stdout && !opts.force && isLink(name, ctx)) return { path: null, error: 'Too many levels of symbolic links' }
  return lookup(ctx.cwd, name, ctx.fs)
}

function isLink(name, ctx) {
  const found = lookup(ctx.cwd, name, ctx.fs, { follow: false })
  return found.path !== null && ctx.fs.isLink?.(found.path) === true
}

// The name it writes is the name it was given with a suffix on the end, and a
// name already carrying one is a file GNU says it is leaving alone — while
// making nothing of it: what it says there changes no status — unless forced.
async function compress(name, path, opts, state) {
  const { ctx } = state
  const suffix = suffixOf(name)
  if (!opts.stdout && !opts.force && suffix !== undefined) return note(state, `${name} already has ${name.slice(-suffix.length)} suffix -- unchanged`)
  const member = headed(await compressBytes(readBytesOf(ctx.fs, path), FORMAT), name.slice(name.lastIndexOf('/') + 1), moment(ctx, path))
  return opts.stdout ? toStdout(member, state) : toFile(name + SUFFIX, member, name, opts, state)
}

// The tree has no clock of its own, so the moment it was made stands in — the
// same one `ls -l` dates every file in it to — but for a file that keeps a
// time of its own.
const moment = (ctx, path) => ctx.fs.metadataOf?.(path ?? '')?.mtime ?? Math.floor(ctx.createdAt / 1000)

// GNU records where a member came from: the name the file had, without the
// directory it stood in, and the moment it carried — none and nought for a
// pipe — beside the level it was made at, the default here and so no mark at
// all, and the system that made it, Unix's 3. A stream writes the header of a
// member that came from no file, marked with whatever system the runtime was
// built for. Everything past the header is the member's own and says nothing
// about any of it, so the header is written over and the name goes in front
// of the rest. A header that is not the plain ten bytes is one this does not
// know how to add to, and it is left as the runtime wrote it.
const DEFAULT_LEVEL = 0, HEADER = 10, NAME_FLAG = 0x08, UNIX = 3
function headed(member, name, modified) {
  const label = encodeUtf8(name ?? '')
  if (member.length < HEADER || member[3] !== 0 || label.includes(0)) return member
  const room = name === null ? 0 : label.length + 1
  const out = new Uint8Array(member.length + room)
  out.set(member.subarray(0, HEADER))
  out[3] = name === null ? 0 : NAME_FLAG
  for (let i = 0; i < 4; i++) out[4 + i] = modified >>> (8 * i) & 0xff
  out[8] = DEFAULT_LEVEL
  out[9] = UNIX
  out.set(label, HEADER)
  // The name is closed by the zero the array already holds there.
  out.set(member.subarray(HEADER), HEADER + room)
  return out
}

function decompressFile(name, path, opts, state) {
  const { ctx } = state
  // GNU names what it will write before it reads a byte, and a name it
  // cannot take a suffix off is one it leaves alone.
  if (!opts.stdout && suffixOf(name) === undefined) return fail(state, `${name}: unknown suffix -- ignored`, 2)
  // A file is bytes, which say what it is: a member, another format, or
  // neither, which with -f to stdout is handed on.
  return decompress(name, readBytesOf(ctx.fs, path), opts, state, path)
}

async function decompress(name, bytes, opts, state, path = null) {
  const { ctx } = state
  // With -f, what goes to stdout and is not a member goes as it is.
  const handOn = opts.force && opts.stdout
  if (bytes !== undefined && foreign(bytes, true)) return refuseForeign(name, state)
  if (!looksCompressed(bytes)) {
    if (handOn) return toStdout(bytes, state)
    return dataError(state, `${name}: ${tooShort(bytes, path, ctx) ? 'unexpected end of file' : 'not in gzip format'}`)
  }

  const inflated = await decompressMembers(bytes)
  // What follows the last member is read the way the first bytes were, and
  // another format's is refused before anything is written.
  const rest = inflated.rest
  const tail = rest !== null && rest.length > 0 && !looksCompressed(rest) ? rest : null
  if (tail !== null && foreign(tail, false)) return refuseForeign(name, state)
  const found = inflated.error === null ? null : gzipTrouble(name, inflated)
  // GNU writes what it inflated before the trouble it then reports — to a
  // file too, which it removes again where the trouble is not one it lets
  // stand, leaving the file it read where it was. What it refuses in the
  // first header it refuses before it has made a file at all.
  if (found?.header && rest.length === bytes.length) return report(state, found)
  const kept = found === null || found.kept
  const written = opts.stdout ? toStdout(inflated.bytes, state) : toFile(unsuffixed(name), kept ? inflated.bytes : null, name, opts, state)
  if (!written) return
  if (tail !== null && handOn) return toStdout(tail, state)
  if (found !== null) report(state, found)
}

// GNU's `strlwr`, which lowers ASCII letters alone.
const lower = (text) => text.replace(/[A-Z]/gu, (letter) => letter.toLowerCase())
function suffixOf(name) {
  const end = lower(name)
  return SUFFIXES.find((suffix) => end.length > suffix.length && end.endsWith(suffix) && end[end.length - suffix.length - 1] !== '/')
}
function unsuffixed(name) {
  const suffix = suffixOf(name)
  return name.slice(0, -suffix.length) + (TAR.includes(suffix) ? '.tar' : '')
}

// GNU reads the two header bytes before anything else: input it runs out of
// before them is too short to tell, and one whose two say something else is
// not a member at all. A first byte of zero it reads the second after as it
// would trailing padding, which may be missing, so that is not a member
// either. A file of text is neither, and only its first character can make
// it too short to tell.
function tooShort(bytes, path, ctx) {
  const head = bytes ?? encodeUtf8Loose(ctx.fs.readFile(path).slice(0, 2))
  return head.length === 0 || head.length === 1 && head[0] !== 0
}

// What goes to stdout goes as the bytes it is: a pipe and a file take them,
// and a terminal carrying its output as a string takes the text they spell,
// or reports that they spell none.
const toStdout = (bytes, state) => { state.events.push({ fd: 1, bytes }); return true }

// Beside the file it came from, which the overlay is the only place to do.
// A name already taken is asked about where stdin is a terminal, whose
// answer here is the end of it; -f takes the name without asking.
function toFile(target, bytes, source, opts, state) {
  const { ctx } = state
  const taken = lookup(ctx.cwd, target, ctx.fs, { follow: false }).path
  if (taken !== null && !opts.force) return fail(state, `${target} already exists;${stdinIsTerminal(ctx) ? ' do you wish to overwrite (y or n)? ' : ''}\tnot overwritten`, 2)
  if (taken !== null && ctx.fs.isLink?.(taken) !== true && ctx.fs.isDir(taken)) return fail(state, `${target}: Is a directory`, 1)
  if (taken !== null) ctx.fs.removeWritable(ctx.cwd, target)
  let handle
  try { handle = ctx.writable && ctx.fs.openWritable?.(ctx.cwd, target) } catch (e) {
    // A refusal met on the way is the run's to report, not a file it failed.
    if (unsupportedNote(e)) {
      state.gap ??= unsupportedFrom(e, 'gzip', `gzip: ${e.message}`, 1)
      return false
    }
    return fail(state, `${target}: ${e.message}`, 1)
  }
  if (!handle) {
    state.gap ??= unsupported('feature', 'gzip', 'read-only target', `gzip: ${target}: file system is read-only`, 1)
    return false
  }
  // Data that failed GNU after it was written is removed again, and the file
  // it came from stays.
  if (bytes === null) {
    ctx.fs.removeWritable(ctx.cwd, target)
    return true
  }
  handle.writeBytes(bytes)
  // The file written takes the mode and the time of the one it came from,
  // where that keeps either of its own (copy_stat).
  const own = ctx.fs.metadataOf?.(lookup(ctx.cwd, source, ctx.fs).path ?? '')
  if (own) ctx.fs.keepMetadata(handle.path, { mode: own.mode === undefined ? undefined : own.mode & 0o777, mtime: own.mtime })
  // What was compressed, or decompressed, is gone once it has been, unless
  // `-k` keeps it.
  if (!opts.keep) ctx.fs.removeWritable(ctx.cwd, source)
  return true
}

// What GNU says of data that is not what the header promised, which it writes
// a newline ahead of — where a file it could not open, or passed over, is
// reported as it stands, and a file it is leaving alone is reported without
// being made anything of.
const dataError = (state, message) => fail(state, message, 1, '\n')
const note = (state, message) => fail(state, message, state.status)

function fail(state, message, status, lead = '') {
  say(state, `${lead}gzip: ${message}\n`)
  // An error is worth reporting over a warning, as GNU reports it.
  state.status = state.status === 1 ? 1 : status
  return false
}

// Said where it was said, between whatever was written before and after it.
const say = (state, text) => { state.events.push({ fd: 2, text }) }
