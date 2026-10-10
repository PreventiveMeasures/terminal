import { parseArgs } from '../args.js'
import { joinPath, lookup, nameTooLong, pathTooLong } from '../fs.js'
import { byteLocale, encodeUtf8, err, isMarker, reason } from '../util.js'
import { UnsupportedError, unsupportedFrom, unsupportedNote } from '../unsupported.js'
import { quoteName } from './quote-name.js'
import { missingPathNote } from '../notes.js'
import { inOverlay, writeRefusal } from '../writable.js'

// GNU's quote(), which names a file in mkdir's diagnostics and in all of
// find's: the locale's own quotation marks around it — ‘…’ where the charset
// is UTF-8, apostrophes where it is bytes — with C's backslash escapes for
// what would not print, and a backslash before a backslash or a closing mark
// in the name itself.
const LOCALE_ESCAPES = new Map([['\u0007', 'a'], ['\b', 'b'], ['\f', 'f'], ['\n', 'n'], ['\r', 'r'], ['\t', 't'], ['\v', 'v'], ['\\', '\\']])
const octal = (byte) => '\\' + byte.toString(8).padStart(3, '0')

export function quoteLocale(name, ctx) {
  const bytes = byteLocale(ctx)
  const [open, close] = bytes ? ["'", "'"] : ['‘', '’']
  let out = open
  for (const char of name) {
    const code = char.codePointAt(0)
    const named = LOCALE_ESCAPES.get(char)
    if (named !== undefined) out += '\\' + named
    else if (char === close) out += '\\' + char
    else if (code < 32 || code === 127) out += octal(code)
    else if (isMarker(code)) out += octal(code - 0xdc00)
    else if (code > 127 && bytes) for (const byte of encodeUtf8(char)) out += octal(byte)
    else if (code > 127 && /[\p{C}\p{Zl}\p{Zp}]/u.test(char)) {
      throw new UnsupportedError('feature', 'filename quoting', 'quoting nonprinting Unicode filenames is not supported')
    } else out += char
  }
  return out + close
}

// Directories in the writable overlay, which `cp -r` made the first of. There
// are no permissions here, so `-m` and the modes it takes are refused like any
// other option this terminal has nothing to answer with.
export function mkdir(_stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['p', 'v'], long: ['parents', 'verbose'] })
  if (positional.length === 0) return err("mkdir: missing operand\nTry 'mkdir --help' for more information.")
  const state = {
    ctx, events: [], stdout: '', stderr: '',
    parents: flags.has('p') || flags.has('parents'),
    verbose: flags.has('v') || flags.has('verbose'),
  }
  try {
    for (const name of positional) {
      if (state.parents) makeParents(name, state)
      else if (!fail(state, name, made(state, ctx.cwd, name))) announce(state, name)
    }
  } catch (e) {
    missingPathNote(ctx, 'mkdir', e?.path, e?.fsError)
    const result = unsupportedFrom(e, 'mkdir', 'mkdir: ' + reason(e))
    result.events = [...state.events, { fd: 2, text: result.stderr }]
    result.stdout = state.stdout
    result.stderr = state.stderr + result.stderr
    return result
  }
  return { stdout: state.stdout, stderr: state.stderr, events: state.events, exitCode: state.stderr ? 1 : 0 }
}

