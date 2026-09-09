import { UnsupportedError } from '../unsupported.js'
import { lookup } from '../fs.js'
import { parseArgs } from '../args.js'
import { encodeUtf8Loose, lineRecords, okWith, readContent } from '../util.js'

// cat displays actual UTF-8 bytes with -v; numbering uses the original
// lines so marking an empty line with -E never makes -b count it.
export function cat(stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['n', 'b', 's', 'v', 'E', 'T', 'A', 'e', 't'] })
  const format = (content) => formatCat(content, flags)
  const r = readCatContent(positional, stdin, ctx, format, flags.size !== 0)
  return okWith(format(r.content), r)
}

// GNU compares the unread input offset with stdout's offset (or file end
// for append). Earlier operands advance stdout before the next input opens.
function readCatContent(files, stdin, ctx, format, transforms) {
  const output = ctx.outputFds[1]
  if (!output?.path && !ctx.outputFds[2]?.path) return readContent('cat', files, stdin, ctx)
  let content = '', pipe = stdin, stderr = ''
  for (const name of files.length ? files : ['-']) {
    const shared = name === '-'
    const redirected = shared || name === '/dev/stdin'
    const path = redirected ? ctx.stdinHandle?.path : lookup(ctx.cwd, name, ctx.fs).path
    const identity = redirected ? ctx.stdinHandle?.identity : ctx.fs.fileIdentity?.(path)
    if (stderr && sameFile(path, identity, ctx.outputFds[2])) throw new UnsupportedError('feature', 'cat input modified by diagnostics', 'cat: reading an input after writing diagnostics to the same file is not supported')
    if (sameFile(path, identity, output)) {
      const position = shared ? encodeUtf8Loose(ctx.stdinHandle.content).length - encodeUtf8Loose(pipe).length : 0
      if (position < output.position + encodeUtf8Loose(format(content)).length) {
        stderr += `cat: ${name}: input file is output file\n`
        continue
      }
      const unread = shared ? pipe : redirected ? ctx.stdinOrigin : ctx.fs.readFile(path)
      if (transforms && unread !== '') throw new UnsupportedError('feature', 'cat transforms its input file', 'cat: transforming an input file through its own output descriptor is not supported')
    }
    const r = readContent('cat', [name], pipe, ctx)
    content += r.content
    stderr += r.stderr
    if (shared || name === '/dev/stdin' && !ctx.stdinFile) pipe = ''
  }
  return { content, stderr, failed: stderr !== '' }
}

// A replacement or unlink leaves open descriptors on the old inode, which
// may now be reachable through a backup name rather than the original path.
function sameFile(path, identity, handle) {
  if (!path || !handle?.path) return false
  return identity !== undefined && handle.identity !== undefined ? identity === handle.identity : path === handle.path
}

function formatCat(input, flags) {
  if (!flags.size) return input
  const showEnds = flags.has('E') || flags.has('A') || flags.has('e')
  const showTabs = flags.has('T') || flags.has('A') || flags.has('t')
  const visible = flags.has('v') || flags.has('A') || flags.has('e') || flags.has('t')
  const content = flags.has('s') ? squeezeBlankLines(input) : input
  let n = 0
  const out = lineRecords(content).map((raw) => {
    const ended = raw.endsWith('\n')
    let line = ended ? raw.slice(0, -1) : raw
    const prefix = (flags.has('b') ? line !== '' : flags.has('n')) ? `${String(++n).padStart(6)}\t` : ''
    if (visible) line = [...encodeUtf8Loose(line)].map((b) => visibleByte(b, showTabs)).join('')
    else {
      if (showTabs) line = line.replaceAll('\t', '^I')
      if (showEnds && ended && line.endsWith('\r')) line = line.slice(0, -1) + '^M'
    }
    return prefix + line + (ended ? (showEnds ? '$\n' : '\n') : '')
  }).join('')
  return out
}

function visibleByte(b, tabs) {
  if (b === 9) return tabs ? '^I' : '\t'
  if (b >= 128) return 'M-' + visibleByte(b - 128, true)
  if (b < 32) return '^' + String.fromCodePoint(b + 64)
  return b === 127 ? '^?' : String.fromCodePoint(b)
}

// Keep one blank line, plus the preceding nonempty line's terminator if present.
function squeezeBlankLines(content) {
  return content.replace(/(^|\n)\n+/gu, '$1\n')
}
