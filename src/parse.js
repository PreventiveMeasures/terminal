// Read a command line without running any of it: what the parser made of the
// input, for a caller that wants to look at a line, render it, or hand it to
// an engine of its own. Parsing only, so nothing here knows which commands
// exist, what the filesystem holds, or what any word expands to.
//
// This is the published entry, `@preventive/terminal/parse.js`. There is no
// filesystem on this side, so a redirect is read, never refused: where a line
// may write is a property of a terminal, not of the line. A terminal reads the
// same tree under its own write policy, through `createTerminal(…).parse()`.

import { read } from './parse-tree.js'

export const parse = (line) => read(line, true)
