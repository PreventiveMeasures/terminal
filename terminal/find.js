// find — auditor's tree-walker, in its own file because the feature
// set (POSIX-style `-name` / `-type` / `-path` primaries, GNU long
// forms, `-not` / `!` negation, `-maxdepth` capping, the per-path
// glob matcher, the BFS queue walker) doesn't fit nav-commands.js's
// 300-line cap once you account for everything. The other nav
// commands (pwd, cd, ls, tree, basename, dirname) stay there;
// nav-commands.js re-exports the imported `find` so NAV_COMMANDS
// keeps the same shape.

import { basename, resolve } from './fs.js'
import { parseArgs } from './parse.js'
import { err, ok, parseNonNegativeInt } from './util.js'

// Primary tokens accepted by find. Each gets normalized to the
// long-form `--primary` so parseArgs's strict schema doesn't
// unbundle `-name` into `-n -a -m -e`. Negation (`-not <primary>`
// or `! <primary>`) is folded into a `--not-<primary>` token in
// the same pass so the existing valueLong parsing handles both
// signs uniformly.
const PRIMARIES = new Set(['name', 'type', 'path', 'maxdepth'])

export function find(_stdin, tokens, ctx) {
  const normalized = normalizeFindTokens(tokens)
  if (normalized.error) return normalized.error
  const valueLong = [...PRIMARIES, ...[...PRIMARIES].map((p) => `not-${p}`)]
  const { values, positional } = parseArgs(normalized.tokens, { valueLong })
  const start = positional[0] ?? '.'
  const startAbs = resolve(ctx.cwd, start)
  if (!ctx.fs.isDir(startAbs) && !ctx.fs.isFile(startAbs)) {
    return err(`find: ${start}: no such file or directory`)
  }
  const filters = buildFilters(values)
  if (filters.error) return filters.error
  const out = []
  for (const entry of walk(ctx.fs, startAbs, filters.maxDepth)) {
    // POSIX find: output (and -path filtering) uses the user-typed
    // prefix, not the resolved absolute path. `find /…` keeps
    // absolute paths because the user asked for them.
    const display = toDisplayPath(start, startAbs, entry.path)
    if (matchFilters({ kind: entry.kind, path: display }, filters)) out.push(display)
  }
  return ok(out.length === 0 ? '' : out.join('\n') + '\n')
}

function toDisplayPath(userPath, absRoot, absPath) {
  if (absPath === absRoot) return userPath
  const rel = absRoot === '/' ? absPath.slice(1) : absPath.slice(absRoot.length + 1)
  // POSIX find prepends the user-typed prefix verbatim, including
  // `./` for a `.` start — important so a pattern like
  // `*/node_modules/*` matches the descendants (`./node_modules/foo`
  // contains a `/`; `node_modules/foo` doesn't). grep -r in this
  // codebase drops the `./` instead; the two commands intentionally
  // diverge here, each following its own GNU convention.
  return userPath.endsWith('/') ? userPath + rel : userPath + '/' + rel
}

// Fold `-not <primary>` / `! <primary>` pairs into a single
// `--not-<primary>` token before parseArgs sees them; rewrite bare
// `-primary` to `--primary` so the strict short-flag rule doesn't
// unbundle them. Stops at `--` so `-name` / `-not` etc. used as
// literal paths after the terminator stay positional.
function normalizeFindTokens(tokens) {
  const out = []
  let afterTerminator = false
  let pendingNot = false
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (afterTerminator) { out.push(t); continue }
    if (t === '-not' || t === '!') {
      if (pendingNot) return { error: err('find: `-not` cannot precede another `-not`') }
      pendingNot = true
      continue
    }
    const primary = primaryFor(t)
    if (pendingNot) {
      if (primary === null) return { error: err(`find: \`-not\` must be followed by a primary, got: ${t}`) }
      out.push(`--not-${primary}`)
      pendingNot = false
      continue
    }
    if (primary !== null) { out.push(`--${primary}`); continue }
    out.push(t)
    if (t === '--') afterTerminator = true
  }
  if (pendingNot) return { error: err('find: trailing `-not` with no primary') }
  return { tokens: out }
}

function primaryFor(token) {
  if (token.startsWith('--') && PRIMARIES.has(token.slice(2))) return token.slice(2)
  if (token.startsWith('-') && PRIMARIES.has(token.slice(1))) return token.slice(1)
  return null
}

function buildFilters(values) {
  const typeFilter = checkType(values.get('type'))
  if (typeFilter.error) return typeFilter
  const notTypeFilter = checkType(values.get('not-type'))
  if (notTypeFilter.error) return notTypeFilter
  const maxDepth = values.has('maxdepth')
    ? parseNonNegativeInt(values.get('maxdepth'), 'find: -maxdepth')
    : { value: Number.POSITIVE_INFINITY }
  if (maxDepth.error) return maxDepth
  return {
    typeFilter: typeFilter.value,
    notTypeFilter: notTypeFilter.value,
    namePattern: values.get('name'),
    notNamePattern: values.get('not-name'),
    pathPattern: values.get('path'),
    notPathPattern: values.get('not-path'),
    maxDepth: maxDepth.value,
  }
}

function checkType(v) {
  if (v === undefined || v === 'f' || v === 'd') return { value: v }
  return { error: err(`find: -type/--type expects 'f' or 'd', got: ${v}`) }
}

function matchFilters(entry, f) {
  if (f.typeFilter === 'f' && entry.kind !== 'file') return false
  if (f.typeFilter === 'd' && entry.kind !== 'dir') return false
  if (f.notTypeFilter === 'f' && entry.kind === 'file') return false
  if (f.notTypeFilter === 'd' && entry.kind === 'dir') return false
  const bn = basename(entry.path)
  if (f.namePattern && !globMatch(bn, f.namePattern)) return false
  if (f.notNamePattern && globMatch(bn, f.notNamePattern)) return false
  // -path glob matches against the full path; `*` spans `/` (no
  // POSIX-glob slash exemption), so `*/node_modules/*` is the
  // standard exclude pattern.
  if (f.pathPattern && !globMatch(entry.path, f.pathPattern)) return false
  if (f.notPathPattern && globMatch(entry.path, f.notPathPattern)) return false
  return true
}

// Yields `{ path, kind }`. Tracks depth internally so `maxDepth`
// can cap recursion: depth 0 is the start path, depth 1 is its
// direct children, and so on. Matches POSIX `find -maxdepth N`.
function* walk(fs, root, maxDepth = Number.POSITIVE_INFINITY) {
  if (fs.isFile(root)) { yield { path: root, kind: 'file' }; return }
  yield { path: root, kind: 'dir' }
  // Index pointer instead of Array.shift() — shift() is O(n) per
  // call because it reindexes the rest of the array, making BFS
  // O(n²) on large trees.
  const queue = [{ path: root, depth: 0 }]
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]
    if (cur.depth >= maxDepth) continue
    const { dirs, files } = fs.listDir(cur.path)
    const join = (n) => cur.path === '/' ? '/' + n : cur.path + '/' + n
    for (const d of dirs) {
      const path = join(d)
      yield { path, kind: 'dir' }
      queue.push({ path, depth: cur.depth + 1 })
    }
    for (const f of files) yield { path: join(f), kind: 'file' }
  }
}

// Tiny glob matcher: `*` (any chars), `?` (any single char). No
// braces / character classes — kept small. `*` spans `/`, matching
// the convention auditors use when writing `-path '*/node_modules/*'`.
function globMatch(name, pattern) {
  const re = new RegExp('^' + pattern
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*/gu, '.*')
    .replace(/\?/gu, '.') + '$', 'u')
  return re.test(name)
}
