import { cp } from './cp.js'
import { rm } from './rm.js'
import { mkdir } from './mkdir.js'
import { touch } from './touch.js'
import { ln } from './ln.js'
import { tee } from './tee.js'

// The commands that change the writable overlay, gathered as `fs-tools.js`
// gathers the ones that only read.
export const WRITE_TOOLS = { cp, rm, mkdir, touch, ln, tee }
