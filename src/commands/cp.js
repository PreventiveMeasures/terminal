import { parseArgs } from '../args.js'
import { compareNames, creationError, lookup, relativeTo, resolve, walkTree, writeTarget } from '../fs.js'
import { err, reason } from '../util.js'
import { appendOutput, emptyOutput } from '../shell/output.js'
import { UnsupportedError, unsupportedNote } from '../unsupported.js'
import { quoteName } from './quote-name.js'
import { lookupWithNote, missingPathNote } from '../notes.js'
import { inOverlay } from '../writable.js'

const SPECIAL_FILES = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr'])

export function cp(_stdin, tokens, ctx) {
  const parsed = parseArgs(tokens, {
    short: ['f', 'n', 'v', 'T', 'r', 'R'], long: ['force', 'no-clobber', 'verbose', 'no-target-directory', 'recursive'],
    valueShort: ['t'], valueLong: ['target-directory'],
  })
  const operands = copyOperands(parsed, ctx)
  if (operands.error) return err('cp: ' + operands.error)
  const { sources, target, directory } = operands
  const { flags } = parsed
  const verbose = flags.has('v') || flags.has('verbose')
  const recursive = flags.has('r') || flags.has('R') || flags.has('recursive')
  const copies = sources.map((source) => [source, directory ? target.replace(/\/+$/u, '') + '/' + lastComponent(source) : target])
  const noClobber = flags.has('n') || flags.has('no-clobber')
  const state = {
    ctx, result: emptyOutput(), failed: false, sources: new Set(), copied: new Set(),
    noClobber, force: flags.has('f') || flags.has('force'), verbose, recursive,
    outputOverlap: verbose && outputOverlaps(copies, ctx, { recursive, noClobber }),
  }
  for (const [source, destination] of copies) {
    // Each copy finishes before the next operand is opened. Ancestor scopes
    // (such as xargs reading its arguments) still guard their own input.
    ctx.io.setReads([])
    try { copyFile(source, destination, state) } catch (e) {
      missingPathNote(ctx, 'cp', e?.path, e?.fsError)
      const note = unsupportedNote(e)
      const message = 'cp: ' + reason(e)
      if (note) {
        ctx.unsupported.add({ ...note, command: note.command ?? 'cp', message })
        appendOutput(state.result, err(message))
        return state.result
      }
      report(state, message + '\n', true)
    }
  }
  state.result.exitCode = state.failed ? 1 : 0
  return state.result
}

function copyOperands({ positional, flags, order }, ctx) {
  const targets = order.filter(({ name }) => name === 't' || name === 'target-directory')
  if (targets.length > 1) return { error: 'multiple target directories specified' }
  const explicit = targets[0]?.value
  const noDirectory = flags.has('T') || flags.has('no-target-directory')
  if (positional.length === 0) return { error: 'missing file operand' }
  if (explicit === undefined && positional.length === 1) return { error: 'missing destination file operand after ' + quoteName(positional[0], ctx) }
  if (explicit !== undefined && noDirectory) return { error: 'cannot combine --target-directory (-t) and --no-target-directory (-T)' }
  if (noDirectory && positional.length > 2) return { error: 'extra operand ' + quoteName(positional[2], ctx) }
  const target = explicit ?? positional.at(-1)
  const found = lookup(ctx.cwd, target, ctx.fs)
  const directory = !noDirectory && ctx.fs.isDir(found.path)
  if (!directory && (explicit !== undefined || positional.length > 2)) {
    missingPathNote(ctx, 'cp', target, found.error)
    return { error: `${explicit === undefined ? 'target' : 'target directory'} ${quoteName(target, ctx)}: ${found.error ?? 'Not a directory'}` }
  }
  return { target, directory, sources: explicit === undefined ? positional.slice(0, -1) : positional }
}

