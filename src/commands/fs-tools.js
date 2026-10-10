import { du } from './du.js'
import { find } from './find.js'
import { stat } from './stat.js'
import { realpath } from './realpath.js'
import { diff } from './diff.js'
import { patch } from './patch.js'
import { tree } from './tree.js'

export const FS_TOOLS = { find, tree, du, stat, realpath, diff, patch }
