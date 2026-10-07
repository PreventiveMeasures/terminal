import { NETWORK_NAMES, RUNTIME_COMMANDS, networkCommands } from './runtime.js'
import { parseArgs } from '../args.js'
import { consumeStdin, encodeUtf8Loose, err, joinLines, lineRecords, ok, okWith, quoteLocale, readInputs, resolve, usageError } from '../util.js'
import { unsupported } from '../unsupported.js'
import { hexdump, od, xxd } from './dump.js'
import { base32 } from './base32.js'
import { base64 } from './base64.js'
import { rg } from './rg.js'
import { cut, nl, tr } from './filters.js'
import { WRITE_TOOLS } from './write-tools.js'

// tac reverses each file separately. Separators stay attached to the preceding
// record, so an unterminated final record in a\nb produces ba\n. A regular
// file on stdin GNU reads from its start, whatever was read of it before and
// however many `-` name it, and leaves it read to its end.
function tac(stdin, tokens, ctx) {
  const { positional } = parseArgs(tokens)
  const names = ctx.stdinFile ? (positional.length ? positional : ['-']).map((name) => (name === '-' ? '/dev/stdin' : name)) : positional
  const r = readInputs('tac', names, stdin, ctx)
  if (ctx.stdinFile && names.includes('/dev/stdin') && !positional.includes('/dev/stdin')) consumeStdin(ctx)
  const out = []
  for (const { content } of r.inputs) out.push(...lineRecords(content).toReversed())
  return okWith(out.join(''), r)
}

// Pipelines buffer whole outputs, so even seq | head needs an allocation limit.
const MAX_SEQ_ELEMENTS = 1_000_000

// One- and two-operand forms always increment by 1; descending output needs an
// explicit negative increment. Integer arithmetic preserves large operands,
// which GNU does too where every operand is plain digits, the step at most
// 200 and the separator one byte; anywhere else it counts in a long double,
// exact to 2^64 and no further, which is past where this goes. Options stop
// at the first operand, or at a word that is a negative number.
const FAST_STEP_LIMIT = 200n
const LONG_DOUBLE_EXACT = 1n << 64n

function seq(_stdin, tokens, ctx) {
  const { flags, values, positional } = parseArgs(tokens, { short: ['w'], valueShort: ['s'], numericOperands: true, stopAtFirstPositional: true })
  const quote = (text) => quoteLocale(text, ctx)
  if (positional.length === 0) return usageError('seq', 'missing operand')
  if (positional.length > 3) return usageError('seq', `extra operand ${quote(positional[3])}`)
  const nums = []
  for (const t of positional) {
    if (/^[ \t\n\r\f\v]*[+-]?nan(?:\(\w*\))?$/iu.test(t)) return usageError('seq', `invalid ${quote('not-a-number')} argument: ${quote(t)}`)
    if (!/^[+-]?\d+$/u.test(t)) {
      if ((Number.isFinite(Number(t)) && t.trim() !== '') || /^[+-]?inf(?:inity)?$/iu.test(t)) return unsupported('feature', 'seq', 'non-integer operands', 'seq: non-integer operands are not supported')
      return usageError('seq', `invalid floating point argument: ${quote(t)}`)
    }
    nums.push(BigInt(t))
    if (nums.length === 2 && positional.length === 3 && nums[1] === 0n) return usageError('seq', `invalid Zero increment value: ${quote(t)}`)
  }
  const first = nums.length === 1 ? 1n : nums[0]
  const incr = nums.length === 3 ? nums[1] : 1n
  const last = nums.at(-1)
  const separator = values.get('s') ?? '\n'
  const fast = positional.every((t) => /^\d+$/u.test(t)) && incr > 0n && incr <= FAST_STEP_LIMIT && !flags.has('w') && encodeUtf8Loose(separator).length === 1
  const inRange = incr > 0 ? first <= last : first >= last
  const count = inRange ? ((last > first ? last - first : first - last) / (incr > 0n ? incr : -incr)) + 1n : 0
  if (count > MAX_SEQ_ELEMENTS) {
    return unsupported('feature', 'seq', 'sequence limit', `seq: range too large: ${count} elements exceeds limit of ${MAX_SEQ_ELEMENTS}`)
  }
  // A long double answers as these integers do while both ends, every value
  // it prints and a step it adds more than once are ones it holds exactly.
  const inexact = (n) => n > LONG_DOUBLE_EXACT || n < -LONG_DOUBLE_EXACT
  const lastPrinted = first + (BigInt(count) - 1n) * incr
  if (!fast && (inexact(first) || inexact(last) || (count > 0 && inexact(lastPrinted)) || (count > 1 && inexact(incr)))) {
    return unsupported('feature', 'seq', 'long double range', 'seq: integers past 2^64 outside its exact digit-by-digit form are not supported')
  }
  // Every value lies between the endpoints; their original spellings bound
  // the padding width, including minus signs and leading zeroes.
  const width = flags.has('w') ? Math.max(...[positional[0], positional.at(-1)].map((v) => v.replace(/^\+/u, '').length)) : 0
  const out = []
  for (let i = 0, n = first; i < count; i++, n += incr) out.push(zeroPad(String(n), width))
  // A long double keeps the sign of a first operand of minus zero.
  if (out.length > 0 && nums.length > 1 && /^-0+$/u.test(positional[0])) out[0] = zeroPad('-0', width)
  // -s changes separators between values, but the final newline is mandatory.
  return ok(out.length === 0 ? '' : out.join(separator) + '\n')
}

