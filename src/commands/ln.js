import { parseArgs } from '../args.js'
import { dirname, lookup, walkPath } from '../fs.js'
import { err, reason } from '../util.js'
import { unsupported, unsupportedFrom, unsupportedNote } from '../unsupported.js'
import { quoteName, quoteShell } from './quote-name.js'
import { missingPathNote } from '../notes.js'
import { canonicalize, relativePath } from './realpath.js'

// `ln -s` makes a symbolic link in the writable overlay, holding the target as
// it was written: it is resolved from the link's own directory when the link
// is read, as the kernel resolves one, whether or not it leads anywhere. Which
// name the link gets follows GNU coreutils 9.4 — one operand makes it in the
// current directory under the target's last component, a directory operand
// takes it inside unless -T or, for a link to a directory, -n, and -t names
// the directory outright — and what a name it cannot take fails with is what
// symlink(2) would say. A hard link, which `ln` makes without -s, is a second
// name for one inode; the overlay has inodes, but nothing else here reads two
// names as one file, so it is refused rather than made as a copy.
const LONG = { symbolic: 's', force: 'f', 'no-dereference': 'n', 'no-target-directory': 'T', verbose: 'v', relative: 'r', logical: 'L', physical: 'P' }

export function ln(_stdin, tokens, ctx) {
  const parsed = parseArgs(tokens, { short: Object.values(LONG), long: Object.keys(LONG), valueShort: ['t'], valueLong: ['target-directory'] })
  const has = (letter) => parsed.flags.has(letter) || parsed.flags.has(Object.keys(LONG).find((name) => LONG[name] === letter))
  const opts = { force: has('f'), noDereference: has('n'), noTargetDirectory: has('T'), verbose: has('v'), relative: has('r') }
  const directory = parsed.order.findLast(({ name }) => name === 't' || name === 'target-directory')?.value ?? null
  const files = parsed.positional
  if (directory !== null && opts.noTargetDirectory) return err('ln: cannot combine --target-directory and --no-target-directory')
  if (opts.relative && !has('s')) return err('ln: cannot do --relative without --symbolic')
  if (files.length === 0) return err('ln: missing file operand')
  if (!has('s')) return unsupported('feature', 'ln', 'hard link', `ln: hard links are not supported: ${quoteName(files[0], ctx)} (ln -s makes a symbolic one)`)
  const state = { ctx, events: [], stdout: '', stderr: '' }
  try {
    const pairs = destinations(files, directory, opts, ctx)
    if (pairs.error) return pairs.error
    for (const [target, dest] of pairs) link(target, dest, opts, state)
  } catch (e) {
    missingPathNote(ctx, 'ln', e?.path, e?.fsError)
    const result = unsupportedFrom(e, 'ln', 'ln: ' + reason(e))
    result.events = [...state.events, { fd: 2, text: result.stderr }]
    result.stdout = state.stdout
    result.stderr = state.stderr + result.stderr
    return result
  }
  return { stdout: state.stdout, stderr: state.stderr, events: state.events, exitCode: state.stderr ? 1 : 0 }
}

// Which name each link gets: the operand pairs, or the error naming why none.
function destinations(files, directory, opts, ctx) {
  const shown = (name) => quoteName(name, ctx)
  if (directory !== null) {
    const found = lookup(ctx.cwd, directory, ctx.fs)
    if (found.error) {
      missingPathNote(ctx, 'ln', directory, found.error)
      return { error: err(`ln: failed to access ${shown(directory)}: ${found.error}`) }
    }
    if (!ctx.fs.isDir(found.path)) return { error: err(`ln: target ${shown(directory)} is not a directory`) }
    return files.map((target) => [target, inside(directory, target)])
  }
  if (files.length === 1) {
    if (opts.noTargetDirectory) return { error: err(`ln: missing destination file operand after ${shown(files[0])}`) }
    return [[files[0], inside('.', files[0])]]
  }
  // Two operands name a link outright when the second is not a directory —
  // or, under -n, is a link to one, since -n asks about the name itself.
  if (files.length === 2) {
    const found = lookup(ctx.cwd, files[1], ctx.fs, { follow: !opts.noDereference })
    if (opts.noTargetDirectory || found.error !== null || !ctx.fs.isDir(found.path)) return [[files[0], files[1]]]
  }
  if (opts.noTargetDirectory) return { error: err(`ln: extra operand ${shown(files[2])}`) }
  const last = files.at(-1)
  const found = lookup(ctx.cwd, last, ctx.fs)
  const error = found.error ?? (ctx.fs.isDir(found.path) ? null : 'Not a directory')
  if (error) {
    missingPathNote(ctx, 'ln', last, error)
    return { error: err(`ln: target ${shown(last)}: ${error}`) }
  }
  return files.slice(0, -1).map((target) => [target, inside(last, target)])
}

