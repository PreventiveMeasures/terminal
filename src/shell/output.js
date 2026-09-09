// Preserve command order when a surrounding group merges its streams.
// A handler returning both streams has not specified their relative order.
import { unsupported, unsupportedNote } from '../unsupported.js'

export const eventsOf = (r) => r.events ?? [
  ...(r.stdout ? [{ fd: 1, text: r.stdout }] : []),
  ...(r.stderr ? [{ fd: 2, text: r.stderr }] : []),
]
export const unorderedOutput = (r) => r.unordered ?? (!r.events && r.stdout !== '' && r.stderr !== '')

// Command lists and loops accumulate output with the same event ordering.
export const emptyOutput = (stderr = '') => ({
  stdout: '', stderr, exitCode: 0,
  events: stderr ? [{ fd: 2, text: stderr }] : [], unordered: false,
})

export function appendOutput(result, next) {
  result.stdout += next.stdout
  result.stderr += next.stderr
  result.exitCode = next.exitCode
  result.events.push(...eventsOf(next))
  result.unordered ||= unorderedOutput(next)
}

// Capture diagnostics at the expansion site, before later redirects change fd 2.
export function expansionStderr(ctx, stderr) {
  if (stderr) appendOutput(ctx.expansionOutput, routeOutput(emptyOutput(stderr), { fds: ctx.expansionFds }, ctx))
}

export function routeOutput(result, io, ctx) {
  let r = result
  const merged = io.fds[1] === io.fds[2] && ['out', 'err'].includes(io.fds[1])
  if (merged && unorderedOutput(r)) {
    r = unsupported('feature', null, 'combined output ordering', 'error: merging this command’s stdout and stderr in order is not supported')
    ctx.unsupported.add(unsupportedNote(r))
  }
  const events = []
  let stderr = '', stdout = ''
  for (const e of eventsOf(r)) {
    const dest = io.fds[e.fd]
    if (dest !== 'out' && dest !== 'err') continue
    events.push({ fd: dest === 'out' ? 1 : 2, text: e.text })
    if (dest === 'out') stdout += e.text
    else stderr += e.text
  }
  return { ...r, stdout, stderr, events, unordered: unorderedOutput(r) && stdout !== '' && stderr !== '' }
}

// Commands differ in closed-stdout status; hexdump and tree ignore the failure.
const WRITE_ERROR_STATUS = new Map([['ls', 2], ['grep', 2], ['egrep', 2], ['fgrep', 2], ['sort', 2], ['xxd', 3], ['sed', 4], ['xargs', 123], ['hexdump', 0], ['tree', 0]])

export function writeError(name, r, ctx) {
  const status = WRITE_ERROR_STATUS.get(ctx.registry.resolveCommand(name)) ?? 1
  if (status === 0) return { ...r, stdout: '' }
  return { ...r, stdout: '', stderr: r.stderr + `${name}: write error: Bad file descriptor\n`, exitCode: status }
}
