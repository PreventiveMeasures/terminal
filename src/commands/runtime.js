// The commands whose work is the runtime's rather than this code's: a
// compression stream, a digest. Each is registered only where the runtime can
// do what it is for, and is nothing at all where it cannot — the name is not
// found, as it was before the command was written.

import { BROTLI } from './brotli.js'
import { GZIP } from './gzip.js'
import { SHA } from './sha.js'

export const RUNTIME_COMMANDS = { ...GZIP, ...BROTLI, ...SHA }
