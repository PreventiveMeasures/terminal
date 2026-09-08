// Read-only source map with a directory index derived from file paths.
// All internal lookups use normalized absolute paths.

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

// Inputs are normalized; joining at the root must not introduce '//'.
export function joinPath(dir, name) {
  return dir === '/' ? '/' + name : dir + '/' + name
}

// abs must be a descendant of the normalized ancestor root.
export function relativeTo(root, abs) {
  return root === '/' ? abs.slice(1) : abs.slice(root.length + 1)
}

// Ignore non-string contents. Map keys and object keys share normalization;
// the directory index is built once for repeated listings and traversal.
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

// Filter the same depth-first order used by find.
function* walkFiles(fs, root) {
  for (const entry of walkTree(fs, root)) if (entry.kind === 'file') yield entry.path
}

// Build missing ancestors from the top down without recursive stack growth.
function ensureDir(map, path) {
  const toCreate = []
  let p = path
  while (p !== '/' && !map.has(p)) {
    toCreate.push(p)
    p = dirname(p)
  }
  for (let i = toCreate.length - 1; i >= 0; i--) {
    const child = toCreate[i]
    map.set(child, { dirs: [], files: [] })
    map.get(dirname(child)).dirs.push(basename(child))
  }
}
