import { createFs, resolve } from './fs.js'
import { writableFs } from './writable.js'

// Session settings a fork sets anew. Everything else it is over — the sources,
// the mount, the /tmp/ overlay, the wired commands — belongs to the terminal it
// forked from and cannot be given another value here.
const FORK_OPTIONS = ['cwd', 'home', 'user']

export function mountSources(sources, opts) {
  const mount = optionPath(opts, 'mount', '/')
  // The mount is where the caller's tree is, so it is where a session starts:
  // defaulting to `/` would put every relative path and `~` one level above the
  // only files that exist. Either can still be set on its own.
  const home = optionPath(opts, 'home', mount)
  const cwd = optionPath(opts, 'cwd', mount)
  if (opts.writable !== undefined && opts.writable !== false && opts.writable !== '/tmp/') {
    throw new TypeError("createTerminal: writable must be '/tmp/', false, or undefined")
  }
  const writable = opts.writable === '/tmp/'
  if (writable && (mount === '/' || mount === '/tmp' || mount.startsWith('/tmp/'))) {
    throw new Error("createTerminal: mount must not be /, /tmp, or inside /tmp when writable is '/tmp/'")
  }
  const base = createFs(sources, mount)
  return { fs: writable ? writableFs(base) : base, cwd, home, mount, writable }
}

// A fork starts where its parent stands, so its settings fall back to the
// parent's current ones and a relative path resolves from the parent's working
// directory rather than from `/`. An option a fork cannot honor is refused
// rather than dropped: `fork({ writable: false })` would otherwise read as an
// isolation from the parent's writes that a fork does not provide.
export function forkSettings(ctx, opts) {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new TypeError(`fork: options must be an object (got ${opts === null ? 'null' : Array.isArray(opts) ? 'an array' : typeof opts})`)
  }
  for (const name of Object.keys(opts)) {
    if (!FORK_OPTIONS.includes(name)) {
      throw new Error(`fork: unknown option \`${name}\` (known: ${FORK_OPTIONS.join(', ')}; the sources, the mount, the /tmp/ overlay and the commands come from the parent)`)
    }
  }
  return {
    cwd: optionPath(opts, 'cwd', ctx.cwd, 'fork', ctx.cwd),
    home: optionPath(opts, 'home', ctx.home, 'fork', ctx.cwd),
    user: opts.user ?? ctx.user,
  }
}

function optionPath(opts, name, fallback, label = 'createTerminal', base = '/') {
  const value = opts[name] === undefined ? fallback : opts[name]
  if (typeof value !== 'string' || value.includes('\0')) throw new TypeError(`${label}: ${name} must be a string without NUL characters`)
  return resolve(base, value)
}
