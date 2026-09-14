// Which file a patch is for, as pch.c intuit_diff_type decides it: of the
// names its headers give, the best one that exists; failing that, if the
// patch creates a file, the best of them all; failing that, nobody knows,
// and the patch is skipped. Along the way a patch that would create what
// already exists, or delete what does not, looks reversed.

const INDEX = 2, NEW = 1, OLD = 0

// Fewest directory components, then shortest basename, then shortest name,
// then the first. `ignore[i]` rules a name out.
export function bestName(names, ignore) {
  const components = (name) => name.split('/').length - 1
  const base = (name) => name.slice(name.lastIndexOf('/') + 1).length
  let best = -1
  for (let i = 0; i < names.length; i++) {
    const name = names[i]
    if (name === null || ignore[i]) continue
    if (best === -1) { best = i; continue }
    const [c, bc] = [components(name), components(names[best])]
    if (c !== bc) { if (c < bc) best = i; continue }
    const [b, bb] = [base(name), base(names[best])]
    if (b !== bb) { if (b < bb) best = i; continue }
    if (name.length < names[best].length) best = i
  }
  return best
}

// util.c ok_to_reverse: what a person at a terminal would be asked, with
// the answer the options settle on. Without a terminal GNU takes "no".
export function okToReverse(run, message) {
  const { opts } = run
  if (opts.noReverse || !(opts.force && opts.silent)) run.say(message)
  if (opts.noReverse) {
    run.say('  Skipping patch.\n')
    run.skipRest = true
    return false
  }
  if (opts.force) {
    if (!opts.silent) run.say('  Applying it anyway.\n')
    return false
  }
  if (opts.batch) {
    run.say(run.reverse ? '  Ignoring -R.\n' : '  Assuming -R.\n')
    return true
  }
  run.say(run.reverse ? '  Ignore -R? [n] \n' : '  Assume -R? [n] \n')
  run.say('Apply anyway? [n] \n')
  if (!opts.silent) run.say('Skipping patch.\n')
  run.skipRest = true
  return false
}

// pch.c maybe_reverse. `says[side]` is what the headers say of a side: 2
// for a file that does not exist there, 1 for one the hunk empties.
function maybeReverse(run, header, name, nonexistent, isEmpty) {
  const r = run.reverse ? 1 : 0
  const says = header.says
  const looksReversed = (isEmpty ? 0 : 1) < says[r ^ (isEmpty ? 1 : 0)]
  if (isEmpty && says[r ^ (nonexistent ? 1 : 0)] === 1 && says[(1 - r) ^ (nonexistent ? 1 : 0)] === 2) return false
  if (looksReversed) {
    const would = nonexistent ? 'delete' : isEmpty ? 'empty out' : 'create'
    const which = nonexistent ? 'does not exist' : isEmpty ? 'is already empty' : 'already exists'
    if (okToReverse(run, `The next patch${run.reverse ? ', when reversed,' : ''} would ${would} the file ${run.quote(name)},\nwhich ${which}!`)) run.reverse = !run.reverse
  }
  return looksReversed
}

// Returns the input name, or null when the patch names no file that can be
// found. `stat(name)` gives { exists, isDir, size }.
export function chooseInput(run, header, operand, stat) {
  const names = [header.names.old, header.names.new, header.names.index]
  if ((names[OLD] !== null || names[NEW] !== null) && names[INDEX] !== null) names[INDEX] = null
  let chosen = -1
  if (operand === null) {
    const stats = names.map((name) => name === null ? null : stat(name))
    const ignore = stats.map((s) => s === null || !s.exists)
    chosen = bestName(names, ignore)
    const first = names.findIndex((name) => name !== null)
    if (first !== -1 && (chosen === -1 || !stats[chosen].isDir)) {
      const nonexistent = chosen === -1
      const flagged = maybeReverse(run, header, names[nonexistent ? first : chosen], nonexistent, nonexistent || stats[chosen].size === 0)
      if (flagged && nonexistent) chosen = first
    }
    if (chosen === -1 && header.says[run.reverse ? 1 : 0]) chosen = bestName(names, names.map(() => false))
  }
  const renaming = header.rename[0] || header.rename[1] || header.copy[0] || header.copy[1]
  if (renaming && operand === null && !((chosen === OLD || chosen === NEW) && names[OLD] !== null && names[NEW] !== null)) {
    run.say(`Cannot ${header.rename[0] || header.rename[1] ? 'rename' : 'copy'} file without two valid file names\n`)
    run.skipRest = true
  }
  if (chosen === -1) {
    if (operand === null) return null
    const s = stat(operand)
    if (!s.exists || !s.isDir) maybeReverse(run, header, operand, !s.exists, !s.exists || s.size === 0)
    return operand
  }
  return names[chosen]
}
