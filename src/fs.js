// Virtual read-only filesystem built from a `{ path: content }`
// sources map (the same shape stasis bundles ship — see
// `ui/view/render-bundle.js`). All paths in the API are absolute
// and POSIX-normalized; cwd-relative paths run through
// `resolve(cwd, p)` first. Directories are derived from the set
// of file paths — there is no separate dir entry in the input.

export function normalize(path) {
  const absolute = path.startsWith('/')
  const segs = path.split('/').filter(Boolean)
  const out = []
  for (const seg of segs) {
    if (seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out.at(-1) !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(seg)
  }
  if (absolute) return '/' + out.join('/')
  return out.length === 0 ? '.' : out.join('/')
}

export function resolve(cwd, path) {
  if (path.startsWith('/')) return normalize(path)
  return normalize(cwd + '/' + path)
}

export function dirname(path) {
  const p = normalize(path)
  if (p === '/') return '/'
  const i = p.lastIndexOf('/')
  if (i < 0) return '.'
  return i === 0 ? '/' : p.slice(0, i)
}

export function basename(path) {
  const p = normalize(path)
  if (p === '/') return '/'
  const i = p.lastIndexOf('/')
  return p.slice(i + 1)
}

// Join an already-normalized directory path with a child name,
// avoiding the `//foo` double slash at the root (`/` + `foo` → `/foo`).
export function joinPath(dir, name) {
  return dir === '/' ? '/' + name : dir + '/' + name
}

// Path of `abs` relative to ancestor directory `root`, with no leading
// slash. Assumes `abs` sits strictly under `root` (callers guarantee
// it); `root === '/'` just drops the leading slash. Spans multiple
// levels: relativeTo('/a', '/a/b/c') === 'b/c'.
export function relativeTo(root, abs) {
  return root === '/' ? abs.slice(1) : abs.slice(root.length + 1)
}

// Build the filesystem. Accepts either a Map or a plain object
// keyed by path. Non-string values are skipped — callers that
// hand us a mixed-content map (binary blobs alongside source
// text) get the text-only view.
//
// A per-directory child index is built once up front so listDir
// is an O(1) lookup instead of an O(F+D) scan-per-call. `find`
// and `tree` call listDir once per visited directory, so a tree
// of N nodes would otherwise be O(N²).
export function createFs(sources) {
  const files = new Map()
  const it = sources instanceof Map ? sources.entries() : Object.entries(sources ?? {})
  for (const [k, v] of it) {
    if (typeof v !== 'string') continue
    files.set(normalize('/' + String(k)), v)
  }
  const childMap = new Map([['/', { dirs: [], files: [] }]])
  for (const f of files.keys()) {
    const parent = dirname(f)
    ensureDir(childMap, parent)
    childMap.get(parent).files.push(basename(f))
  }
  for (const entry of childMap.values()) {
    entry.dirs.sort()
    entry.files.sort()
  }
  const fs = {
    isFile: (p) => files.has(p),
    isDir: (p) => childMap.has(p),
    readFile: (p) => files.get(p),
    listDir: (p) => {
      const entry = childMap.get(p)
      if (!entry) throw new Error(`not a directory: ${p}`)
      return entry
    },
    walkFiles: (root) => walkFiles(fs, root),
  }
  return fs
}

// The single tree traversal: a breadth-first generator over `root` and
// every descendant, yielding `{ path, kind, depth }` (depth 0 = root,
// 1 = its children, …). `maxDepth` caps the descent. `find` consumes
// this directly (depth drives -mindepth/-maxdepth); `walkFiles` filters
// it to file paths. An index pointer (not Array.shift) keeps traversal
// O(n) on wide trees.
//
// Note: this virtual FS has no empty directories — `childMap` only
// holds dirs registered as ancestors of a file (see `ensureDir`) — but
// the walk copes if one appears: empty `dirs`/`files` just yields
// nothing on that iteration.
export function* walkTree(fs, root, maxDepth = Number.POSITIVE_INFINITY) {
  if (fs.isFile(root)) { yield { path: root, kind: 'file', depth: 0 }; return }
  if (!fs.isDir(root)) return
  yield { path: root, kind: 'dir', depth: 0 }
  const queue = [{ path: root, depth: 0 }]
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]
    if (cur.depth >= maxDepth) continue
    const { dirs, files } = fs.listDir(cur.path)
    const depth = cur.depth + 1
    for (const d of dirs) {
      const path = joinPath(cur.path, d)
      yield { path, kind: 'dir', depth }
      queue.push({ path, depth })
    }
    for (const f of files) yield { path: joinPath(cur.path, f), kind: 'file', depth }
  }
}

// Every absolute file path under `root` (or `root` itself if it's a
// file), in walkTree order — files of a directory before its
// subdirectories' files. Friendly for grep -r / xargs consumers.
function* walkFiles(fs, root) {
  for (const entry of walkTree(fs, root)) if (entry.kind === 'file') yield entry.path
}

// Register `path` as a directory in the child index, bubbling up
// so every ancestor also exists and records `path`'s basename as
// one of its children. Iterative rather than recursive — a stasis
// bundle with a pathologically deep path (thousands of segments)
// would otherwise overflow the call stack during construction.
// Idempotent: ancestors already in the map short-circuit the walk.
function ensureDir(map, path) {
  const toCreate = []
  let p = path
  while (p !== '/' && !map.has(p)) {
    toCreate.push(p)
    p = dirname(p)
  }
  // Walk from the highest-unregistered ancestor down to `path`,
  // creating each entry and recording it as a child of its parent.
  for (let i = toCreate.length - 1; i >= 0; i--) {
    const child = toCreate[i]
    map.set(child, { dirs: [], files: [] })
    map.get(dirname(child)).dirs.push(basename(child))
  }
}
