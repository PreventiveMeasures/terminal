import { compareNames, lookup, resolve } from './fs.js'

// Use only for lookups whose failure is reported, not existence probes.
export function lookupWithNote(ctx, command, path) {
  const found = lookup(ctx.cwd, path, ctx.fs)
  missingPathNote(ctx, command, path, found.error)
  return found
}

export function missingPathNote(ctx, command, path, error) {
  if (error !== 'No such file or directory' || typeof path !== 'string' || path === '' || path.startsWith('/') || path.includes('\0')) return
  const alternatives = new Set()
  for (const base of new Set(['/', ctx.mount ?? '/'])) {
    if (base === ctx.cwd) continue
    const found = lookup(base, path, ctx.fs)
    if (!found.error) alternatives.add(found.path)
  }
  if (!alternatives.size) return
  const [first, second] = [...alternatives].sort(compareNames)
  let description
  if (second === undefined) description = `A ${ctx.fs.isDir(first) ? 'dir' : 'file'} exists at ${JSON.stringify(first)}.`
  else {
    const files = !ctx.fs.isDir(first) && !ctx.fs.isDir(second) && ctx.fs.isFile(first) && ctx.fs.isFile(second)
    const differ = files && !ctx.fs.sameFileContents(first, second)
    description = `Both of ${JSON.stringify(first)} and ${JSON.stringify(second)} exist${differ ? ', and they differ in contents' : ''}.`
  }
  ctx.notes?.add(`${command}: relative path ${JSON.stringify(path)} was not found from cwd ${JSON.stringify(ctx.cwd)}. ${description}`)
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
