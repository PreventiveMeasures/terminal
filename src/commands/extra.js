import { NETWORK_NAMES, RUNTIME_COMMANDS, networkCommands } from './runtime.js'
import { parseArgs } from '../args.js'
import { err, joinLines, lineRecords, ok, okWith, readInputs, usage } from '../util.js'
import { unsupported } from '../unsupported.js'
import { hexdump, od, xxd } from './dump.js'
import { base32 } from './base32.js'
import { base64 } from './base64.js'
import { rg } from './rg.js'
import { cut, nl, tr } from './filters.js'
import { WRITE_TOOLS } from './write-tools.js'

// tac reverses each file separately. Separators stay attached to the preceding
// record, so an unterminated final record in a\nb produces ba\n.
function tac(stdin, tokens, ctx) {
  const { positional } = parseArgs(tokens)
  const r = readInputs('tac', positional, stdin, ctx)
  const out = []
  for (const { content } of r.inputs) out.push(...lineRecords(content).toReversed())
  return okWith(out.join(''), r)
}

// Pipelines buffer whole outputs, so even seq | head needs an allocation limit.
const MAX_SEQ_ELEMENTS = 1_000_000

// One- and two-operand forms always increment by 1; descending output needs an
// explicit negative increment. Integer arithmetic preserves large operands.
function seq(_stdin, tokens) {
  const { flags, values, positional } = parseArgs(tokens, { short: ['w'], valueShort: ['s'], numericOperands: true })
  if (positional.length === 0 || positional.length > 3) {
    return usage('seq [-w] [-s SEP] LAST  |  seq FIRST LAST  |  seq FIRST INCR LAST')
  }
  const nums = []
  for (const t of positional) {
    if (!/^[+-]?\d+$/u.test(t)) {
      if ((Number.isFinite(Number(t)) && t.trim() !== '') || /^[+-]?inf(?:inity)?$/iu.test(t)) return unsupported('feature', 'seq', 'non-integer operands', 'seq: non-integer operands are not supported')
      return err(`seq: invalid integer: ${t}`)
    }
    nums.push(BigInt(t))
  }
  const first = nums.length === 1 ? 1n : nums[0]
  const incr = nums.length === 3 ? nums[1] : 1n
  const last = nums.at(-1)
  if (incr === 0n) return err('seq: increment must be non-zero')
  const inRange = incr > 0 ? first <= last : first >= last
  const count = inRange ? ((last > first ? last - first : first - last) / (incr > 0n ? incr : -incr)) + 1n : 0
  if (count > MAX_SEQ_ELEMENTS) {
    return unsupported('feature', 'seq', 'sequence limit', `seq: range too large: ${count} elements exceeds limit of ${MAX_SEQ_ELEMENTS}`)
  }
  // Every value lies between the endpoints; their original spellings bound
  // the padding width, including minus signs and leading zeroes.
  const width = flags.has('w') ? Math.max(...[positional[0], positional.at(-1)].map((v) => v.replace(/^\+/u, '').length)) : 0
  const out = []
  for (let i = 0, n = first; i < count; i++, n += incr) out.push(zeroPad(String(n), width))
  // -s changes separators between values, but the final newline is mandatory.
  return ok(out.length === 0 ? '' : out.join(values.get('s') ?? '\n') + '\n')
}

function zeroPad(text, width) {
  if (text.length >= width) return text
  const neg = text.startsWith('-')
  const digits = neg ? text.slice(1) : text
  return (neg ? '-' : '') + digits.padStart(width - (neg ? 1 : 0), '0')
}

// which checks bare registered external commands; it does not resolve binary-path aliases.
function whichCmd(_stdin, tokens, ctx) {
  const { positional } = parseArgs(tokens)
  if (positional.length === 0) return usage('which COMMAND...')
  const out = []
  let exitCode = 0
  for (const name of positional) {
    if (ctx.hasCommand(name)) out.push(`/usr/bin/${name}`)
    else { out.push(`${name} not found`); exitCode = 1 }
  }
  return { stdout: joinLines(out), stderr: '', exitCode }
}

function whoami(_stdin, tokens, ctx) {
  const { positional } = parseArgs(tokens)
  if (positional.length > 0) return err(`whoami: extra operand: ${positional[0]}`)
  return ok((ctx.user ?? 'user') + '\n')
}

// Recognized but unimplemented date directives are diagnosed; unknown ones stay literal.
function date(_stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['u'] })
  if (positional.length > 1) return err(`date: at most one +FORMAT argument is supported (got: ${positional[1]})`)
  let fmt = '%a %b %e %T %Z %Y'
  if (positional.length === 1) {
    if (!positional[0].startsWith('+')) return usage('date [-u] [+FORMAT]')
    fmt = positional[0].slice(1)
  }
  if ((fmt.match(/%./gu) ?? []).some((s) => /%[-_0^#0-9:EOcCDgGhIjklNpPrRuUVwWxXy+]/u.test(s))) return unsupported('feature', 'date', 'format', 'date: this format directive or modifier is not supported')
  return ok(formatDate(new Date(), fmt, flags.has('u') || ctx.vars.has('TZ')) + '\n')
}

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function formatDate(d, fmt, utc) {
  const getter = 'get' + (utc ? 'UTC' : '')
  const [year, month, day, hour, minute, second, weekday] = ['FullYear', 'Month', 'Date', 'Hours', 'Minutes', 'Seconds', 'Day'].map((field) => d[getter + field]())
  const pad = (n, c = '0') => String(n).padStart(2, c)
  const formats = {
    __proto__: null,
    Y: String(year), m: pad(month + 1), d: pad(day), e: pad(day, ' '),
    H: pad(hour), M: pad(minute), S: pad(second),
    T: [hour, minute, second].map((n) => pad(n)).join(':'),
    F: [year, pad(month + 1), pad(day)].join('-'),
    q: String(Math.floor(month / 3) + 1), s: String(Math.floor(d.getTime() / 1000)),
    a: DAYS_SHORT[weekday], A: DAYS_LONG[weekday],
    b: MONTHS_SHORT[month], B: MONTHS_LONG[month],
    // Query host timezone data only when the format actually requests it.
    Z: () => tzName(d, utc), z: () => tzOffset(d, utc),
    n: '\n', t: '\t', '%': '%',
  }
  return fmt.replace(/%./gu, (match) => {
    const value = formats[match[1]]
    return typeof value === 'function' ? value() : value ?? match
  })
}

// formatToParts preserves offset-style zone names such as GMT+5:30.
function tzName(d, utc) {
  if (utc) return 'UTC'
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d)
    const part = parts.find((p) => p.type === 'timeZoneName')
    return part?.value ?? 'Local'
  } catch { return 'Local' }
}

function tzOffset(d, utc) {
  if (utc) return '+0000'
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`
}

export const EXTRA_COMMANDS = { rg, cut, tac, tr, seq, nl, which: whichCmd, hexdump, base64, ...WRITE_TOOLS }
// `gzip` is here for the same reason the others are: it answers where it can,
// and is not one of the commands this terminal offers.
// What the runtime does rather than this code — the compressors, the digests
// — is there only where the runtime can do it, and nothing at all where it
// cannot.
export const HIDDEN_EXTRAS = { whoami, date, od, xxd, base32, ...RUNTIME_COMMANDS }
// What a network adds, for the registry to ask for: the one thing here that
// is not in a table, since a terminal has it only where it asked for it.
export { NETWORK_NAMES, networkCommands }