// A recursive copy follows no link in the source — `-r` keeps each one as the
// link it is, and only `-L` would read through it — and nothing here can make a
// link, since the overlay holds files and directories alone. So a link such a
// copy meets is refused rather than written as the file it points at.
function refuseLinkedCopy(source, destination, state) {
  const { ctx } = state
  const root = lookup(ctx.cwd, source, ctx.fs, { follow: false }).path
  if (root === null) return
  const from = source.replace(/\/+$/u, ''), into = destination.replace(/\/+$/u, '')
  for (const entry of walkTree(ctx.fs, root)) {
    if (entry.kind !== 'link') continue
    const below = entry.path === root ? null : relativeTo(root, entry.path)
    // `-n` decides from the destination alone, so a link whose name is taken
    // there is passed over rather than refused: nothing of it is copied.
    if (skippedByNoClobber(below === null ? destination : `${into}/${below}`, state)) continue
    // Nor is a link the copy can never reach: a destination the walk cannot
    // enter stops it above the link, which GNU answers with the name in the
    // way rather than with anything below it.
    if (below !== null && blockedAbove(into, below, state)) continue
    throw linkedCopy(below === null ? source : `${from}/${below}`)
  }
}

// `-n` is the one flag that answers before the source is opened at all: a name
// already there is left as it is, and the copy neither fails nor happens.
const skippedByNoClobber = (destination, state) =>
  state.noClobber && lookup(state.ctx.cwd, destination, state.ctx.fs).path !== null

// Each directory the copy would have to enter or make on the way down to an
// entry. One that is there and is not a directory is the end of that branch.
function blockedAbove(into, below, state) {
  const { ctx } = state
  const parts = below.split('/')
  for (let i = 1; i < parts.length; i++) {
    const found = lookup(ctx.cwd, `${into}/${parts.slice(0, i).join('/')}`, ctx.fs)
    if (found.path !== null && !ctx.fs.isDir(found.path)) return true
  }
  return false
}

const linkedCopy = (name) => new UnsupportedError('feature', 'symbolic link', `copying a symbolic link is not supported: ${name} (a recursive copy keeps the link, and nothing here makes one)`)

// A destination that is a link leading nowhere. GNU writes through neither
// half of such a name: not the link, which is a name already taken, and not
// the file it names, which is not there to open — `-f` and `-n` leave that
// alone. So the copy is refused rather than made, whatever the link leads to.
const danglingTarget = (ctx, name, dest) =>
  dest.path === null && ctx.fs.isLink?.(lookup(ctx.cwd, name, ctx.fs, { follow: false }).path) === true

// GNU names a copy after the last component of the source as it was typed,
// rather than after the directory that spelling resolves to: `cp -r a/. d`
// copies what `a` holds into `d` itself, and says so as `'a/./x' -> 'd/./x'`.
// A source ending in `..` is named `.` for the reason cp.c gives: `d/..` would
// put the copy beside the directory it was asked to go in, or anywhere else a
// climb out of it reaches.
const lastComponent = (name) => {
  const last = name.replace(/\/+$/u, '').split('/').at(-1)
  return last === '..' ? '.' : last
}

