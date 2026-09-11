// Preserve command order when a surrounding group merges its streams.
// A handler returning both streams has not specified their relative order.
import { markUnsupported, unsupported, unsupportedNote } from '../unsupported.js'
import { discardedStderr } from '../notes.js'

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
  const run = (write) => routeEvents(result, io, ctx, write)
  return ctx.io ? ctx.io.output(result, io, run) : run((event, handle) => handle.write(event.text))
}

function routeEvents(result, io, ctx, write) {
  let r = result
  const first = io.fds[1], second = io.fds[2]
  const merged = first === second && first !== 'null' && first !== 'closed'
    || (first?.identity && second?.identity ? first.identity === second.identity : first?.path && first.path === second?.path)
  if (merged && unorderedOutput(r)) {
    r = unsupported('feature', null, 'combined output ordering', 'error: merging this command’s stdout and stderr in order is not supported')
    ctx.unsupported.add(unsupportedNote(r))
  }
  const events = []
  let stderr = '', stdout = ''
  for (const e of eventsOf(r)) {
    const dest = io.fds[e.fd]
    if (typeof dest === 'object') { write(e, dest); continue }
    if (dest !== 'out' && dest !== 'err') {
      // A diagnostic sent to /dev/null or a closed descriptor reaches nobody.
      if (e.fd === 2) discardedStderr(ctx, e.text)
      continue
    }
    events.push({ fd: dest === 'out' ? 1 : 2, text: e.text })
    if (dest === 'out') stdout += e.text
    else stderr += e.text
  }
  return { ...r, stdout, stderr, events, unordered: unorderedOutput(r) && stdout !== '' && stderr !== '' }
}

// Commands differ in closed-stdout status; hexdump and tree ignore the failure.
const WRITE_ERROR_STATUS = new Map([['ls', 2], ['grep', 2], ['egrep', 2], ['fgrep', 2], ['sort', 2], ['xxd', 3], ['sed', 4], ['xargs', 123], ['hexdump', 0], ['tree', 0]])

export function commandWriteError(name, r, ctx) {
  return ctx.closed.out && r.stdout !== '' ? writeError(name, r, ctx) : r
}

export function writeError(name, r, ctx) {
  const status = WRITE_ERROR_STATUS.get(ctx.registry.resolveCommand(name)) ?? 1
  const events = eventsOf(r).filter((event) => event.fd !== 1)
  const message = status === 0 ? '' : `${name}: write error: Bad file descriptor\n`
  if (message) events.push({ fd: 2, text: message })
  const result = { ...r, stdout: '', stderr: r.stderr + message, exitCode: status || r.exitCode, events, unordered: false }
  const note = unsupportedNote(r)
  return note ? markUnsupported(result, note.kind, note.command, note.detail, note.message) : result
}
