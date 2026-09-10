// tree 2.x's plain UTF-8 listing. Counts include the root directory.
import { compareNames, joinPath } from '../fs.js'
import { parseArgs } from '../args.js'
import { err, parseNonNegativeInt } from '../util.js'
import { unsupported } from '../unsupported.js'
import { INT32_MAX } from '../numeric.js'
import { lookupWithNote, omissionNote } from '../notes.js'

export function tree(_stdin, tokens, ctx) {
  const { flags, values, positional } = parseArgs(tokens, { short: ['a', 'd', 'F'], long: ['noreport'], valueShort: ['L'] })
  if (positional.length > 1) return unsupported('feature', 'tree', 'multiple roots', 'tree: multiple roots are not supported')
  const limit = values.has('L') ? parseNonNegativeInt(values.get('L'), 'tree: -L', values.get('L'), { max: INT32_MAX }) : { value: Number.POSITIVE_INFINITY }
  if (limit.error) return limit.error
  if (!limit.value) return err('tree: -L must be greater than zero')
  const start = positional[0] ?? '.'
  const { path: root, error } = lookupWithNote(ctx, 'tree', start)
  const isDir = !error && ctx.fs.isDir(root)
  const count = { dirs: isDir && itemsFor(ctx.fs, root, flags).length ? 1 : 0, files: !error && !isDir ? 1 : 0 }
  const rootSuffix = flags.has('F') && !start.endsWith('/') ? '/' : ''
  const out = [start + (isDir ? rootSuffix : '  [error opening dir]')]
  if (isDir) {
    const omitted = new Set()
    try {
      const gap = walk(ctx.fs, root, out, flags, limit.value, count, omitted)
      if (gap) return gap
    } finally {
      omissionNote(ctx.notes, { command: 'tree', action: 'depth limit omitted contents of', noun: ['directory', 'directories'], paths: omitted })
    }
  }
  if (!flags.has('noreport')) {
    const dirs = `${count.dirs} ${count.dirs === 1 ? 'directory' : 'directories'}`
    const files = `${count.files} ${count.files === 1 ? 'file' : 'files'}`
    out.push('', flags.has('d') ? dirs : `${dirs}, ${files}`)
  }
  return { stdout: out.join('\n') + '\n', stderr: '', exitCode: error ? 2 : 0 }
}

function walk(fs, root, out, flags, limit, count, omitted) {
  const stack = [{ dir: root, prefix: '', items: itemsFor(fs, root, flags), i: 0, depth: 0 }]
  while (stack.length) {
    const frame = stack.at(-1)
    if (frame.i >= frame.items.length) { stack.pop(); continue }
    const { n, isDir } = frame.items[frame.i++]
    if ([...n].some((c) => c.codePointAt(0) < 32 || c.codePointAt(0) === 127 || c === '\\')) {
      return unsupported('feature', 'tree', 'filename escaping', 'tree: listing names requiring escaping is not supported')
    }
    const last = frame.i === frame.items.length
    out.push(frame.prefix + (last ? '└── ' : '├── ') + n + (isDir && flags.has('F') ? '/' : ''))
    count[isDir ? 'dirs' : 'files']++
    if (!isDir) continue
    const dir = joinPath(frame.dir, n)
    const items = itemsFor(fs, dir, flags)
    if (frame.depth + 1 >= limit) {
      if (items.length) omitted.add(dir)
      continue
    }
    stack.push({ dir, prefix: frame.prefix + (last ? '    ' : '│   '), items, i: 0, depth: frame.depth + 1 })
  }
}

function itemsFor(fs, dir, flags) {
  const { dirs, files } = fs.listDir(dir)
  return [...dirs.map((n) => ({ n, isDir: true })), ...(flags.has('d') ? [] : files.map((n) => ({ n, isDir: false })))]
    .filter(({ n }) => flags.has('a') || !n.startsWith('.')).sort((a, b) => compareNames(a.n, b.n))
}
