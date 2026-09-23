// What a tar run has said so far, and how it ends, as GNU tar ends one: an
// error is reported and the run goes on, to end on "Exiting with failure
// status due to previous errors" and status 2; a fatal one is reported with
// "Error is not recoverable: exiting now" and ends the run where it is; a
// warning changes nothing. Everything is kept in the order it was said, so
// a listing and the complaints between its lines read as GNU's do.
//
// A gap is where this terminal cannot go on as GNU would: the run ends
// there, with what it had already done kept and the gap reported over it.

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
    say(fd, text) { state.events.push({ fd, text }) },
    list(line) { state.say(state.listTo, line + '\n') },
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
  const text = (fd) => state.events.filter((event) => event.fd === fd && event.text !== undefined).map((event) => event.text).join('')
  const result = { stdout: text(1), stderr: text(2), exitCode: state.status, events: state.events }
  if (state.gap === null) return result
  return markUnsupported(result, state.gap.kind, 'tar', state.gap.detail, state.gap.message)
}
