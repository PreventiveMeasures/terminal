// Preserve command order when a surrounding group merges its streams.
// A handler returning both streams has not specified their relative order.
import { markUnsupported, unsupported, unsupportedNote } from '../unsupported.js'
import { decodeUtf8 } from '../bytes.js'
import { discardedStderr } from '../notes.js'

// An event carries text, or the bytes a command wrote where no text spells
// them: a dump of a file, a member a stream inflated. Where they are going
// decides what becomes of them — a file and a pipe take the bytes, and a
// terminal carrying its output as a string takes the text they spell, or
// reports that they spell none.
export const textOf = (event) => event.text ?? decodeUtf8(event.bytes)
export const writeEvent = (event, handle) => {
  if (event.bytes === undefined) handle.write(event.text)
  else handle.writeBytes(event.bytes)
}

export const eventsOf = (r) => r.events ?? [
  ...(r.stdout ? [{ fd: 1, text: r.stdout }] : []),
  ...(r.stderr ? [{ fd: 2, text: r.stderr }] : []),
]
export const unorderedOutput = (r) => r.unordered ?? (!r.events && r.stdout !== '' && r.stderr !== '')

// Command lists and loops accumulate output with the same event ordering.
export const emptyOutput = (stderr = '') => ({
  stdout: '', stderr, exitCode: 0, ignored: false,
  events: stderr ? [{ fd: 2, text: stderr }] : [], unordered: false,
})

export function appendOutput(result, next) {
  result.stdout += next.stdout
  result.stderr += next.stderr
  result.exitCode = next.exitCode
  // A status `set -e` was told to ignore is carried by the status, so it
  // travels with it: taking one as your own takes what it is worth.
  result.ignored = next.ignored ?? false
  result.events.push(...eventsOf(next))
  result.unordered ||= unorderedOutput(next)
}

// Capture diagnostics at the expansion site, before later redirects change fd 2.
export function expansionStderr(ctx, stderr) {
  if (stderr) appendOutput(ctx.expansionOutput, routeOutput(emptyOutput(stderr), { fds: ctx.expansionFds }, ctx))
}

export function routeOutput(result, io, ctx) {
  const run = (write) => routeEvents(result, io, ctx, write)
  return ctx.io ? ctx.io.output(result, io, run) : run(writeEvent)
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
    // Bytes on their way somewhere else wait for the router that writes it,
    // which is the one that can hand them over as the bytes they are — or
    // drop them, which needs them to be no more readable than this does.
    if (io.deferred?.[e.fd] && e.bytes !== undefined) { events.push(e); continue }
    if (dest !== 'out' && dest !== 'err') {
      // A diagnostic sent to /dev/null or a closed descriptor reaches nobody.
      if (e.fd === 2) discardedStderr(ctx, textOf(e))
      continue
    }
    // Past here the output is the caller's to read as a string, so bytes
    // that spell no text have nowhere to go, and say so.
    const text = textOf(e)
    events.push({ fd: dest === 'out' ? 1 : 2, text })
    if (dest === 'out') stdout += text
    else stderr += text
  }
  return { ...r, stdout, stderr, events, unordered: unorderedOutput(r) && stdout !== '' && stderr !== '' }
}

// Commands differ in closed-stdout status; hexdump and tree ignore the failure.
const WRITE_ERROR_STATUS = new Map([['ls', 2], ['grep', 2], ['egrep', 2], ['fgrep', 2], ['sort', 2], ['xxd', 3], ['sed', 4], ['diff', 2], ['patch', 2], ['xargs', 123], ['hexdump', 0], ['tree', 0]])

// What a command wrote to stdout, which is a string for most of them and the
// bytes themselves for the few that write what no string spells. Both are
// output, and writing either to a closed descriptor is the same failure.
const wroteOut = (r) => r.stdout !== '' || eventsOf(r).some((e) => e.fd === 1 && (e.bytes?.length ?? 0) > 0)

export function commandWriteError(name, r, ctx) {
  return ctx.closed.out && wroteOut(r) ? writeError(name, r, ctx) : r
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
