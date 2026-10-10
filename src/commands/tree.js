// tree 2.x's listing. Counts include the root directory.
//
// The branches are drawn with what the locale's character set has in it: the
// box drawing of a UTF-8 one, and the ASCII tree falls back to where a byte
// is a character. The widths are the same either way, so only the characters
// the lines are made of change.
import { compareNames, joinPath, lookup } from '../fs.js'
import { err } from '../util.js'
import { unsupported, unsupportedNote } from '../unsupported.js'
import { byteLocale } from '../locale.js'
import { hiddenEntryNotes, lookupWithNote, omissionNote } from '../notes.js'

const BRANCHES = Object.freeze({
  utf8: { down: '\u251C\u2500\u2500 ', last: '\u2514\u2500\u2500 ', through: '\u2502\u00A0\u00A0 ', past: '    ' },
  ascii: { down: '|-- ', last: '`-- ', through: '|   ', past: '    ' },
})
export const branchesFor = (ctx) => (byteLocale(ctx) ? BRANCHES.ascii : BRANCHES.utf8)

export function tree(_stdin, tokens, ctx) {
  const parsed = treeArgs(tokens)
  if (parsed.error) return parsed.error
  const { flags, positional } = parsed
  if (positional.length > 1) return unsupported('feature', 'tree', 'multiple roots', 'tree: multiple roots are not supported')
  const limit = { value: parsed.level }
  const start = positional[0] ?? '.'
  const { path: root, error } = lookupWithNote(ctx, 'tree', start)
  const isDir = !error && ctx.fs.isDir(root)
  // What the operand prints comes from the name itself and what it opens from
  // where that name leads: a link `tree` cannot open is still a name it found,
  // counted among the files, and only a name that is not there at all fails.
  const named = lookup(ctx.cwd, start, ctx.fs, { follow: false })
  const missing = Boolean(error) && Boolean(named.error)
  const count = { dirs: isDir && itemsFor(ctx.fs, root, flags).length ? 1 : 0, files: !missing && !isDir ? 1 : 0 }
  const out = [start + rootMark(ctx, flags, named, isDir) + (isDir ? '' : '  [error opening dir]')]
  if (isDir) {
    const omitted = new Set()
    const hidden = hiddenEntryNotes()
    try {
      const gap = walk(ctx.fs, root, out, flags, limit.value, count, omitted, hidden, branchesFor(ctx))
      if (gap) return gap
    } finally {
      omissionNote(ctx.notes, { command: 'tree', action: 'depth limit omitted contents of', noun: ['directory', 'directories'], paths: omitted })
      hidden.emit(ctx.notes, 'tree', 'Hidden entries are included with -a.')
    }
  }
  if (!flags.has('noreport')) {
    const dirs = `${count.dirs} ${count.dirs === 1 ? 'directory' : 'directories'}`
    const files = `${count.files} ${count.files === 1 ? 'file' : 'files'}`
    out.push('', flags.has('d') ? dirs : `${dirs}, ${files}`)
  }
  return { stdout: out.join('\n') + '\n', stderr: '', exitCode: missing ? 2 : 0 }
}

// tree 2.1.1's own reading of its command line: options are letters, run
// together or not, until `--`; and a letter that takes a value takes the next
// argument whole, wherever in its run it was, so `-L1` reads the `1` as an
// option of its own and the argument after it as the level. The level is
// strtoul's reading of that argument, in any base C spells, made an int and
// counted from zero — so what is not a number is no level at all, and is
// refused there and then, before anything later on the line is read.
const TREE_FLAGS = new Set(['a', 'd', 'F'])

function treeArgs(tokens) {
  const flags = new Set(), positional = []
  let level = Number.POSITIVE_INFINITY, options = true
  for (let n = 0; n < tokens.length;) {
    const t = tokens[n++]
    if (!options || t[0] !== '-' || t.length === 1) { positional.push(t); continue }
    if (t === '--') { options = false; continue }
    if (t.startsWith('--')) {
      if (t !== '--noreport') return { error: unsupported('option', 'tree', t.split('=')[0], `tree: unknown option: ${t.split('=')[0]}`) }
      flags.add('noreport')
      continue
    }
    for (const c of t.slice(1)) {
      if (TREE_FLAGS.has(c)) { flags.add(c); continue }
      if (c !== 'L') return { error: unsupported('option', 'tree', '-' + c, `tree: unknown option: -${c}`) }
      if (n === tokens.length) return { error: err('tree: Missing argument to -L option.') }
      const depth = BigInt.asIntN(32, strtoul(tokens[n++]) - 1n)
      if (depth < 0n) return { error: err('tree: Invalid level, must be greater than 0.') }
      level = Number(depth) + 1
    }
  }
  return { flags, positional, level }
}

