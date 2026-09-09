import { UnsupportedError, markUnsupported, unsupportedNote } from '../unsupported.js'
import { eventsOf } from './output.js'

// Readers are streaming by default. These commands either buffer their input
// before stdout or, in cat's case, validate GNU's input/output offset rules.
const BUFFERED = new Set(['sort', 'cat'])
const PER_FILE = new Set(['wc', 'tac'])

export function createIoGuard(fs) {
  let active = null
  let output = null
  const read = (identity) => { if (active && !active.bufferReads) active.reads.push(identity) }
  const check = (identity) => {
    if (identity === undefined) return
    for (let scope = active; scope; scope = scope.parent) {
      if (!scope.reads.includes(identity)) continue
      if (scope === active && output?.scope === scope) {
        if (output.unsupported) continue
        if (scope.buffered || output.fd === 1 && (BUFFERED.has(scope.name) || PER_FILE.has(scope.name) && !scope.reads.slice(1).includes(identity))) continue
      }
      if (scope.failure) throw scope.failure
      const diagnostics = scope === active && output?.fd === 2
      const detail = diagnostics ? 'input modified by diagnostics' : 'streaming self-output'
      const message = diagnostics ? 'reading input while diagnostics write to the same file is not supported'
        : 'writing to an actively read input file is not supported'
      scope.failure = markUnsupported(new UnsupportedError('feature', detail, message), 'feature', scope.name, detail, message)
      throw scope.failure
    }
  }
  fs.observeIo?.({ read, write: check })
  return {
    read,
    bufferOutput() { if (active) active.buffered = true },
    bufferReads(fn) {
      if (!active) return fn()
      const scope = active
      const previous = scope.bufferReads
      scope.bufferReads = true
      try { return fn() } finally { scope.bufferReads = previous }
    },
    setReads(identities) { if (active) active.reads = identities },
    run(name, fn) {
      const parent = active
      active = { name, reads: [], parent }
      try { return fn() } finally { active = parent }
    },
    output(result, io, fn) {
      const previous = output
      output = { scope: active, fd: null, unsupported: Boolean(unsupportedNote(result)) }
      try {
        // Validate every destination before emitting any part of a result.
        for (const event of eventsOf(result)) {
          if (event.text === '') continue
          output.fd = event.fd
          check(io.fds[event.fd]?.identity)
        }
        return fn((event, handle) => {
          output.fd = event.fd
          handle.write(event.text)
        })
      } finally { output = previous }
    },
  }
}
