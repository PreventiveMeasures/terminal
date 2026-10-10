// What a stage reads where a redirect puts something on its stdin: a file, a
// here-document's body, or a directory.
//
// `< dir` opens: a directory is as readable as a file to open(2), and it is
// the read that fails. So `echo hi < dir` prints `hi`, and a command that does
// read its stdin fails there, each in its own words. Such a stdin holds
// nothing and has no file behind it, and the I/O guard tells the shell whether
// the command read it, which is how the shell learns which of the two it was.

import { readBacktickSubstitution, readExpansion } from './lex.js'
import { lookupWithNote } from '../notes.js'
import { shellMessage, unsupported, unsupportedNote } from '../unsupported.js'
import { err, readTextOrBytes } from '../util.js'
import { eventsOf, sameDestination, textOf } from './output.js'
import { silentSearch } from '../commands/grep.js'
import { SEARCHES } from '../registry.js'

// Unquoted heredocs use double-quote expansion rules without quote removal.
// Only backslashes before $, backslash, or backtick escape a character.
export function heredocWord(body) {
  let value = ''
  let mask = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    const n = body[i + 1]
    if (c === '\\' && (n === '$' || n === '\\' || n === '`')) { value += n; mask += '1'; i++; continue }
    if (c === '`') {
      const backtick = readBacktickSubstitution(body, i)
      value += backtick.raw
      mask += '2' + '1'.repeat(backtick.raw.length - 1)
      i += backtick.raw.length - 1
      continue
    }
    if (c === '$') {
      const ref = readExpansion(body, i, 0, true)
      if (ref?.command !== undefined || ref?.parameter !== undefined || ref?.arithmetic !== undefined) {
        value += ref.raw
        mask += '2' + '1'.repeat(ref.raw.length - 1)
        i += ref.raw.length - 1
        continue
      }
    }
    value += c
    mask += '2'
  }
  return { value, mask }
}

// Resolve input before dispatch: failed reads prevent command execution.
export function readInput(path, ctx, stdin) {
  if (path === '/dev/null') return { content: '' }
  if (path === '/dev/stdin') return { content: stdin }
  const { path: abs, error } = lookupWithNote(ctx, 'shell', path)
  if (error) return { error: err(shellMessage(`${path}: ${error}`)) }
  if (ctx.fs.isFile(abs)) {
    // A file of bytes is those bytes on the way in, as it is on the way out:
    // reading it as text here would refuse `wc -c < img.png` for spelling no
    // text, where nothing was going to read it as text in the first place.
    // Bytes that spell text are that text, exactly as they are through a
    // pipe, so only a file no text spells travels as the bytes it is.
    const { text, bytes } = readTextOrBytes(ctx.fs, abs)
    const content = text ?? '', held = text === undefined ? bytes : undefined
    return { content, bytes: held, handle: ctx.writable && abs.startsWith('/tmp/') ? { path: abs, content, identity: ctx.fs.fileIdentity(abs) } : null }
  }
  return { content: '', directory: true }
}

// What GNU says when the only input a reader has is a directory on stdin, and
// the status it then exits with, recorded from coreutils 9.4, grep 3.11, sed
// 4.9 and xxd. What the reader prints for no input at all it prints here too:
// before the failed read where it is a header (`head -v`), after it where it
// is a count (`wc`, `grep -c`) or an offset (`od`) — `after` — and not at all
// where it would be a digest of nothing — `drop`.
const READERS = {
  cat: ['cat: -: Is a directory', 1],
  wc: ["wc: 'standard input': Is a directory", 1, 'after'],
  grep: ['grep: (standard input): Is a directory', 2, 'after'],
  egrep: ['grep: (standard input): Is a directory', 2, 'after'],
  fgrep: ['grep: (standard input): Is a directory', 2, 'after'],
  head: ["head: error reading 'standard input': Is a directory", 1],
  tail: ["tail: error reading 'standard input': Is a directory", 1],
  sort: ['sort: read failed: -: Is a directory', 2],
  uniq: ["uniq: error reading '-': Is a directory", 1],
  cut: ['cut: -: Is a directory', 1],
  nl: ['nl: -: Is a directory', 1],
  tr: ['tr: read error: Is a directory', 1],
  sed: ['sed: read error on stdin: Is a directory', 4],
  tac: ["tac: 'standard input': read error: Invalid argument", 1],
  base64: ['base64: read error: Is a directory', 1],
  base32: ['base32: read error: Is a directory', 1],
  tee: ['tee: read error: Is a directory', 1],
  od: ["od: 'standard input': Is a directory", 1, 'after'],
  xxd: ['xxd: Is a directory', 2],
  sha1sum: ['sha1sum: -: Is a directory', 1, 'drop'],
  sha256sum: ['sha256sum: -: Is a directory', 1, 'drop'],
  sha384sum: ['sha384sum: -: Is a directory', 1, 'drop'],
  sha512sum: ['sha512sum: -: Is a directory', 1, 'drop'],
  shasum: ['shasum: -: Is a directory', 1, 'drop'],
}

// Names that open the shell's stdin afresh, which GNU then names in its
// message instead of `-`; and the `find` actions that run commands on it.
const STDIN_NAMES = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0'])
const FIND_RUNS = new Set(['-exec', '-execdir', '-ok', '-okdir'])

// Run a command whose stdin is a directory. One that never reads it answers
// as it would anywhere. One that reads it as its only input fails as GNU's
// does — a `-` operand, or another input beside it, is where each of them
// words the failure differently again, and so is a reader of its own that
// already had something to say — and anything else is refused.
export async function readDirectoryInput(ctx, argv, invoke) {
  const name = ctx.registry.resolveCommand(argv[0])
  const operands = argv.slice(1)
  if (name === 'find' && operands.some((a) => FIND_RUNS.has(a))) return refuse(ctx, argv[0])
  const { result: r, read } = await ctx.io.watchStdin(invoke)
  if (!read) return r
  const reader = READERS[name]
  const silenced = SEARCHES.has(name) && silentSearch(operands)
  if (!reader || silenced || r.stderr !== '' || operands.some((a) => STDIN_NAMES.has(a))) return refuse(ctx, argv[0])
  const [message, exitCode, order] = reader
  // Output a file took is already there, which is the right place for it
  // unless it is a sum, or a count sharing that file with the message ahead
  // of it.
  const { 1: out, 2: diagnostics } = ctx.outputFds
  if (out?.path && (order === 'drop' || (order === 'after' && sameDestination(out, diagnostics)))) return refuse(ctx, argv[0])
  const failure = { fd: 2, text: `${message}\n` }
  const printed = order === 'drop' ? [] : eventsOf(r).filter((e) => e.fd === 1)
  return {
    stdout: printed.map(textOf).join(''), stderr: failure.text, exitCode,
    events: order === 'after' ? [failure, ...printed] : [...printed, failure],
  }
}

function refuse(ctx, name) {
  const gap = unsupported('feature', name, 'directory on standard input', `${name}: reading a directory on standard input is not supported`)
  ctx.unsupported.add(unsupportedNote(gap))
  return gap
}
