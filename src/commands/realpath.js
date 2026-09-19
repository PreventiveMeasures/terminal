import { parseArgs } from '../args.js'
import { dirname, joinPath, lookup, resolve, walkPath } from '../fs.js'
import { missingPathNote } from '../notes.js'
import { quoteShell } from './quote-name.js'
import { appendOutput, emptyOutput } from '../shell/output.js'
import { err, ok } from '../util.js'

// `-P`, the default, is the walk the kernel makes: every link on the way is
// replaced by what it names, `..` included, so `l/..` is the parent of what
// `l` leads to. `-L` takes `..` from the name as written, cancelling the
// component before it — link or not — and resolves what is left. `-s` expands
// no link at all and prints the name it was given.
//
// The existence mode is the other half: `-m` needs none of the path to be
// there, so whatever the walk could not reach — a name that is not there, a
// component that is not a directory, a link that never stops leading to
// another — is kept as it was spelled; `-e` needs all of it; and the default
// mode allows the last component alone to be missing, which is where a link
// pointing at nothing leads.
function canonicalize(ctx, path, mode, links) {
  if (path === '' || path.includes('\0')) return { error: 'No such file or directory' }
  if (links === 'none') return strippedName(ctx, path, mode)
  let walked = path
  if (links === 'logical') {
    // The same lexical reduction `-s` prints, with the same checks on the
    // components a `..` passes over — then the walk resolves what is left.
    const reduced = mode === 'm' ? { path: resolve(ctx.cwd, path) } : strippedPath(ctx, path)
    if (reduced.error) return reduced
    walked = reduced.path + (path.endsWith('/') ? '/' : '')
  }
  const found = walkPath(ctx.cwd, walked, ctx.fs, { lenient: mode === 'm' })
  if (mode === 'm') return { path: found.rest.length ? resolve(found.path, found.rest.join('/')) : found.path }
  if (found.error === 'No such file or directory' && found.rest.length === 0 && mode !== 'e') return { path: found.path }
  if (found.error) return { error: found.error }
  if (path.endsWith('/') && !ctx.fs.isDir(found.path)) return { error: 'Not a directory' }
  return { path: found.path }
}

// `-s` expands no link, in any existence mode: the name it prints is the one
// it was given with `..` taken lexically, and `-e` asks whether that name —
// the reduced one, not the spelling it came from — leads anywhere. The two
// part where a `..` cancels a link: `l/../z` is `z` here, so `z` is what has
// to be there, where the walk `-e` makes without `-s` would ask about the
// directory `l` leads to instead.
function strippedName(ctx, path, mode) {
  if (mode === 'm') return { path: resolve(ctx.cwd, path) }
  const found = strippedPath(ctx, path)
  if (found.error || mode !== 'e') return found
  const exists = lookup('/', found.path, ctx.fs)
  return exists.error ? { error: exists.error } : found
}

// The lexical walk `-s` prints and `-L` reduces a name to. GNU defers ordinary
// parent checks to the final lookup: in the default mode ENOENT there is
// allowed even when more than one component is absent. Parents followed by ..
// or a terminal . still require a directory check, and that check is the
// kernel's, through any link on the way — which is how a `..` passes over a
// link without expanding it.
function strippedPath(ctx, path) {
  const parts = (path.startsWith('/') ? path : ctx.cwd + '/' + path).split('/').filter(Boolean)
  let at = '/'
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === '..') at = dirname(at)
    else if (part !== '.') {
      at = joinPath(at, part)
      let next = i + 1
      while (parts[next] === '.') next++
      const needsDir = parts[next] === '..' || next === parts.length && (i < parts.length - 1 || path.endsWith('/'))
      if (needsDir || i === parts.length - 1) {
        const found = lookup('/', at + (needsDir ? '/' : ''), ctx.fs)
        if (found.error && !(found.error === 'No such file or directory' && i === parts.length - 1)) return found
      }
    }
  }
  return { path: at }
}

function relativePath(from, to) {
  const base = from.split('/').filter(Boolean)
  const target = to.split('/').filter(Boolean)
  let common = 0
  while (common < base.length && common < target.length && base[common] === target[common]) common++
  return [...base.slice(common).map(() => '..'), ...target.slice(common)].join('/') || '.'
}

const within = (base, path) => base === '/' || path === base || path.startsWith(base + '/')
// GNU offers no flag for the default mode, so `E` names it internally only.
const EXISTENCE_MODES = { e: 'e', 'canonicalize-existing': 'e', m: 'm', 'canonicalize-missing': 'm' }
// How much of a link each spelling expands. The three name one setting, so
// the last of them on the line is the one that answers.
const LINK_MODES = {
  P: 'physical', physical: 'physical', L: 'logical', logical: 'logical',
  s: 'none', strip: 'none', 'no-symlinks': 'none',
}

function relativeOptions(ctx, values, mode, links) {
  const base = values.get('relative-base')
  const target = values.get('relative-to') ?? base
  const result = {}
  for (const [key, operand] of [['target', target], ['base', base]]) {
    if (operand === undefined) continue
    const found = canonicalize(ctx, operand, mode, links)
    const error = found.error ?? (mode === 'e' && !ctx.fs.isDir(found.path) ? 'Not a directory' : null)
    if (error) {
      missingPathNote(ctx, 'realpath', operand, error)
      return { error: err(`realpath: ${quoteShell(operand, ctx)}: ${error}`) }
    }
    result[key] = found.path
  }
  if (result.base && !within(result.base, result.target)) delete result.target
  return result
}

export function realpath(_stdin, tokens, ctx) {
  const { flags, values, positional, order } = parseArgs(tokens, {
    short: ['e', 'm', 'L', 'P', 's', 'q', 'z'],
    long: ['canonicalize-existing', 'canonicalize-missing', 'logical', 'physical', 'strip', 'no-symlinks', 'quiet', 'zero'],
    valueLong: ['relative-to', 'relative-base'],
  })
  if (!positional.length) return err('realpath: missing operand')
  let links = 'physical', mode = 'E'
  for (const { name } of order) {
    if (Object.hasOwn(EXISTENCE_MODES, name)) mode = EXISTENCE_MODES[name]
    if (Object.hasOwn(LINK_MODES, name)) links = LINK_MODES[name]
  }
  const relative = relativeOptions(ctx, values, mode, links)
  if (relative.error) return relative.error
  const quiet = flags.has('q') || flags.has('quiet')
  const separator = flags.has('z') || flags.has('zero') ? '\0' : '\n'
  const result = emptyOutput()
  let failed = false
  for (const operand of positional) {
    const found = canonicalize(ctx, operand, mode, links)
    if (found.error) {
      missingPathNote(ctx, 'realpath', operand, found.error)
      if (!quiet) appendOutput(result, err(`realpath: ${quoteShell(operand, ctx)}: ${found.error}`))
      failed = true
    } else {
      const path = relative.target && (!relative.base || within(relative.base, found.path))
        ? relativePath(relative.target, found.path) : found.path
      appendOutput(result, ok(path + separator))
    }
  }
  result.exitCode = failed ? 1 : 0
  return result
}
