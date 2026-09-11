import { parseArgs } from '../args.js'
import { lookup } from '../fs.js'
import { lookupWithNote } from '../notes.js'
import { appendOutput, emptyOutput } from '../shell/output.js'
import { err, ok, reason } from '../util.js'
import { unsupported, unsupportedFrom, unsupportedNote } from '../unsupported.js'
import { quoteName } from './quote-name.js'
import { formatStat, statFormat } from './stat-format.js'

export function stat(_stdin, tokens, ctx) {
  const { order, positional } = parseArgs(tokens, {
    short: ['L', 't'], long: ['dereference', 'terse'], valueShort: ['c'], valueLong: ['format', 'printf', 'cached'],
  })
  if (!positional.length) return err('stat: missing operand')
  let format
  for (const option of order) {
    if (option.name === 'cached') {
      if (!option.value || !['always', 'never', 'default'].some((mode) => mode.startsWith(option.value))) return err(`stat: invalid cache mode: ${option.value}`)
    } else if (['c', 'format', 'printf'].includes(option.name)) format = option
  }
  if (!format) return unsupported('feature', 'stat', 'default metadata', 'stat: default output requires filesystem metadata that is not available')
  const parts = statFormat(format.value, format.name === 'printf')
  if (parts.some((part) => part.field === 's' || part.field === 'F') && metadataOverlap(positional, ctx)) {
    return unsupported('feature', 'stat', 'metadata output overlap', 'stat: buffered output sharing a measured file is not supported')
  }
  const result = emptyOutput()
  let failed = false
  for (const name of positional) {
    const next = statOperand(parts, name, ctx)
    appendOutput(result, next)
    failed ||= next.exitCode !== 0
  }
  result.exitCode = failed ? 1 : 0
  return result
}

function statOperand(parts, name, ctx) {
  if (name === '-') {
    const result = unsupported('feature', 'stat', 'standard input metadata', 'stat: standard input metadata is not supported')
    ctx.unsupported.add({ kind: 'feature', command: 'stat', detail: 'standard input metadata', message: result.stderr.trimEnd() })
    return result
  }
  const found = lookupWithNote(ctx, 'stat', name)
  if (found.error) return err(`stat: cannot stat ${quoteName(name, ctx)}: ${found.error}`)
  try { return ok(formatStat(parts, name, found.path, ctx.fs)) } catch (e) {
    const result = unsupportedFrom(e, 'stat', 'stat: ' + reason(e))
    // A later operand can succeed without erasing this operand's diagnostic.
    const note = unsupportedNote(result)
    if (note) ctx.unsupported.add(note)
    return result
  }
}

function metadataOverlap(names, ctx) {
  const handles = Object.values(ctx.outputFds).filter((fd) => typeof fd === 'object')
  if (!handles.length) return false
  return names.some((name) => {
    const found = lookup(ctx.cwd, name, ctx.fs)
    return !found.error && handles.some((fd) => fd.path === found.path || fd.identity !== undefined && fd.identity === ctx.fs.fileIdentity?.(found.path))
  })
}