// C's strtoul in base 0: blanks, a sign, then a hexadecimal, octal or decimal
// run as long as there is one; nothing read is 0, a minus wraps the value
// round, and one too large for 64 bits is the largest there is.
function strtoul(text) {
  const match = /^[ \t\n\v\f\r]*([+-]?)(0[xX][\da-fA-F]+|0[0-7]*|[1-9]\d*)?/u.exec(text)
  if (!match[2]) return 0n
  const digits = match[2]
  const value = BigInt(/^0[0-7]+$/u.test(digits) ? '0o' + digits.slice(1) : digits)
  if (value > 2n ** 64n - 1n) return 2n ** 64n - 1n
  return match[1] === '-' ? BigInt.asUintN(64, -value) : value
}

// `-F` marks the operand as it was typed, whatever it ends in — `tree -F d/`
// prints `d//` — and marks it for what the name itself is, so a link earns the
// `@` however far it leads. `-d` lists directories alone and marks none of
// them, the operand included; the `@` still says the operand is not one.
function rootMark(ctx, flags, named, isDir) {
  if (!flags.has('F')) return ''
  if (!named.error && ctx.fs.isLink?.(named.path) === true) return '@'
  return isDir && !flags.has('d') ? '/' : ''
}

function walk(fs, root, out, flags, limit, count, omitted, hidden, branches) {
  const stack = [{ dir: root, prefix: '', items: itemsFor(fs, root, flags, hidden), i: 0, depth: 0 }]
  while (stack.length) {
    const frame = stack.at(-1)
    if (frame.i >= frame.items.length) { stack.pop(); continue }
    const { n, isDir, target } = frame.items[frame.i++]
    if ([...(n + (target ?? ''))].some((c) => c.codePointAt(0) < 32 || c.codePointAt(0) === 127 || c === '\\')) {
      return unsupported('feature', 'tree', 'filename escaping', 'tree: listing names requiring escaping is not supported')
    }
    const last = frame.i === frame.items.length
    // `-F` marks what a name leads to, so a link carries the mark on the
    // target it names rather than on itself, as a long listing does.
    const mark = isDir && flags.has('F') && !flags.has('d') ? '/' : ''
    out.push(frame.prefix + (last ? branches.last : branches.down) + n + (target === undefined ? mark : ' -> ' + target + mark))
    count[isDir ? 'dirs' : 'files']++
    // A link is counted as what it leads to and crossed no more than the walk
    // below it is: what it holds is listed where that name is, not here.
    if (!isDir || target !== undefined) continue
    const dir = joinPath(frame.dir, n)
    if (frame.depth + 1 >= limit) {
      // The depth limit omits this directory's contents whole, and its own note
      // says so; nothing here was passed over merely for being hidden.
      if (holdsItems(fs, dir, flags)) omitted.add(dir)
      continue
    }
    const items = itemsFor(fs, dir, flags, hidden)
    stack.push({ dir, prefix: frame.prefix + (last ? branches.past : branches.through), items, i: 0, depth: frame.depth + 1 })
  }
}

// Whether a directory past the depth limit holds anything, for the note's
// sake alone: tree never reads it, so one a kept mode closes (writable.js) is
// left out of the note rather than refusing the listing over it.
function holdsItems(fs, dir, flags) {
  try { return itemsFor(fs, dir, flags).length > 0 } catch (e) {
    if (!unsupportedNote(e)) throw e
    return false
  }
}

// A directory this listing walks reports the names the dot rule kept out of
// both the tree and the totals under it. Files excluded by -d are left out for
// a different reason, and are not this note's to claim.
function itemsFor(fs, dir, flags, hidden = null) {
  const { dirs, files, links } = fs.listDir(dir)
  // tree lstats every name it reads, which a mode keeping the directory from
  // being searched denies (writable.js) where reading the names was not.
  const denied = dirs.length + files.length + links.length === 0 ? null : fs.searchGuard?.()?.(dir) ?? null
  if (denied !== null) throw denied
  // A link is named beside what it points at and crossed no more than the walk
  // below it is — but what it leads to is what it counts as, and what decides
  // whether `-d` lists it: a link to a directory is one of the directories.
  const linked = links.map((n) => {
    const found = lookup(dir, n, fs)
    return { n, isDir: !found.error && fs.isDir(found.path), target: fs.readLink(joinPath(dir, n)) }
  })
  const listed = flags.has('d') ? linked.filter(({ isDir }) => isDir) : [...files.map((n) => ({ n, isDir: false })), ...linked]
  if (hidden && !flags.has('a')) hidden.collect(dir, [...dirs, ...listed.map(({ n }) => n)])
  return [...dirs.map((n) => ({ n, isDir: true })), ...listed]
    .filter(({ n }) => flags.has('a') || !n.startsWith('.')).sort((a, b) => compareNames(a.n, b.n))
}
