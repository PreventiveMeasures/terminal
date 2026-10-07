// The long listing `ls -l` prints, over metadata a path-to-content map does
// not keep: it has no permissions, no owners and no clock. Rather than a guess
// per entry, what it shows is one deliberate model of such a tree — every
// entry is the session user's alone (`-rw-------`, `drwx------`) and is dated
// to the moment the terminal was created, a time its forks carry with them.
// An entry that keeps a mode or a time of its own — one extracted from an
// archive (writable.js) — is listed with it instead. Link counts, directory
// sizes and the `total` line are what ext4 would say of the same tree, so the
// listing reads as one taken from a disk.

import { UnsupportedError } from '../unsupported.js'
import { encodeUtf8 } from '../util.js'
import { BLOCK, allocated, duSize, humanScale } from './du-options.js'
import { formatDate } from './extra.js'
import { modeString } from './tar/list.js'

// `total` counts what ext4 allocates (see allocated in ./du-options.js) in
// the 512-byte units `st_blocks` is kept in, and prints the sum in KiB.
// What GNU ls calls recent, and so dates to the minute rather than the year:
// within the past half of an average Gregorian year, and not in the future.
const HALF_YEAR = 31556952 * 1000 / 2

export function longFormat(ctx, human) {
  // A block size from the environment would change the size column and the
  // total alike, in units this listing does not offer.
  for (const name of ['LS_BLOCK_SIZE', 'BLOCK_SIZE', 'BLOCKSIZE']) {
    if (ctx.vars.has(name)) throw new UnsupportedError('feature', 'block size environment', `${name} is not supported in a long listing`)
  }
  const scale = human ? humanScale(ctx) : null
  const user = ctx.user ?? 'user'
  const now = Date.now()
  // Local time unless TZ is set, which is how `date` reads the same clock.
  const stamp = (mtime) => {
    const recent = mtime <= now && now - mtime < HALF_YEAR
    return formatDate(new Date(mtime), recent ? '%b %e %H:%M' : '%b %e  %Y', ctx.vars.has('TZ'))
  }
  const size = (bytes) => scale ? duSize(BigInt(bytes), scale) : String(bytes)
  const width = (strings) => Math.max(0, ...strings.map((s) => s.length))
  return {
    // Entries carry a name to print, an absolute path and what kind of entry
    // they are — a link also carries what it points at, which the row names
    // after it; a directory listing gets its `total` line first. `others`
    // are rows GNU measured with these and prints elsewhere: the directories
    // among the operands, listed after the files, whose columns the files'
    // are as wide as.
    lines(entries, listing, others = []) {
      const rowOf = ({ name, abs, kind, target }) => {
        const dir = kind === 'dir'
        const bytes = dir ? BLOCK : ctx.fs.fileSize(abs) ?? encodeUtf8(ctx.fs.readFile(abs)).length
        // A link's own mode is the one every symbolic link on Linux carries.
        const own = ctx.fs.metadataOf?.(abs) ?? null
        const mode = kind === 'link' ? 'lrwxrwxrwx' : own?.mode === undefined ? (dir ? 'drwx------' : '-rw-------') : modeString(dir ? 'directory' : 'file', own.mode)
        const units = allocated(bytes, kind) / 512
        const shown = kind === 'link' ? `${name} -> ${target}` : name
        const time = stamp(own?.mtime === undefined ? ctx.createdAt : own.mtime * 1000)
        return { name: shown, mode, units, links: String(dir ? ctx.fs.linkCount?.(abs) ?? 2 + ctx.fs.listDir(abs).dirs.length : 1), size: size(bytes), time }
      }
      const rows = entries.map(rowOf)
      const measured = [...rows, ...others.map(rowOf)]
      const linkWidth = width(measured.map((row) => row.links)), sizeWidth = width(measured.map((row) => row.size))
      const lines = rows.map((row) => `${row.mode} ${row.links.padStart(linkWidth)} ${user} ${user} ${row.size.padStart(sizeWidth)} ${row.time} ${row.name}`)
      if (listing) {
        const units = rows.reduce((sum, row) => sum + row.units, 0)
        lines.unshift('total ' + (scale ? duSize(BigInt(units) * 512n, scale) : String(units / 2)))
      }
      return lines
    },
  }
}
