// The long listing `ls -l` prints, over metadata a path-to-content map does
// not keep: it has no permissions, no owners and no clock. Rather than a guess
// per entry, what it shows is one deliberate model of such a tree — every
// entry is the session user's alone (`-rw-------`, `drwx------`) and is dated
// to the moment the terminal was created, a time its forks carry with them.
// Link counts, directory sizes and the `total` line are what ext4 would say of
// the same tree, so the listing reads as one taken from a disk.

import { UnsupportedError } from '../unsupported.js'
import { encodeUtf8 } from '../util.js'
import { duSize, humanScale } from './du-options.js'
import { formatDate } from './extra.js'

// ext4 allocates 4 KiB blocks and counts them in 512-byte units: a directory
// takes one block, an empty file none, and `total` is the sum in KiB.
const BLOCK = 4096
const BLOCK_UNITS = BLOCK / 512
// ext4 keeps a link target of under 60 bytes in the inode's own block list,
// where it occupies no block at all: the fast symlink.
const FAST_LINK = 60
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
  const mtime = ctx.createdAt, now = Date.now()
  const recent = mtime <= now && now - mtime < HALF_YEAR
  // Local time unless TZ is set, which is how `date` reads the same clock.
  const time = formatDate(new Date(mtime), recent ? '%b %e %H:%M' : '%b %e  %Y', ctx.vars.has('TZ'))
  const size = (bytes) => scale ? duSize(BigInt(bytes), scale) : String(bytes)
  const width = (strings) => Math.max(0, ...strings.map((s) => s.length))
  return {
    // Entries carry a name to print, an absolute path and what kind of entry
    // they are — a link also carries what it points at, which the row names
    // after it; a directory listing gets its `total` line first.
    lines(entries, listing) {
      const rows = entries.map(({ name, abs, kind, target }) => {
        const dir = kind === 'dir'
        const bytes = dir ? BLOCK : ctx.fs.fileSize(abs) ?? encodeUtf8(ctx.fs.readFile(abs)).length
        // A link's own mode is the one every symbolic link on Linux carries,
        // and a target ext4 can hold in the inode takes no block of its own.
        const mode = dir ? 'drwx------' : kind === 'link' ? 'lrwxrwxrwx' : '-rw-------'
        const units = dir ? BLOCK_UNITS : kind === 'link' && bytes < FAST_LINK ? 0 : Math.ceil(bytes / BLOCK) * BLOCK_UNITS
        const shown = kind === 'link' ? `${name} -> ${target}` : name
        return { name: shown, mode, units, links: String(dir ? 2 + ctx.fs.listDir(abs).dirs.length : 1), size: size(bytes) }
      })
      const linkWidth = width(rows.map((row) => row.links)), sizeWidth = width(rows.map((row) => row.size))
      const lines = rows.map((row) => `${row.mode} ${row.links.padStart(linkWidth)} ${user} ${user} ${row.size.padStart(sizeWidth)} ${time} ${row.name}`)
      if (listing) {
        const units = rows.reduce((sum, row) => sum + row.units, 0)
        lines.unshift('total ' + (scale ? duSize(BigInt(units) * 512n, scale) : String(units / 2)))
      }
      return lines
    },
  }
}
