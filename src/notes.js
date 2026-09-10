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

export function omissionNote(notes, options) {
  emitOmission(notes, options, options.paths.size, options.paths)
}

function emitOmission(notes, { command, action, noun, explanation = '', context = '' }, count, paths) {
  if (!count) return
  const listed = count < 10 ? ': ' + [...paths].sort(compareNames).map((path) => JSON.stringify(path)).join(', ') : ''
  const label = Array.isArray(noun) ? noun[count === 1 ? 0 : 1] : noun
  notes.add(`${command}: ${action} ${count} ${label}${context}${listed}.${explanation ? ' ' + explanation : ''}`)
}
