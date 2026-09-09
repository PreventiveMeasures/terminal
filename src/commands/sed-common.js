import { UnsupportedError, unsupported, unsupportedFrom } from '../unsupported.js'

export const SED_SUBSET = 'sed: supported commands are p, P, n, N, d, a, i, c, q, =, y, :, b, t, T, { }, and s/regexp/replacement/[Npgw]'
export const MAX_SED_STEPS = 1_000_000
export const MAX_SED_SPACE = 16 * 1024 * 1024
export const MAX_SED_OUTPUT = 64 * 1024 * 1024
export function scriptGap(detail = 'script') { throw new UnsupportedError('feature', detail, SED_SUBSET) }

export function sedFailure(e) {
  if (e.gap) return unsupported('feature', 'sed', e.gap, `sed: ${e.message}`)
  if (e instanceof RangeError) return unsupported('feature', 'sed', 'regex runtime limit', `sed: ${e.message}`)
  return unsupportedFrom(e, 'sed', `sed: ${e.message.replace(/^sed: /u, '')}`, e.exitCode)
}