// `top` names the operands a nested copy came from, which is what GNU's
// into-itself diagnostic reports however deep the loop is found.
function copyFile(source, destination, state, top = null) {
  const { ctx } = state
  if (isSpecialFile(source, ctx.cwd) || isSpecialFile(destination, ctx.cwd)) throw new UnsupportedError('feature', 'special file', 'copying special files is not supported')
  const shownSource = quoteName(source, ctx)
  const shownTarget = quoteName(destination, ctx)
  // Without `-r` a link operand is read through, which is GNU's default for
  // one it is handed; with it, every link is the link itself to copy, and
  // this filesystem has nowhere to put one — unless `-n` has left the
  // destination alone, which is decided before the source is opened.
  if (state.recursive && ctx.fs.isLink?.(lookup(ctx.cwd, source, ctx.fs, { follow: false }).path)) {
    if (!skippedByNoClobber(destination, state)) throw linkedCopy(source)
    return
  }
  const found = lookupWithNote(ctx, 'cp', source)
  const fail = (message) => report(state, 'cp: ' + message + '\n', true)
  if (found.error) return fail(`cannot stat ${shownSource}: ${found.error}`)
  if (ctx.fs.isDir(found.path)) {
    if (!state.recursive) return fail(`-r not specified; omitting directory ${shownSource}`)
    return copyDirectory(source, found.path, destination, state, top ?? { source: shownSource, target: shownTarget }, top === null)
  }
  // Repeated *operands* are what GNU warns about; an entry a walk reaches has
  // a destination of its own and repeats nothing, so `cp -r a/sub/x a d` copies
  // the file twice, as the two names it was given ask for.
  if (top === null) {
    if (state.sources.has(found.path)) return report(state, `cp: warning: source file ${shownSource} specified more than once\n`, false, true)
    state.sources.add(found.path)
  }
  const dest = lookup(ctx.cwd, destination, ctx.fs)
  if (dest.error && dest.error !== 'No such file or directory') return fail(`cannot stat ${shownTarget}: ${dest.error}`)
  if (state.noClobber && dest.path !== null) return
  if (sameFile(found.path, dest.path, ctx.fs)) return fail(`${shownSource} and ${shownTarget} are the same file`)
  if (ctx.fs.isDir(dest.path)) return fail(`cannot overwrite directory ${shownTarget} with non-directory ${shownSource}`)
  const absolute = writeTarget(ctx.fs, ctx.cwd, destination)
  // Two operands landing on one name is the mistake GNU refuses; two trees
  // merging onto one is what a recursive copy is for, and the second source
  // wins there, so only operands answer to this.
  if (top === null && state.copied.has(absolute)) return fail(`will not overwrite just-created ${shownTarget} with ${shownSource}`)
  const invalid = creationError(ctx.cwd, destination, ctx.fs, dest)
  announce(shownSource, shownTarget, state)
  if (danglingTarget(ctx, destination, dest)) return fail(`not writing through dangling symlink ${shownTarget}`)
  if (invalid) {
    missingPathNote(ctx, 'cp', destination, invalid)
    return fail(`cannot create regular file ${shownTarget}: ${invalid}`)
  }
  try {
    if (!ctx.fs.copyWritable?.(ctx.cwd, found.path, destination)) {
      return fail(`${state.force && dest.path !== null ? 'cannot remove' : 'cannot create regular file'} ${shownTarget}: Read-only file system`)
    }
  } catch (e) {
    if (unsupportedNote(e)) throw e
    missingPathNote(ctx, 'cp', e?.path, e?.fsError)
    const message = reason(e)
    return fail(`cannot create regular file ${shownTarget}: ${message.startsWith(destination + ': ') ? message.slice(destination.length + 2) : message}`)
  }
  if (top === null) state.copied.add(absolute)
}

