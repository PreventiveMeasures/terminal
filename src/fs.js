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

// Filesystem lookup must validate each component BEFORE collapsing `..`.
// Otherwise `missing/../file` or `file/../other` can read an unrelated file.
// Lexical helpers (dirname, basename, the public resolve API) stay separate.
export function lookup(cwd, path, fs) {
  const missing = { path: null, error: 'No such file or directory' }
  const notDir = { path: null, error: 'Not a directory' }
  if (path === '' || path.includes('\0')) return missing
  const parts = (path.startsWith('/') ? path : cwd + '/' + path).split('/').filter(Boolean)
  let at = '/'
  for (const part of parts) {
    if (!fs.isDir(at)) return fs.isFile(at) ? notDir : missing
    if (part === '..') at = dirname(at)
    else if (part !== '.') at = joinPath(at, part)
  }
  if (!fs.isDir(at) && !fs.isFile(at)) return missing
  if (path.endsWith('/') && !fs.isDir(at)) return notDir
  return { path: at, error: null }
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

// UTF-8 byte order is code-point order for valid Unicode. JavaScript's
// default sort compares UTF-16 units and misorders astral characters.
export function compareNames(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a.codePointAt(i) - b.codePointAt(i)
  }
  return a.length - b.length
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
    entry.dirs.sort(compareNames)
    entry.files.sort(compareNames)
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

// Iterative depth-first traversal. Yield before consulting shouldDescend so
// find can prune the directory it just evaluated. Sorting makes the virtual
// tree deterministic; native readdir order itself is filesystem-dependent.
export function* walkTree(fs, root, maxDepth = Number.POSITIVE_INFINITY, shouldDescend = () => true) {
  if (fs.isFile(root)) { yield { path: root, kind: 'file', depth: 0 }; return }
  if (!fs.isDir(root)) return
  const stack = [{ path: root, kind: 'dir', depth: 0 }]
  while (stack.length) {
    const entry = stack.pop()
    yield entry
    if (entry.kind !== 'dir' || entry.depth >= maxDepth || !shouldDescend(entry.path)) continue
    const { dirs, files } = fs.listDir(entry.path)
    const children = [...dirs.map((name) => ({ name, kind: 'dir' })), ...files.map((name) => ({ name, kind: 'file' }))]
    children.sort((a, b) => compareNames(a.name, b.name))
    for (const child of children.toReversed()) stack.push({ path: joinPath(entry.path, child.name), kind: child.kind, depth: entry.depth + 1 })
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