function zeroPad(text, width) {
  if (text.length >= width) return text
  const neg = text.startsWith('-')
  const digits = neg ? text.slice(1) : text
  return (neg ? '-' : '') + digits.padStart(width - (neg ? 1 : 0), '0')
}

// Debian's which, a shell script reading options with getopts: a name with a
// slash in it is printed where it is an executable file, and one without is
// looked for along $PATH, which finds the commands themselves in /usr/bin —
// nothing in the tree is executable. A name it does not find it says nothing
// of; the status is 1 if any was not found, or if none was asked about, and
// `-s` prints nothing and answers with the status alone. The shell's own
// builtins are no files, and a path finds a command only in the two
// directories that hold them.
function whichCmd(_stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['s'], stopAtFirstPositional: true })
  const out = []
  let exitCode = positional.length === 0 ? 1 : 0
  for (const name of positional) {
    const path = name.includes('/') ? resolve(ctx.cwd, name) : null
    const command = path === null ? name : /^\/(?:usr\/)?bin\/[^/]+$/u.test(path) && !name.endsWith('/') ? path.slice(path.lastIndexOf('/') + 1) : null
    if (command !== null && command !== '' && ctx.hasCommand(command)) out.push(path === null ? `/usr/bin/${name}` : name)
    else exitCode = 1
  }
  return { stdout: flags.has('s') ? '' : joinLines(out), stderr: '', exitCode }
}

function whoami(_stdin, tokens, ctx) {
  const { positional } = parseArgs(tokens)
  if (positional.length > 0) return usageError('whoami', `extra operand ${quoteLocale(positional[0], ctx)}`)
  return ok((ctx.user ?? 'user') + '\n')
}

// Recognized but unimplemented date directives are diagnosed; unknown ones stay literal.
function date(_stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['u'] })
  if (positional.length > 1) return usageError('date', `extra operand ${quoteLocale(positional[1], ctx)}`)
  let fmt = '%a %b %e %T %Z %Y'
  if (positional.length === 1) {
    // An operand that is no format is a time to set the clock to, in
    // MMDDhhmm[[CC]YY][.ss], which this has no clock to set; GNU calls
    // anything else an invalid date.
    if (/^\d{8}(?:\d{2}){0,2}(?:\.\d{2})?$/u.test(positional[0])) return unsupported('feature', 'date', 'setting the date', 'date: setting the system date is not supported')
    if (!positional[0].startsWith('+')) return err(`date: invalid date ${quoteLocale(positional[0], ctx)}`)
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
