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
  return {
    isFile: (p) => files.has(p),
    isDir: (p) => childMap.has(p),
    readFile: (p) => files.get(p),
    listDir: (p) => {
      const entry = childMap.get(p)
      if (!entry) throw new Error(`not a directory: ${p}`)
      return entry
    },
  }
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
