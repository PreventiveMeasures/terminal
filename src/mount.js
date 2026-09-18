import { createFs, resolve } from './fs.js'
import { localeOption } from './locale.js'
import { writableFs } from './writable.js'

// Session settings a fork sets anew. Everything else it is over — the sources,
// the mount, the /tmp/ overlay, the wired commands — belongs to the terminal it
// forked from and cannot be given another value here.
const FORK_OPTIONS = ['cwd', 'home', 'user', 'inherit']

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
  return { fs: writable ? writableFs(base) : base, cwd, home, mount, writable, locale: localeOption(opts) }
}

// A fork starts where its parent stands, so its settings fall back to the
// parent's current ones and a relative path resolves from the parent's working
// directory rather than from `/`. Where it stands, whose home it reads and what
// it calls itself are its own to set; `inherit` decides the one thing left, the
// shell state it was handed. An option a fork cannot honor is refused rather
// than dropped: `fork({ writable: false })` would otherwise read as an
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
  // Only the two states a shell can be handed: the parent's, or none. A value
  // between them would have to say which half of a session it keeps.
  if (opts.inherit !== undefined && typeof opts.inherit !== 'boolean') {
    throw new TypeError(`fork: inherit must be true or false (got ${opts.inherit === null ? 'null' : typeof opts.inherit})`)
  }
  return {
    cwd: optionPath(opts, 'cwd', ctx.cwd, 'fork', ctx.cwd),
    home: optionPath(opts, 'home', ctx.home, 'fork', ctx.cwd),
    user: opts.user ?? ctx.user,
    // The locale is the environment's: a fork keeps it whatever else it drops.
    locale: ctx.locale,
    inherit: opts.inherit ?? true,
  }
}

function optionPath(opts, name, fallback, label = 'createTerminal', base = '/') {
  const value = opts[name] === undefined ? fallback : opts[name]
  if (typeof value !== 'string' || value.includes('\0')) throw new TypeError(`${label}: ${name} must be a string without NUL characters`)
  return resolve(base, value)
}
