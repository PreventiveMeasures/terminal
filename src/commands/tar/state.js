// What a tar run has said so far, and how it ends, as GNU tar ends one: an
// error is reported and the run goes on, to end on "Exiting with failure
// status due to previous errors" and status 2; a fatal one is reported with
// "Error is not recoverable: exiting now" and ends the run where it is; a
// warning changes nothing. Everything is kept in the order it was said, so
// a listing and the complaints between its lines read as GNU's do.
//
// A gap is where this terminal cannot go on as GNU would: the run ends
// there, with what it had already done kept and the gap reported over it.
//
// A closed stdout is GNU's too: it opens /dev/null there for reading, so
// every write to it fails. A listing is lost, and said to be lost once the
// run has ended as it would (close_stdout); a fatal error ends it first.
// GNU flushes each entry's line as it lists it, and not the line of a
// directory it made, which is still waiting to be written at the end when it
// was the last: close_stdout then says why the write failed.

import { markUnsupported } from '../../unsupported.js'

export function tarState(ctx) {
  const state = {
    ctx,
    events: [],
    status: 0,
    stopped: false,
    gap: null,
    // Listing lines go to stdout, unless stdout is where the archive or the
    // files are going, which puts them on stderr (GNU's stdlis).
    listTo: 1,
    closedOut: ctx.closed?.out === true,
    // null, or whether the last listing line lost was flushed or is pending.
    lostListing: null,
    say(fd, text) { state.events.push({ fd, text }) },
    list(line, flushed = true) {
      if (state.listTo === 1 && state.closedOut) state.lostListing = flushed ? 'flushed' : 'pending'
      else state.say(state.listTo, line + '\n')
    },
    bytes(bytes) { state.events.push({ fd: 1, bytes }) },
    warn(message) { state.say(2, `tar: ${message}\n`) },
    error(message) { state.warn(message); state.status = 2 },
    fatal(message) {
      state.warn(message)
      state.warn('Error is not recoverable: exiting now')
      state.status = 2
      state.stopped = true
    },
    // A gap ends the run as a fatal error would, reporting what this
    // terminal cannot do rather than anything GNU says.
    refuse(kind, detail, message) {
      state.warn(message)
      state.gap = { kind, detail, message: `tar: ${message}` }
      state.status = 2
      state.stopped = true
    },
  }
  return state
}

export function tarResult(state) {
  if (!state.stopped && state.status === 2) state.warn('Exiting with failure status due to previous errors')
  if (!state.stopped && state.lostListing !== null) {
    state.warn(state.lostListing === 'pending' ? 'stdout: write error: Bad file descriptor' : 'stdout: write error')
    state.status = 2
  }
  const text = (fd) => state.events.filter((event) => event.fd === fd && event.text !== undefined).map((event) => event.text).join('')
  const result = { stdout: text(1), stderr: text(2), exitCode: state.status, events: state.events }
  if (state.gap === null) return result
  return markUnsupported(result, state.gap.kind, 'tar', state.gap.detail, state.gap.message)
}