// A directory is copied by making the destination and then copying what the
// source held when it was read. An entry that is the destination itself is the
// loop GNU refuses to follow, and refusing it leaves the rest of the tree
// copied, as GNU leaves it.
function copyDirectory(source, absolute, destination, state, top, operand) {
  const { ctx } = state
  const shownSource = quoteName(source, ctx)
  const shownTarget = quoteName(destination, ctx)
  const fail = (message) => report(state, 'cp: ' + message + '\n', true)
  // A regular file can be written through a link and a directory cannot, so
  // GNU reads the destination of a directory copy as `lstat` reads it: the
  // name itself, whatever it leads to. `cp -rT d link` overwrites no
  // directory, and neither does a copy into a link that leads nowhere.
  const dest = lookup(ctx.cwd, destination, ctx.fs, { follow: false })
  if (dest.error && dest.error !== 'No such file or directory') return fail(`cannot stat ${shownTarget}: ${dest.error}`)
  // A trailing slash says the destination is a directory, which is what this
  // makes: that spelling refuses a file destination, not this one.
  const named = destination.replace(/\/+$/u, '') || destination
  // Two names for one directory are the same file whatever the way to each,
  // which GNU answers before it asks what the destination is: a link naming
  // the source is that directory, not a name in the way.
  if (writeTarget(ctx.fs, ctx.cwd, named, true) === absolute) return fail(`${shownSource} and ${shownTarget} are the same file`)
  // What the destination already is settles it before where it falls: a file
  // under the source is a file in the way, not a loop.
  if (dest.path !== null && !ctx.fs.isDir(dest.path)) {
    return fail(`cannot overwrite non-directory ${shownTarget} with directory ${shownSource}`)
  }
  // Where the copy lands, which a link on the way moves: the name the making
  // itself will answer for, and so the name the checks below ask about.
  const target = writeTarget(ctx.fs, ctx.cwd, named, false)
  // Whether the destination can be made at all is settled before where it
  // falls, too: `..` collapses lexically, so a name reaching through a
  // directory that is not there would otherwise read as a loop rather than as
  // the missing component it is.
  if (dest.path === null) {
    const invalid = creationError(ctx.cwd, named, ctx.fs)
    if (invalid) {
      missingPathNote(ctx, 'cp', named, invalid)
      return fail(`cannot create directory ${shownTarget}: ${invalid}`)
    }
    // GNU makes the destination before the walk can find it reaching back
    // into the source, so a directory it cannot make answers ahead of the
    // loop: what is below is only reached where the making would succeed.
    if (!ctx.writable || !inOverlay(target)) return fail(`cannot create directory ${shownTarget}: Read-only file system`)
  }
  // A destination under the source is the loop GNU names. GNU makes the
  // directory, copies what it read before reaching it, and only then refuses;
  // what that leaves behind follows the order the host read the directory in,
  // which a tree sorted for determinism cannot reproduce. So the refusal comes
  // first here, rather than a half-made copy that is neither GNU's nor asked
  // for. The diagnostic and the status are GNU's.
  if (target.startsWith(absolute === '/' ? '/' : absolute + '/')) {
    return fail(`cannot copy a directory, ${top.source}, into itself, ${top.target}`)
  }
  // GNU keeps the operands it has copied, and names a directory as a directory.
  if (operand) {
    if (state.sources.has(absolute)) return report(state, `cp: warning: source directory ${shownSource} specified more than once\n`, false, true)
    state.sources.add(absolute)
  }
  // Every link below this operand is refused, and refused here: after the
  // destination has answered for itself, since a copy it turns away never
  // reaches the tree, and before anything is made, since a refusal found
  // halfway would leave a copy neither GNU's nor asked for.
  if (operand) refuseLinkedCopy(source, destination, state)
  const { dirs, files, links } = ctx.fs.listDir(absolute)
  if (dest.path === null && !makeDirectory(source, destination, named, target, state)) return
  const from = source.replace(/\/+$/u, ''), into = destination.replace(/\/+$/u, '')
  for (const name of [...dirs, ...files, ...links].sort(compareNames)) {
    // Each entry finishes before the next is opened, as each operand does.
    ctx.io.setReads([])
    copyFile(`${from}/${name}`, `${into}/${name}`, state, top)
  }
}

function makeDirectory(source, destination, named, target, state) {
  const { ctx } = state
  const shownTarget = quoteName(destination, ctx)
  const fail = (message) => {
    report(state, 'cp: cannot create directory ' + shownTarget + ': ' + message + '\n', true)
    return false
  }
  // Making the directory is what earns it a verbose line, and only a making
  // that succeeds does: a destination outside the overlay is refused with
  // nothing said, so that answer is GNU's own and no line was ever in
  // question. Where the directory can be made, the line is refused before it
  // exists rather than after, so a refusal leaves nothing behind.
  // Which side of the boundary it falls on is the walk's answer rather than
  // the spelling's, since a link on the way leads where it leads.
  const writable = ctx.writable && inOverlay(target)
  if (writable) refuseBufferedOutput(state)
  try {
    if (!writable || !ctx.fs.makeWritableDir?.(ctx.cwd, named)) return fail('Read-only file system')
  } catch (e) {
    if (unsupportedNote(e)) throw e
    missingPathNote(ctx, 'cp', e?.path, e?.fsError)
    const message = reason(e)
    return fail(message.startsWith(named + ': ') ? message.slice(named.length + 2) : message)
  }
  // GNU announces a directory it makes, and says nothing of one already there.
  announce(quoteName(source, ctx), shownTarget, state)
  return true
}

