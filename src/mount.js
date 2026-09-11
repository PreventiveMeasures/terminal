import { createFs, resolve } from './fs.js'
import { writableFs } from './writable.js'

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

function optionPath(opts, name, fallback) {
  const value = opts[name] === undefined ? fallback : opts[name]
  if (typeof value !== 'string' || value.includes('\0')) throw new TypeError(`createTerminal: ${name} must be a string without NUL characters`)
  return resolve('/', value)
}
