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

// Chaining `&&` behind a command whose only product is a status is the idiom
// rather than an oversight, so a gate those close goes unremarked. A search
// asked for with -q is the same intent said with a flag.
const STATUS_ONLY = new Set(['test', '[', 'true', 'false'])
const SEARCHES = new Set(['grep', 'egrep', 'fgrep'])
const QUIET = /^-[A-Za-z]*q/u

export function gateBlame(argv) {
  const [name, ...args] = argv
  if (STATUS_ONLY.has(name)) return null
  const search = SEARCHES.has(name)
  return search && args.some((arg) => QUIET.test(arg)) ? null : { name, search }
}

// A failing command in an `&&` chain cancels what follows it. That is the
// shell working as designed, and it is worth saying only where it actually
// stopped work from happening: a search that found nothing, or a read of a
// file that was not there, silently swallowing the commands the caller
// chained behind it.
// Tracks a run of steps an `&&` gate skipped, so one note can name both the
// command that closed the gate and how much of the chain it cancelled.
export function shortCircuitTracker(ctx) {
  let blame = null, skipped = 0
  return {
    skip(exitCode) {
      if (skipped === 0 && ctx.ranCommand) blame = { ...ctx.ranCommand, exitCode }
      skipped++
    },
    flush() {
      if (skipped) shortCircuitNote(ctx.notes, blame, skipped)
      blame = null
      skipped = 0
    },
  }
}

function shortCircuitNote(notes, blame, skipped) {
  if (!blame) return
  const commands = skipped === 1 ? 'the command' : `the ${skipped} commands`
  // grep separates "found nothing" (1) from "went wrong" (2), and the first
  // is the one callers chain behind without meaning to.
  const search = blame.search && blame.exitCode === 1
    ? ' A search that selects no lines exits 1, which is not a failure.' : ''
  notes.add(`${blame.name}: exited ${blame.exitCode}, so ${commands} after && did not run.${search}`)
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
