import { parseArgs } from '../args.js'
import { err, okWith, readInputs } from '../util.js'
import { unsupported } from '../unsupported.js'

// The digest itself is the runtime's work rather than this code's:
// `crypto.subtle` does it, and it answers asynchronously, which a line waits
// for where it meets it. A runtime without it does not carry these commands
// at all, as it does not carry a compressor whose format it cannot do.
//
// What they print is coreutils' and Digest::SHA's own, recorded from
// sha256sum 9.4 and shasum 6.02: the digest, two spaces or a space and a
// star, and the name — `-` for what came in on stdin.

// What a runtime's crypto digests, by the number these commands name it with.
const ALGORITHMS = Object.freeze({ __proto__: null, 1: 'SHA-1', 256: 'SHA-256', 384: 'SHA-384', 512: 'SHA-512' })
// What `shasum -a` takes, which is more than any Web Crypto does.
const SHASUM_ALGORITHMS = Object.freeze(['1', '224', '256', '384', '512', '512224', '512256'])

const digestAvailable = () => {
  try { return typeof crypto?.subtle?.digest === 'function' } catch { return false }
}

async function digest(algorithm, bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest(algorithm, bytes))
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// coreutils names one digest per command; shasum takes the number as `-a`,
// and SHA-1 where it is not given one.
function chosen(cmd, bits, values) {
  const asked = cmd === 'shasum' ? values.get('a') ?? '1' : String(bits)
  if (cmd === 'shasum' && !SHASUM_ALGORITHMS.includes(asked)) {
    return { error: err(`${cmd}: Unrecognized algorithm\nType shasum -h for help\n`, 1) }
  }
  const algorithm = ALGORITHMS[asked]
  if (algorithm === undefined) {
    return { error: unsupported('feature', cmd, `SHA-${asked}`, `${cmd}: this runtime's crypto does not digest SHA-${asked}`, 1) }
  }
  return { algorithm }
}

function sums(cmd, bits) {
  return async (stdin, tokens, ctx) => {
    const { flags, values, positional } = parseArgs(tokens, {
      short: cmd === 'shasum' ? ['b', 't', 'c'] : ['b', 't', 'c', 'z'],
      long: cmd === 'shasum' ? ['binary', 'text', 'check', 'tag'] : ['binary', 'text', 'check', 'tag', 'zero'],
      valueShort: cmd === 'shasum' ? ['a'] : [],
    })
    // Reading a list of digests back is a command of its own inside this one,
    // and this is not it.
    if (flags.has('c') || flags.has('check')) {
      return unsupported('feature', cmd, '-c', `${cmd}: reading a list of digests back is not supported`, 1)
    }
    const { algorithm, error } = chosen(cmd, bits, values)
    if (error) return error
    const r = readInputs(cmd, positional, stdin, ctx, { read: 'bytes' })
    // One digest does not wait for the last: what they are of is already read.
    const digests = await Promise.all(r.inputs.map((input) => digest(algorithm, input.bytes)))
    const line = format(algorithm, flags)
    return okWith(r.inputs.map((input, at) => line(digests[at], input.name ?? '-')).join(''), r)
  }
}

// `--tag` writes the BSD form, which says which digest it is and marks
// nothing about how the file was read; otherwise the mode is the space or the
// star between the two.
function format(algorithm, flags) {
  const end = flags.has('z') || flags.has('zero') ? '\0' : '\n'
  if (flags.has('tag')) {
    const label = algorithm.replace('-', '')
    return (hash, name) => `${label} (${name}) = ${hash}${end}`
  }
  const mode = flags.has('b') || flags.has('binary') ? ' *' : '  '
  return (hash, name) => `${hash}${mode}${name}${end}`
}

// Only where the runtime can do the work, as with a compressor: a terminal
// whose crypto cannot digest does not carry the commands that would.
export const SHA = digestAvailable()
  ? { sha1sum: sums('sha1sum', 1), sha256sum: sums('sha256sum', 256), sha384sum: sums('sha384sum', 384), sha512sum: sums('sha512sum', 512), shasum: sums('shasum', 1) }
  : {}
