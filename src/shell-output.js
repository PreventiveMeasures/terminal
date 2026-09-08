// Preserve command order when a surrounding group merges its streams.
// A handler returning both streams has not specified their relative order.
import { unsupported, unsupportedNote } from './unsupported.js'

export const eventsOf = (r) => r.events ?? [
  ...(r.stdout ? [{ fd: 1, text: r.stdout }] : []),
  ...(r.stderr ? [{ fd: 2, text: r.stderr }] : []),
]
export const unorderedOutput = (r) => r.unordered ?? (!r.events && r.stdout !== '' && r.stderr !== '')

export function routeOutput(result, io, ctx) {
  let r = result
  const merged = io.fds[1] === io.fds[2] && ['out', 'err'].includes(io.fds[1])
  if (merged && unorderedOutput(r)) {
    r = unsupported('feature', null, 'combined output ordering', 'error: merging this command’s stdout and stderr in order is not supported')
    ctx.unsupported.add(unsupportedNote(r))
  }
  const events = []
  const initial = io.warnings ? [{ fd: 2, text: io.warnings }] : []
  for (const e of [...initial, ...eventsOf(r)]) {
    const dest = io.fds[e.fd]
    if (dest === 'out' || dest === 'err') events.push({ fd: dest === 'out' ? 1 : 2, text: e.text })
  }
  const stdout = events.filter((e) => e.fd === 1).map((e) => e.text).join('')
  const stderr = events.filter((e) => e.fd === 2).map((e) => e.text).join('')
  return { ...r, stdout, stderr, events, unordered: unorderedOutput(r) && stdout !== '' && stderr !== '' }
}

// What a command does when its stdout is closed, as the real ones do
// (checked against the binaries and bash's builtins): most report
// `write error: Bad file descriptor` and exit 1; these exit otherwise,
// and two never notice.
const WRITE_ERROR_STATUS = new Map([['ls', 2], ['grep', 2], ['sort', 2], ['xxd', 3], ['sed', 4], ['xargs', 123], ['hexdump', 0], ['tree', 0]])

export function writeError(name, r, ctx) {
  const status = WRITE_ERROR_STATUS.get(ctx.registry.resolveCommand(name)) ?? 1
  if (status === 0) return { ...r, stdout: '' }
  return { ...r, stdout: '', stderr: r.stderr + `${name}: write error: Bad file descriptor\n`, exitCode: status }
}

