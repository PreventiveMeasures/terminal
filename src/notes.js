import { compareNames, lookup, resolve } from './fs.js'

// Use only for lookups whose failure is reported, not existence probes.
export function lookupWithNote(ctx, command, path) {
  const found = lookup(ctx.cwd, path, ctx.fs)
  missingPathNote(ctx, command, path, found.error)
  return found
}

// A session has three roots a path can be meant from: `/`, the mount its
// sources are under, and the home `~` names. A relative path was looked up from
// the cwd and an absolute one from `/`, so the note asks the roots left over
// whether the same text names something there — the mount is the one that
// answers when a caller reads `/src/app.js` of a tree mounted at `/repo`.
// Roots that coincide, and roots that lead to the same file, are one root and
// one alternative: home follows the mount unless it was set apart.
export function missingPathNote(ctx, command, path, error) {
  if (error !== 'No such file or directory' || typeof path !== 'string') return
  const absolute = path.startsWith('/')
  // Where it was already looked up, and so the one root with nothing to add.
  const from = absolute ? '/' : ctx.cwd
  // Every leading slash goes with it: another root takes `//x` as its own `x`,
  // not as the `/x` that has just failed. An empty path and a NUL need no guard
  // of their own, since lookup refuses them as it refuses a missing one.
  const wanted = path.replace(/^\/+/u, '')
  const alternatives = new Set()
  for (const root of new Set(['/', ctx.mount ?? '/', ctx.home ?? '/'])) {
    if (root === from) continue
    const found = lookup(root, wanted, ctx.fs)
    if (!found.error) alternatives.add(found.path)
  }
  if (!alternatives.size) return
  const cwd = absolute ? '' : ` from cwd ${JSON.stringify(ctx.cwd)}`
  const missed = `${absolute ? 'absolute' : 'relative'} path ${JSON.stringify(path)} was not found${cwd}`
  ctx.notes?.add(`${command}: ${missed}. ${existingPaths(ctx, alternatives)}`)
}

// Name every root that answered: one dropped for brevity would be a path the
// caller is left to guess at. Contents are compared only where every one of
// them is a file, and comparing each to the first is enough, since contents
// equal to the same contents are equal to each other.
function existingPaths(ctx, alternatives) {
  const paths = [...alternatives].sort(compareNames)
  const names = paths.map((path) => JSON.stringify(path))
  if (paths.length === 1) return `A ${ctx.fs.isDir(paths[0]) ? 'dir' : 'file'} exists at ${names[0]}.`
  const files = paths.every((path) => !ctx.fs.isDir(path) && ctx.fs.isFile(path))
  const differ = files && paths.some((path) => !ctx.fs.sameFileContents(paths[0], path))
  const listed = `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  return `${paths.length === 2 ? 'Both' : 'All'} of ${listed} exist${differ ? ', and they differ in contents' : ''}.`
}

// ls, tree and pathname globbing all drop dot-prefixed names silently. Each
// collects the names it dropped so a run can say what it did not show, and a
// name is only collected where its absence actually changed the answer.
export function hiddenEntryNotes() {
  const paths = new Set()
  return {
    add: (path) => paths.add(path),
    collect(directory, names) {
      for (const name of names) if (name.startsWith('.')) paths.add(resolve(directory, name))
    },
    emit(notes, command, explanation, context = '') {
      omissionNote(notes, { command, action: 'omitted', noun: ['hidden entry', 'hidden entries'], explanation, context, paths })
    },
  }
}

// `2>/dev/null` is written to quiet expected noise, and it silences a missing
// path just as completely: `grep -rn a d1 d2 d3 2>/dev/null` exits non-zero
// whether the pattern was absent or `d2` never existed, and nothing in what
// the caller can see tells the two apart. Notes survive redirects, so this is
// the one channel that can still say it.
const ACCESS_FAILURE = /^(?<command>[^:]+): (?<operand>.+): (?<reason>no such file or directory|not a directory|is a directory)$/iu

export function discardedStderr(ctx, text) {
  for (const line of text.split('\n')) {
    if (ACCESS_FAILURE.test(line)) ctx.discarded?.add(line)
  }
}

// Emitted at the end of a run, once everything else the caller will see is
// known: a diagnostic that reached stderr anyway, or a path another note
// already accounts for, needs no second telling. What survives is grouped, so
// one command failing the same way on three paths says so once.
export function discardedNotes(discarded, stderr, notes) {
  const groups = new Map()
  for (const line of discarded) {
    if (stderr.includes(line)) continue
    const { command, operand, reason } = ACCESS_FAILURE.exec(line).groups
    // `cp: cannot stat 'x': …` wraps its operand; everything else is the path.
    const path = /'([^']*)'$/u.exec(operand)?.[1] ?? operand
    if ([...notes].some((note) => note.includes(JSON.stringify(path)))) continue
    const key = `${command}: ${reason}`
    if (!groups.has(key)) groups.set(key, new Set())
    groups.get(key).add(path)
  }
  return [...groups].map(([key, paths]) => `${key}: ${[...paths].map((path) => JSON.stringify(path)).join(', ')}.`)
}

// A failing command in an `&&` chain cancels what follows it. That is the shell
// working as designed, and it is worth saying only where it actually stopped
// work from happening: a search that found nothing, or a read of a file that
// was not there, silently swallowing the commands chained behind it.
// A command refused as unsupported is blamed like any other: the diagnostic
// feed says the feature is missing, and only this says the rest of the chain
// went with it.
export function gateBlame(role, name) {
  return role === 'status' ? null : { name, search: role === 'search' }
}

// Steps an `&&` gate skipped, reported once the run of them ends. Built only
// once a gate has actually closed, so a chain that ran to the end costs
// nothing.
export function gateTracker() {
  let blame = null, skipped = 0
  return {
    skip(candidate, exitCode) {
      if (!skipped && candidate) blame = { ...candidate, exitCode }
      skipped++
    },
    flush(notes) {
      if (skipped && blame) {
        const commands = skipped === 1 ? 'the command' : `the ${skipped} commands`
        // grep separates "found nothing" (1) from "went wrong" (2), and the
        // first is the one callers chain behind without meaning to.
        const search = blame.search && blame.exitCode === 1
          ? ' A search that selects no lines exits 1, which is not a failure.' : ''
        notes.add(`${blame.name}: exited ${blame.exitCode}, so ${commands} after && did not run.${search}`)
      }
      blame = null
      skipped = 0
    },
  }
}

export function omissionNote(notes, options) {
  emitOmission(notes, options, options.paths.size, options.paths)
}

function emitOmission(notes, { command, action, noun, explanation = '', context = '' }, count, paths) {
  if (!count) return
  const listed = count < 10 ? ': ' + [...paths].sort(compareNames).map((path) => JSON.stringify(path)).join(', ') : ''
  const label = Array.isArray(noun) ? noun[count === 1 ? 0 : 1] : noun
  notes.add(`${command}: ${action} ${count} ${label}${context}${listed}.${explanation ? ' ' + explanation : ''}`)
}
