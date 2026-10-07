import { UnsupportedError, markUnsupported, unsupportedNote } from '../unsupported.js'
import { eventsOf, writeEvent } from './output.js'

// Readers are streaming by default. These commands either buffer their input
// before stdout or, in cat's case, validate GNU's input/output offset rules.
const BUFFERED = new Set(['sort', 'cat'])
const PER_FILE = new Set(['wc', 'tac'])

// The stages of a pipeline run side by side, so a file one of them writes
// while another reads it holds whatever the scheduler let through first:
// GNU's answer is a race, and this one, which runs them in turn, would be
// one of its outcomes passed off as the answer.
const raceMessage = 'a pipeline stage writing a file another stage of the same pipeline reads is not supported'

// The pipelines running, outermost first, each with the stage it is in and
// which of its stages read and wrote which file. `sort` writes only once it
// has read all it was handed, and so after every stage ahead of it is done:
// its write races only a stage after it.
function pipelineTracker() {
  const pipelines = []
  return {
    touch(identity, kind, writer) {
      const sorted = kind === 'write' && writer === 'sort'
      for (const pipeline of pipelines) {
        const others = (kind === 'read' ? pipeline.writes : pipeline.reads).get(identity)
        if (others && [...others].some((stage) => stage !== pipeline.stage && !(sorted && stage < pipeline.stage))) throw new UnsupportedError('feature', 'pipeline file race', raceMessage)
        const mine = kind === 'read' ? pipeline.reads : pipeline.writes
        if (!mine.has(identity)) mine.set(identity, new Set())
        mine.get(identity).add(pipeline.stage)
      }
    },
    // Run a pipeline's stages through fn, which says which stage it is in.
    async run(fn) {
      const pipeline = { stage: 0, reads: new Map(), writes: new Map() }
      pipelines.push(pipeline)
      try { return await fn((stage) => { pipeline.stage = stage }) } finally { pipelines.splice(pipelines.indexOf(pipeline), 1) }
    },
  }
}

export function createIoGuard(fs) {
  let active = null
  let output = null
  let stdinWatch = null
  const pipelines = pipelineTracker()
  const read = (identity) => {
    // Stdin with no file behind it is read without an identity, and the
    // shell watching for that read is told of it.
    if (identity === undefined && stdinWatch) stdinWatch.read = true
    if (identity !== undefined) pipelines.touch(identity, 'read')
    if (active && !active.bufferReads) active.reads.push(identity)
  }
  const check = (identity) => {
    if (identity === undefined) return
    pipelines.touch(identity, 'write', active?.name)
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
    pipeline: pipelines.run,
    // Whether what fn runs reads its stdin at all.
    async watchStdin(fn) {
      const previous = stdinWatch
      const watch = stdinWatch = { read: false }
      try { return { result: await fn(), read: watch.read } } finally { stdinWatch = previous }
    },
    async run(name, fn) {
      const parent = active
      active = { name, reads: [], parent }
      try { return await fn() } finally { active = parent }
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
          writeEvent(event, handle)
        })
      } finally { output = previous }
    },
  }
}
