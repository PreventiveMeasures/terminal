// The commands whose work is the runtime's rather than this code's: a
// compression stream, a digest, a request. Each is registered only where the
// runtime can do what it is for, and is nothing at all where it cannot — the
// name is not found, as it was before the command was written.
//
// A request has a second condition the others do not, because it is the one
// that leaves this package: the caller has to have asked for a terminal with
// a network (../net.js). So it is handed out by a call rather than standing
// in a table, since what a terminal can run is settled when it is created.

import { BROTLI } from './brotli.js'
import { GZIP } from './gzip.js'
import { SHA } from './sha.js'
import { curl } from './curl.js'
import { networkUsable } from '../net.js'

export const RUNTIME_COMMANDS = { ...GZIP, ...BROTLI, ...SHA }

const NETWORK_COMMANDS = Object.freeze({ __proto__: null, curl })
export const NETWORK_NAMES = Object.freeze(Object.keys(NETWORK_COMMANDS))

// What a network adds to a registry, and the two reasons it may add nothing:
// the caller did not ask for one, or the runtime has no `fetch` to make a
// request with. A name that is missing says which of the two it was.
export const networkState = (asked) => Object.freeze({
  asked: asked === true,
  usable: networkUsable(),
  commands: asked === true && networkUsable() ? NETWORK_COMMANDS : null,
})
