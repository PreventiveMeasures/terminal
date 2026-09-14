// The two methods that read a line and run none of it, over the terminal's own
// write policy: where a line may write belongs to a filesystem, not to a line.

import { read } from './parse-tree.js'
import { summarize } from './summarize.js'

export const reading = (ctx) => ({
  parse: (line) => read(line, ctx.writable),
  summarize: (line) => summarize(line, ctx.writable),
})