// Verbose output is GNU's to buffer, so where its descriptor is a file this
// copy also reads or writes, what a caller reads back depends on when that
// buffer was flushed. Nothing is said before the refusal, since the line would
// be the very thing in question.
function announce(source, target, state) {
  if (!state.verbose) return
  refuseBufferedOutput(state)
  report(state, `${source} -> ${target}\n`)
}

function refuseBufferedOutput(state) {
  if (state.outputOverlap) throw new UnsupportedError('feature', 'copy output buffering', 'buffered verbose output sharing a copied file is not supported')
}

function sameFile(source, destination, fs) {
  if (source === destination) return true
  const identity = fs.fileIdentity?.(source)
  return identity !== undefined && identity === fs.fileIdentity(destination)
}

// GNU buffers verbose stdout; buffer fills and error() flushes can change a
// later copy when that descriptor points to a file this copy reads or writes.
// What a copy touches is each source file and the same name under the
// destination, so a file already in the destination that no source entry names
// is untouched and its descriptor is nobody's business here.
function outputOverlaps(copies, ctx, { recursive, noClobber }) {
  const output = ctx.outputFds[1]
  if (typeof output !== 'object') return false
  const scan = {
    ctx, recursive, noClobber,
    // A name is not an inode: the overlay can hold one inode under two names,
    // and a `sed -i` backup can put the descriptor's file anywhere at all.
    holds: (path) => output.identity === undefined ? output.path === path : output.identity === ctx.fs.fileIdentity?.(path),
    // `cp` copies in order, and the order is part of the answer: an operand can
    // name what an earlier one has just put there, a source already copied is
    // warned about rather than copied again, and a name an earlier operand has
    // taken is refused rather than overwritten. None of those opens anything.
    made: new Set(), sources: new Set(), copied: new Set(),
  }
  return copies.some(([source, destination]) => operandOverlaps(source, destination, scan))
}

function operandOverlaps(source, destination, scan) {
  const { ctx } = scan
  const found = lookup(ctx.cwd, source, ctx.fs)
  const from = found.path ?? resolve(ctx.cwd, source)
  // A name that is not there yet may be one an earlier operand makes.
  const coming = found.error === 'No such file or directory' && (scan.made.has(from) || madeDirectory(from, scan))
  if (found.error && !coming) return false
  // A copy writes where the destination leads, so that is the name the scan
  // has to watch: a link naming the descriptor's file overlaps as surely as
  // the file named outright.
  const into = writeTarget(ctx.fs, ctx.cwd, destination)
  if (found.error === null ? ctx.fs.isDir(found.path) : !scan.made.has(from)) {
    if (!scan.recursive || !copiesDirectory(from, destination, ctx) || scan.sources.has(from)) return false
    scan.sources.add(from)
    return treeOverlaps(from, into, scan)
  }
  // A source is one directory or one file however it is spelled, and `cp` keeps
  // it by the name it resolves to — `s` and `s/sub/..` are the same operand
  // twice even though they would be copied to different destinations.
  if (scan.sources.has(from)) return false
  scan.sources.add(from)
  if (scan.copied.has(into) || !copiesFile(from, into, destination, ctx, scan.noClobber)) return false
  scan.copied.add(into)
  scan.made.add(into)
  return scan.holds(from) || scan.holds(into)
}

