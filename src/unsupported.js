// The diagnostic channel: what THIS terminal does not implement,
// reported beside the pipeline instead of inside it.
//
// The case that motivated it:
//
//   find . -path ./node_modules -prune -o -print 2>/dev/null | head -50
//
// `-prune` was not implemented. `find` said so on stderr, `2>/dev/null`
// discarded the message, and `head` replaced find's exit code with its
// own `0`. What came back was an empty listing and a success status —
// indistinguishable from a tree that genuinely has nothing to print.
//
// Every layer there behaves correctly, which is exactly the problem.
// stderr and the exit status belong to the command, so the shell's
// ordinary plumbing — redirects, pipes, `&&` gates — is free to discard
// them, and a caller mirroring a GNU invocation discards them exactly as
// they would against GNU. The one diagnostic with no GNU counterpart is
// "this terminal does not implement that", and it is the one that must
// not ride a channel the caller has every reason to silence.
//
// So it rides both. The stderr line is unchanged, because it is the
// right thing for a terminal to show a human. The structured copy is
// for the other kind of caller — a tool call, an agent, anything
// driving the terminal programmatically — which needs to distinguish
// "no matches" from "that option does not exist here" without parsing
// prose out of a stream it may well have redirected. `run` returns it
// as its own property, and nothing in a command line can touch it.
//
// Scope is deliberately narrow: GAPS, not failures. A missing file, a
// grep that matched nothing, a `cd` into a non-directory are all things
// GNU reports the same way. Those are the caller's business and belong
// on stderr, where the caller already knows to look.

import { err } from './util.js'

// The classification travels on a NON-ENUMERABLE SYMBOL key rather than
// a field. It rides on two kinds of object that are already contracts:
// the `{ stdout, stderr, exitCode }` results custom.js validates field
// by field (an unknown key there is a wiring bug it throws on), and the
// Errors embedder code throws and catches. Neither may grow a visible
// property.
//
// A symbol alone is not enough. It is invisible to `Object.keys` and to
// `JSON.stringify`, but object spread copies own ENUMERABLE symbol keys
// — and `index.js`'s `finish` builds the RunResult with exactly such a
// spread. Today nothing leaks only because the pipeline happens to
// rebuild the result literal at every stage; the obvious optimization of
// passing a lone stage's result straight through would put this symbol
// in front of the caller. Non-enumerable closes that off for good.
const NOTE = Symbol('unsupported')

// Attach a note to an outgoing `err()` result or a thrown Error.
const mark = (carrier, note) => {
  Object.defineProperty(carrier, NOTE, { value: note, enumerable: false, configurable: true })
  return carrier
}

// The note on a value, or null. Thrown values need not be objects —
// a wired command may `throw 'oops'`, or `throw null` — so this takes
// the same defensive shape as index.js's `reason`: indexing a
// primitive is harmless, indexing null is not, and a getter that
// throws must not unwind the dispatcher.
export function unsupportedNote(carrier) {
  if (carrier === null || carrier === undefined) return null
  try {
    return carrier[NOTE] ?? null
  } catch {
    return null
  }
}

// Build a note. `kind` is one of:
//   'command' — the name is not registered at all.
//   'option'  — a registered command was handed an option it does not
//               implement, or explicitly rejects.
//   'feature' — a construct the parser recognizes that deliberately
//               goes no further: `&` backgrounding, an append redirect
//               against a read-only FS, `sed` outside its one script form.
// `command` is null when the gap is the shell's rather than a command's;
// the dispatcher fills it in for notes thrown out of shared arg parsing,
// which has no way to know whose tokens it was handed.
const note = (kind, command, detail, message) => ({ kind, command, detail, message })

// A command's "I do not implement that" result: the stderr line it
// would have returned anyway, plus the classification that also puts it
// on the feed. `message` is stored without the trailing newline `err`
// adds — a newline is a stream convention, and this is a field.
export function unsupported(kind, command, detail, message, code = 1) {
  return mark(err(message, code), note(kind, command, detail, message))
}

// Carry a gap thrown out of `parseArgs` onto a result the command built
// for itself, instead of letting the dispatcher build it. `grep` is the
// case: its usage failures exit 2 where the dispatcher's generic catch
// would exit 1, so it catches its own parse errors — and without this
// the classification would die in that catch. A throw that carries no
// note is an ordinary error and stays one.
export function unsupportedFrom(e, command, message, code) {
  const found = unsupportedNote(e)
  if (!found) return err(message, code)
  return unsupported(found.kind, command, found.detail, message, code)
}

// The throwing form, for the arg parser and the line parser — neither
// returns a result object to tag. `command` is left for the dispatcher
// to fill in, since `parseArgs` is shared by every command and sees
// only the tokens.
export class UnsupportedError extends Error {
  constructor(kind, detail, message) {
    super(message)
    this.name = 'UnsupportedError'
    mark(this, note(kind, null, detail, message))
  }
}

// The feed itself: an append-only list, deduplicated on identity.
// Deduplication matters because one line can hit the same gap many
// times — `find . -exec frobnicate {} +` dispatches once per matched
// file — and a caller acts on WHICH gaps were hit, never on how often.
// First occurrence wins, so the message keeps the context it was first
// reported in.
export function createUnsupportedFeed() {
  const seen = new Set()
  const entries = []
  return {
    entries,
    // `identity` is the name to deduplicate on when it differs from the
    // one being reported: `ls -t` and `/usr/bin/ls -t` are one gap, but
    // `command` holds the name as TYPED, which differs between them. The
    // dispatcher passes the resolved name; a command reporting its own
    // gap already uses its canonical name and needs no override.
    add(entry, identity = entry.command) {
      // NUL-joined, because the fields can contain spaces — `tr`'s
      // detail is `-d -s` — and a space-joined key would let a
      // different split of the same characters collide.
      const key = `${entry.kind}\u0000${identity ?? ''}\u0000${entry.detail}`
      if (seen.has(key)) return
      seen.add(key)
      entries.push(Object.freeze(entry))
    },
  }
}
