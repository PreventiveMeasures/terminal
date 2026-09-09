import { lookup } from '../fs.js'
import { appendOutput, emptyOutput } from '../shell/output.js'
import { markUnsupported, unsupported, unsupportedFrom, unsupportedNote } from '../unsupported.js'
import { err } from '../util.js'

// GNU -i has an optional attached suffix; the next token is still a script
// or operand. Required -e/-f values take precedence over option scanning.
export function preprocessInPlace(tokens) {
  const out = []
  let inPlace = null
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '--') { out.push(...tokens.slice(i)); break }
    if (token === '--in-place' || token.startsWith('--in-place=')) {
      inPlace = token === '--in-place' ? '' : token.slice('--in-place='.length)
      continue
    }
    if (token.startsWith('--') || !token.startsWith('-')) {
      out.push(token)
      if ((token === '--expression' || token === '--file') && i + 1 < tokens.length) out.push(tokens[++i])
      continue
    }
    let kept = token
    for (let j = 1; j < token.length; j++) {
      const option = token[j]
      if (option === 'i') {
        inPlace = token.slice(j + 1)
        kept = token.slice(0, j)
        break
      }
      if (option === 'e' || option === 'f') {
        out.push(token)
        if (j + 1 === token.length && i + 1 < tokens.length) out.push(tokens[++i])
        kept = ''
        break
      }
      if (!'nErsz'.includes(option)) break
    }
    if (kept && (kept !== '-' || token === '-')) out.push(kept)
  }
  return { tokens: out, inPlace }
}

export function runInPlace(program, flags, ctx, suffix, run) {
  if (program.files.length === 0) return err('sed: no input files', 4)
  const result = emptyOutput()
  const separate = new Set([...flags, 's'])
  let badInput = false
  for (const name of program.files) {
    const found = inPlaceInput(name, ctx)
    if (found.error) {
      // A later input can be stderr's file, so report before opening it.
      appendOutput(result, ctx.flushOutput(found.error))
      if (found.error.exitCode !== 2) return copyNote(result, found.error)
      badInput = true
      continue
    }
    const next = run({ ...program, files: [found.path] }, separate)
    const { content, ...output } = next
    appendOutput(result, output)
    if (next.failed || unsupportedNote(next)) return copyNote(result, next)
    const backup = backupName(name, suffix)
    let replaced
    try { replaced = ctx.fs.replaceWritable(ctx.cwd, name, content, backup) } catch (e) {
      const failed = unsupportedFrom(e, 'sed', `sed: ${e.message}`, 4)
      appendOutput(result, failed)
      return copyNote(result, failed)
    }
    if (!replaced) {
      const failed = refused(backup ?? name)
      appendOutput(result, failed)
      return copyNote(result, failed)
    }
    if (next.quit) break
  }
  if (badInput) result.exitCode = 2
  return result
}

function inPlaceInput(name, ctx) {
  if (name === '/dev/null' || name === '/dev/stdin' && !ctx.stdinFile
    || name === '/dev/stdout' && !ctx.outputFds[1]?.path || name === '/dev/stderr' && !ctx.outputFds[2]?.path) {
    return { error: err(`sed: couldn't edit ${name}: not a regular file`, 4) }
  }
  if (name === '/dev/stdin' || name === '/dev/stdout' || name === '/dev/stderr') return { error: refused(name) }
  const found = lookup(ctx.cwd, name, ctx.fs)
  if (found.error) return { error: err(`sed: ${name}: ${found.error.toLowerCase()}`, 2) }
  if (ctx.fs.isDir(found.path)) return { error: err(`sed: couldn't edit ${name}: not a regular file`, 4) }
  if (!ctx.writable || !found.path.startsWith('/tmp/')) return { error: refused(name) }
  return found
}

function backupName(name, suffix) {
  if (suffix === '' || suffix === '*') return
  return suffix.includes('*') ? suffix.replaceAll('*', () => name) : name + suffix
}

function refused(name) {
  return unsupported('feature', 'sed', '-i', `sed: ${name}: file system is read-only`)
}

function copyNote(result, next) {
  const note = unsupportedNote(next)
  return note ? markUnsupported(result, note.kind, note.command, note.detail, note.message) : result
}