// Every file below the source is read, and written to the name it keeps below
// the destination — but only where the entry gets that far. Its parents are
// this copy's own to make, so a component that is not there yet says nothing
// about it; what is already in the way does.
function treeOverlaps(from, into, scan) {
  const { ctx } = scan
  const root = from === '/' ? 0 : from.length
  for (const path of filesUnder(from, scan)) {
    const to = into + path.slice(root)
    if (refusedBeforeWriting(path, to, lookup(ctx.cwd, to, ctx.fs), ctx, scan.noClobber)) continue
    scan.made.add(to)
    if (scan.holds(path) || scan.holds(to)) return true
  }
  return false
}

// What a walk finds there: what is there now, and what an earlier operand will
// have put there by the time this one runs. Files are all of it, since a walk
// that meets a link copies nothing at all.
function filesUnder(from, scan) {
  const prefix = from === '/' ? '/' : from + '/'
  const present = scan.ctx.fs.isDir(from) ? [...scan.ctx.fs.walkFiles(from)] : []
  return new Set([...present, ...[...scan.made].filter((path) => path.startsWith(prefix))])
}

const madeDirectory = (path, scan) => [...scan.made].some((file) => file.startsWith(path + '/'))

// A copy that refuses before it writes has opened neither name, so nothing it
// says can meet anything it does: the diagnostic and the verbose line that goes
// with it are GNU's own, whatever the descriptor happens to point at. These are
// the refusals `copyFile` reaches before the write, in its order, and they are
// the same ones for an entry a walk reaches as for an operand.
function refusedBeforeWriting(source, to, dest, ctx, noClobber) {
  if (dest.error && dest.error !== 'No such file or directory') return true
  if (noClobber && dest.path !== null) return true
  if (sameFile(source, dest.path, ctx.fs) || ctx.fs.isDir(dest.path)) return true
  // A destination outside the overlay is refused by the filesystem before the
  // source is opened, so that copy reads nothing either. The line it announced
  // on the way is GNU's own, and lands wherever it was pointed.
  return !ctx.writable || !inOverlay(to)
}

// An operand answers for its own missing components as well; an entry below it
// does not, since the copy makes that entry's parents on the way down.
function copiesFile(source, to, destination, ctx, noClobber) {
  const dest = lookup(ctx.cwd, destination, ctx.fs)
  return !refusedBeforeWriting(source, to, dest, ctx, noClobber) &&
    !danglingTarget(ctx, destination, dest) && !creationError(ctx.cwd, destination, ctx.fs, dest)
}

// The refusals `copyDirectory` reaches before it lists anything, in its order.
// A directory operand that stops at one of them is never walked, so nothing
// below it is opened and none of it is the descriptor's business.
function copiesDirectory(absolute, destination, ctx) {
  const dest = lookup(ctx.cwd, destination, ctx.fs, { follow: false })
  if (dest.error && dest.error !== 'No such file or directory') return false
  const named = destination.replace(/\/+$/u, '') || destination
  if (dest.path !== null && !ctx.fs.isDir(dest.path)) return false
  if (dest.path === null && creationError(ctx.cwd, named, ctx.fs)) return false
  const target = writeTarget(ctx.fs, ctx.cwd, named, false)
  if (writeTarget(ctx.fs, ctx.cwd, named, true) === absolute) return false
  if (target.startsWith(absolute === '/' ? '/' : absolute + '/')) return false
  // Nothing below a destination outside the overlay is written either, whether
  // the walk is stopped at its making or every file in it is refused in turn.
  return Boolean(ctx.writable) && inOverlay(target)
}

function isSpecialFile(name, cwd) {
  const path = name.startsWith('/') ? name : cwd + '/' + name
  return SPECIAL_FILES.has(path.replace(/\/\.(?=\/)/gu, '').replace(/\/+/gu, '/'))
}

function report(state, text, failed = false, warning = false) {
  const event = failed || warning ? emptyOutput(text) : { ...emptyOutput(), stdout: text, events: [{ fd: 1, text }] }
  appendOutput(state.result, state.ctx.flushOutput(event))
  state.failed ||= failed
}