// `-p` as GNU's mkancesdirs makes it: each directory on the way is made and
// then entered, one component at a time from where the last one left off, so
// no call is handed more of the name than one component and a name of any
// length can be made. Making one that is there already is no failure;
// entering it is what has to work, and where it does not, the diagnostic
// names the operand only as far as that component, and says why making it
// failed where entering it found nothing there. The last component is made
// like any other directory, and is fine already there if it leads to one.
function makeParents(name, state) {
  const { ctx } = state
  const parts = [...name.matchAll(/[^/]+/gu)]
  let wd = name.startsWith('/') ? '/' : ctx.cwd
  let at = 0
  // Directories that are there already are entered without a word, so where
  // the way to the last component is a plain run of names that is a
  // directory, that is where the making starts; otherwise a deep tree would
  // be walked again from its top at every component.
  const ancestors = Math.max(0, parts.length - 1)
  const special = parts.findIndex(([part]) => part === '.' || part === '..')
  const plain = special < 0 || special > ancestors ? ancestors : special
  if (plain > 0) {
    const prefix = joinPath(wd, parts.slice(0, plain).map(([part]) => part).join('/'))
    if (ctx.fs.isDir(prefix)) { wd = prefix; at = plain }
  }
  for (; at < ancestors; at++) {
    const [part] = parts[at]
    const shown = name.slice(0, parts[at].index + part.length)
    if (part === '.') continue
    // `..` is not made, since it is there wherever its parent is.
    const making = part === '..' ? null : made(state, wd, part)
    if (making === null && part !== '..') announce(state, shown)
    const found = lookup(wd, part, ctx.fs)
    let error = found.error ?? (ctx.fs.isDir(found.path) ? null : 'Not a directory')
    if (error === 'No such file or directory' && making) error = making
    if (fail(state, shown, error)) return
    wd = found.path
  }
  const last = parts.length ? name.slice(parts.at(-1).index) : name
  const making = made(state, wd, last)
  if (making === null) return announce(state, name)
  if (making !== 'No such file or directory') {
    const there = lookup(wd, last, ctx.fs)
    if (there.error === null && ctx.fs.isDir(there.path)) return
    if (making === 'File exists' && there.error !== null && there.error !== 'No such file or directory' && there.error !== 'Not a directory') {
      return report(state, `mkdir: cannot stat ${quoteLocale(name, ctx)}: ${there.error}\n`)
    }
  }
  fail(state, name, making)
}

// mkdir(2) of `name` from `cwd`: what it fails with, or null once the
// directory is made. The kernel walks the way to the last component first,
// then answers for a name that cannot be made — `.`, `..` and `/` are
// there already, and a component too long to be in any directory — then for
// one already taken, a link included whatever it leads to, and only then for
// the directory it would go in, which the overlay can write and nothing else
// here can.
function made(state, cwd, name) {
  const { ctx } = state
  if (name === '') return 'No such file or directory'
  if (pathTooLong(name)) return 'File name too long'
  const bare = name.replace(/\/+$/u, '')
  if (bare === '') return 'File exists'
  const cut = bare.lastIndexOf('/') + 1
  const last = bare.slice(cut)
  const parent = cut === 0 ? { path: cwd, error: null } : lookup(cwd, bare.slice(0, cut), ctx.fs)
  if (parent.error) {
    missingPathNote(ctx, 'mkdir', name, parent.error)
    return parent.error
  }
  if (last === '.' || last === '..') return 'File exists'
  if (nameTooLong(last)) return 'File name too long'
  const target = joinPath(parent.path, last)
  if (ctx.fs.isDir(target) || ctx.fs.isFile(target) || ctx.fs.isLink?.(target)) return 'File exists'
  if (!ctx.writable || !inOverlay(target)) return writeRefusal(ctx, parent.path)
  try {
    if (!ctx.fs.makeWritableDir?.(parent.path, last)) return writeRefusal(ctx, parent.path)
  } catch (e) {
    if (unsupportedNote(e)) throw e
    missingPathNote(ctx, 'mkdir', e?.path, e?.fsError)
    const message = reason(e)
    return e?.fsError ?? (message.startsWith(last + ': ') ? message.slice(last.length + 2) : message)
  }
  return null
}

// A failure names the operand as far as it got, in quote()'s marks; whether
// there was one is what the caller goes on from.
function fail(state, shown, error) {
  if (error === null) return false
  report(state, `mkdir: cannot create directory ${quoteLocale(shown, state.ctx)}: ${error}\n`)
  return true
}

function announce(state, shown) {
  if (state.verbose) report(state, `mkdir: created directory ${quoteName(shown, state.ctx)}\n`, 1)
}

function report(state, text, fd = 2) {
  if (fd === 1) state.stdout += text
  else state.stderr += text
  state.events.push({ fd, text })
}
