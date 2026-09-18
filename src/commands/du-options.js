import { parseArgs } from '../args.js'
import { INT64_MAX, UINT64_MAX } from '../numeric.js'
import { UnsupportedError } from '../unsupported.js'

const ALIASES = new Map(Object.entries({
  all: 'a', 'apparent-size': 'A', bytes: 'b', total: 'c', null: '0', 'count-links': 'l',
  summarize: 's', 'separate-dirs': 'S', 'human-readable': 'h', 'max-depth': 'd', 'block-size': 'B',
  dereference: 'L', 'dereference-args': 'D', 'no-dereference': 'P',
}))

export function duOptions(tokens, ctx) {
  const parsed = parseArgs(tokens, {
    // `-A` is the BSD/macOS spelling of GNU's long-only `--apparent-size`.
    short: ['0', 'a', 'A', 'b', 'c', 'h', 'H', 'k', 'l', 'm', 's', 'S', 'L', 'D', 'P'],
    long: [...ALIASES.keys()].filter((name) => !['d', 'B'].includes(ALIASES.get(name))).concat(['inodes', 'si']),
    valueShort: ['d', 'B'], valueLong: ['max-depth', 'block-size'],
  })
  const options = { operands: parsed.positional.length ? parsed.positional : ['.'], depth: Infinity, flags: new Set(), scale: null, stderr: '' }
  for (const { name, value } of parsed.order) {
    const flag = ALIASES.get(name) ?? name
    options.flags.add(flag)
    if (flag === 'd') options.depth = depthOption(value)
    if (flag === 'B') options.scale = blockSize(value)
    if (flag === 'b') { options.flags.add('A'); options.scale = { unit: 1n } }
    if (flag === 'k' || flag === 'm') options.scale = { unit: flag === 'k' ? 1024n : 1024n ** 2n }
    if (flag === 'h' || flag === 'si') options.scale = { base: flag === 'h' ? 1024n : 1000n, unit: 1n }
  }
  const { flags } = options
  if (flags.has('a') && flags.has('s')) throw new Error('cannot both summarize and show all entries')
  if (flags.has('s') && flags.has('d')) {
    if (options.depth !== 0) throw new Error(`summarizing conflicts with --max-depth=${options.depth}`)
    options.stderr += 'du: warning: summarizing is the same as using --max-depth=0\n'
  }
  if (flags.has('s')) options.depth = 0
  if (flags.has('inodes') && flags.has('A')) options.stderr += 'du: warning: options --apparent-size and -b are ineffective with --inodes\n'
  if (!options.scale) {
    const configured = ctx.vars.get('DU_BLOCK_SIZE') ?? ctx.vars.get('BLOCK_SIZE') ?? ctx.vars.get('BLOCKSIZE')
    try {
      options.scale = configured === undefined ? { unit: ctx.vars.has('POSIXLY_CORRECT') ? 512n : 1024n } : blockSize(configured)
    } catch (e) {
      if (e instanceof UnsupportedError) throw e
      throw new UnsupportedError('feature', 'invalid block size environment', 'invalid block size environment settings are not supported')
    }
  }
  if (flags.has('inodes')) options.scale = { ...options.scale, unit: 1n, suffix: options.scale.suffix?.endsWith('B') ? 'B' : '' }
  if (options.scale.base) humanScale(ctx, options.scale.base)
  return options
}

// `-h` rounds up to one decimal in the C locale; another numeric locale would
// write the decimal point differently, so it is refused rather than guessed.
export function humanScale(ctx, base = 1024n) {
  const locale = ctx.vars.get('LC_ALL') || ctx.vars.get('LC_NUMERIC') || ctx.vars.get('LANG') || 'C'
  if (!/^(?:C|POSIX|C\.(?:UTF-?8))$/iu.test(locale)) throw new UnsupportedError('feature', 'numeric locale', 'human-readable sizes in this numeric locale are not supported')
  return { base, unit: 1n }
}

function depthOption(value) {
  const match = /^[ \t\n\r\v\f]*([+-]?)(0[xX][\da-fA-F]+|0[0-7]*|[1-9]\d*)$/u.exec(value)
  if (!match) throw new Error(`invalid maximum depth: ${value}`)
  const depth = unsignedInteger(match[2])
  if (depth > INT64_MAX || match[1] === '-' && depth !== 0n) throw new Error(`invalid maximum depth: ${value}`)
  return Number(depth)
}

function unsignedInteger(value) {
  return BigInt(/^0[0-7]+$/u.test(value) ? '0o' + value : value)
}

function blockSize(value) {
  const automatic = value && ['human-readable', 'si'].find((mode) => mode.startsWith(value))
  if (automatic) return { base: automatic === 'si' ? 1000n : 1024n, unit: 1n }
  if (value.startsWith("'")) throw new UnsupportedError('feature', 'grouped block sizes', 'grouped block sizes are not supported')
  const match = /^[ \t\n\r\v\f]*\+?(0[xX][\da-fA-F]+|0[0-7]*|[1-9]\d*)?([kKmMgGtTPEZYRQ](?:i?B|D)?)?$/u.exec(value)
  if (!match || !match[1] && value !== match[2]) throw new Error(`invalid block size: ${value}`)
  const suffix = match[2] ?? ''
  const power = suffix ? 'KMGTPEZYRQ'.indexOf(suffix[0].toUpperCase()) + 1 : 0
  const base = /[BD]$/u.test(suffix) && !suffix.endsWith('iB') ? 1000n : 1024n
  const unit = (match[1] ? unsignedInteger(match[1]) : 1n) * base ** BigInt(power)
  if (unit === 0n || unit > UINT64_MAX) throw new Error(`invalid block size: ${value}`)
  const label = match[1] || !suffix ? '' : (power === 1 && suffix.endsWith('B') && base === 1000n ? 'k' : suffix[0].toUpperCase()) + (suffix.endsWith('B') ? base === 1000n ? 'B' : 'iB' : '')
  return { unit, suffix: label }
}

const ceiling = (size, unit) => (size + unit - 1n) / unit

export function duSize(size, { base, unit, suffix = '' }) {
  if (!base) return String(ceiling(size, unit)) + suffix
  let divisor = 1n, power = 0
  while (size >= divisor * base) { divisor *= base; power++ }
  if (!power) return String(size)
  let rounded = ceiling(size * 10n, divisor)
  let text
  if (rounded < 100n) text = `${rounded / 10n}.${rounded % 10n}`
  else {
    rounded = ceiling(size, divisor)
    if (rounded === base) { power++; text = '1.0' }
    else text = String(rounded)
  }
  return text + (power === 1 && base === 1000n ? 'k' : 'KMGTPEZYRQ'[power - 1])
}
