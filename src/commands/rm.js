import { parseArgs } from '../args.js'
import { lookup } from '../fs.js'
import { err, ok, reason } from '../util.js'
import { unsupportedFrom } from '../unsupported.js'
import { quoteName } from './quote-name.js'

export function rm(_stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['f', 'v'], long: ['force', 'verbose'] })
  const force = flags.has('f') || flags.has('force')
  const verbose = flags.has('v') || flags.has('verbose')
  if (positional.length === 0) return force ? ok('') : err('rm: missing operand')
  const events = []
  let stderr = '', stdout = ''
  try {
    for (const name of positional) {
      const found = lookup(ctx.cwd, name, ctx.fs)
      let error = found.error
      // GNU -f ignores ENOTDIR as well as ENOENT: neither names an existing file.
      if (force && (error === 'No such file or directory' || error === 'Not a directory')) continue
      if (error === null && ctx.fs.isDir(found.path)) error = 'Is a directory'
      const shown = verbose || error !== null || !ctx.writable || !found.path?.startsWith('/tmp/') ? quoteName(name, ctx) : ''
      if (error === null && !ctx.fs.removeWritable?.(ctx.cwd, name)) error = 'Read-only file system'
      if (error) {
        const text = `rm: cannot remove ${shown}: ${error}\n`
        stderr += text
        events.push({ fd: 2, text })
      } else if (verbose) {
        const text = `removed ${shown}\n`
        stdout += text
        events.push({ fd: 1, text })
      }
    }
  } catch (e) {
    const result = unsupportedFrom(e, 'rm', 'rm: ' + reason(e))
    result.events = [...events, { fd: 2, text: result.stderr }]
    result.stdout = stdout
    result.stderr = stderr + result.stderr
    return result
  }
  return { stdout, stderr, events, exitCode: stderr ? 1 : 0 }
}
