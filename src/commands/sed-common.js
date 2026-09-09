import { UnsupportedError } from '../unsupported.js'

export const SED_SUBSET = 'sed: only addressed p, d, a, i, c, q, =, y, { } and s/regexp/replacement/[Npg] scripts are supported'
export function scriptGap(detail = 'script') { throw new UnsupportedError('feature', detail, SED_SUBSET) }