// The name a link takes inside a directory: the target's last component, as
// GNU joins them — a slash only where the directory did not end in one.
function inside(directory, target) {
  const base = target.replace(/\/+$/u, '').split('/').at(-1)
  return directory + (directory.endsWith('/') ? '' : '/') + base
}

function link(target, dest, opts, state) {
  const { ctx } = state
  const shown = quoteName(dest, ctx)
  const source = opts.relative ? relativeTarget(ctx, target, dest) : target
  const fail = (message) => report(state, `ln: failed to create symbolic link ${shown}${message}\n`)
  // symlink(2) reads the target before the name, and an empty one is a name
  // it cannot make; GNU shows both halves then.
  if (source === '') return fail(` -> ${quoteName(source, ctx)}: No such file or directory`)
  // -f replaces whatever holds the name, short of a directory.
  if (opts.force) {
    const there = lookup(ctx.cwd, dest, ctx.fs, { follow: false })
    if (there.error === null) {
      if (ctx.fs.isDir(there.path)) return report(state, `ln: ${quoteShell(dest, ctx)}: cannot overwrite directory\n`)
      try {
        if (!ctx.fs.removeWritable?.(ctx.cwd, dest)) return fail(': Read-only file system')
      } catch (e) {
        if (unsupportedNote(e)) throw e
        return fail(`: ${fsReason(e, dest)}`)
      }
    }
  }
  const invalid = nameError(ctx, dest)
  if (invalid) {
    missingPathNote(ctx, 'ln', dest, invalid)
    return fail(`: ${invalid}`)
  }
  try {
    if (!ctx.fs.makeWritableLink?.(ctx.cwd, dest, source)) return fail(': Read-only file system')
  } catch (e) {
    if (unsupportedNote(e)) throw e
    missingPathNote(ctx, 'ln', e?.path, e?.fsError)
    return fail(`: ${fsReason(e, dest)}`)
  }
  if (opts.verbose) report(state, `${shown} -> ${quoteName(source, ctx)}\n`, 1)
}

// What symlink(2) says of a name a link cannot take: one already there, where
// a link — followed or not — is a name taken; a parent that is missing or is
// not a directory; and a trailing slash, which asks for a directory of a name
// that is not there.
function nameError(ctx, dest) {
  if (dest === '' || dest.includes('\0')) return 'No such file or directory'
  const bare = dest.replace(/\/+$/u, '')
  if (bare === '') return 'File exists'
  const found = lookup(ctx.cwd, bare, ctx.fs, { follow: false })
  if (found.error === null) return 'File exists'
  if (found.error !== 'No such file or directory' || dest !== bare) return found.error
  const walk = walkPath(ctx.cwd, bare, ctx.fs)
  return walk.rest.length > 0 ? walk.error : null
}

// -r spells the target from the link's own directory, both taken as far as
// they lead — through every link on the way, and past what is not there — as
// `realpath -m` reads them; a target no reading can start on stays as written.
function relativeTarget(ctx, target, dest) {
  const from = canonicalize(ctx, dirname(dest), 'm', 'physical')
  const to = canonicalize(ctx, target, 'm', 'physical')
  return from.error || to.error ? target : relativePath(from.path, to.path)
}

function fsReason(e, name) {
  const message = reason(e)
  return e?.fsError ?? (message.startsWith(name + ': ') ? message.slice(name.length + 2) : message)
}

function report(state, text, fd = 2) {
  if (fd === 1) state.stdout += text
  else state.stderr += text
  state.events.push({ fd, text })
}
