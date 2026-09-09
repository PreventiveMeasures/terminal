import { parseArgs } from '../args.js'
import { consumeStdin, err, joinLines, lineRecords, ok, okWith, readInputs, splitLines, usage, utf8, utf8Decoder } from '../util.js'
import { unsupported } from '../unsupported.js'
import { hexdump, od, xxd } from './dump.js'
import { INT64_MAX, INT64_MIN, UINT64_MAX } from '../numeric.js'
import { base64 } from './base64.js'
import { rm } from './rm.js'

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

// Unnumbered lines still reserve the number column and separator.
const NL_WIDTH = 6
const NL_SEP = '\t'
const NL_BLANK = ' '.repeat(NL_WIDTH + NL_SEP.length)

function nl(stdin, tokens, ctx) {
  const { values, positional, order } = parseArgs(tokens, { valueShort: ['b', 'v'], valueLong: ['starting-line-number'] })
  const style = values.get('b') ?? 't'
  if (!['a', 't', 'n'].includes(style)) {
    const message = `nl: -b: only \`a\`, \`t\` and \`n\` are supported (got \`${style}\`)`
    // pREGEX is valid but unimplemented; other unknown styles are ordinary errors.
    if (style.startsWith('p')) return unsupported('option', 'nl', '-b p', message)
    return err(message)
  }
  let n = 1n
  for (const { name, value } of order) {
    if (name !== 'v' && name !== 'starting-line-number') continue
    if (!/^[ \t\n\r\f\v]*[+-]?\d+$/u.test(value)) return err(`nl: invalid starting line number: ${value}`)
    n = BigInt(value)
    if (n < INT64_MIN || n > INT64_MAX) return err(`nl: invalid starting line number: ${value}`)
  }
  const r = readInputs('nl', positional, stdin, ctx)
  if (r.inputs.some(({ content }) => /(?:^|\n)(?:\\:){1,3}(?:\n|$)/u.test(content))) return unsupported('feature', 'nl', 'logical pages', 'nl: logical page delimiters are not supported')
  const out = []
  for (const { content } of r.inputs) {
    for (const line of splitLines(content)) {
      if (style === 'a' || (style === 't' && line !== '')) {
        if (n > INT64_MAX) return { stdout: joinLines(out), stderr: r.stderr + 'nl: line number overflow\n', exitCode: 1 }
        out.push(`${String(n).padStart(NL_WIDTH)}${NL_SEP}${line}`)
        n++
      } else {
        out.push(NL_BLANK + line)
      }
    }
  }
  return okWith(joinLines(out), r)
}

// cut emits selected positions in input order, with overlapping ranges deduplicated.
function cut(stdin, tokens, ctx) {
  const { flags, values, positional } = parseArgs(tokens, { short: ['s'], valueShort: ['d', 'f', 'c'] })
  const hasF = values.has('f')
  const hasC = values.has('c')
  if (hasF === hasC) return usage('cut -f LIST [-d DELIM] [-s] [file...]  |  cut -c LIST [file...]')
  if (hasC && values.has('d')) return err('cut: -d is only valid with -f')
  if (hasC && flags.has('s')) return err('cut: -s is only valid with -f')
  const list = parseCutList(hasF ? values.get('f') : values.get('c'))
  if (list.error) return list.error
  const delim = values.get('d') === '' ? '\0' : values.get('d') ?? '\t'
  if (hasF && utf8.encode(delim).length !== 1) return err('cut: -d delimiter must be a single byte')
  const r = readInputs('cut', positional, stdin, ctx)
  const out = []
  for (const { content } of r.inputs) {
    for (const line of hasF && delim === '\n' ? (content === '' ? [] : [content]) : splitLines(content)) {
      // Field mode passes undelimited lines through unless -s was given.
      if (hasF && !line.includes(delim)) {
        if (!flags.has('s')) out.push(line)
        continue
      }
      out.push(hasF ? cutFields(line, delim, list.ranges) : cutBytes(line, list.ranges))
    }
  }
  return okWith(joinLines(out), r)
}

// GNU cut -c selects bytes even in UTF-8 mode. Partial characters must be diagnosed.
function cutBytes(line, ranges) {
  const bytes = utf8.encode(line)
  return utf8Decoder.decode(Uint8Array.from(pickByPositions(bytes, ranges)))
}

function parseCutList(spec) {
  const ranges = []
  for (const part of spec.split(/[, \t]/u)) {
    if (part === '') return { error: err(`cut: empty list item in \`${spec}\``) }
    if ((part.match(/\d+/gu) ?? []).some((n) => BigInt(n) > UINT64_MAX)) return { error: err(`cut: offset is too large: ${part}`) }
    const range = /^(\d*)(?:-(\d*))?$/u.exec(part)
    if (!range || (!range[1] && !range[2])) return { error: err(`cut: invalid list item: ${part}`) }
    const start = range[1] === '' ? 1 : Number(range[1])
    const end = range[2] === undefined ? start : range[2] === '' ? Infinity : Number(range[2])
    if (start < 1) return { error: err('cut: list items must be >= 1') }
    if (end < start) return { error: err(`cut: reversed range: ${part}`) }
    ranges.push([start, end])
  }
  // Normalize once so every record can use ordered, nonoverlapping slices.
  ranges.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1])
    else merged.push(range)
  }
  return { ranges: merged }
}

function pickByPositions(items, ranges) {
  return ranges.flatMap(([start, end]) => Array.from(items.slice(start - 1, end)))
}

function cutFields(line, delim, ranges) {
  const fields = delim === '\n' ? splitLines(line) : line.split(delim)
  return pickByPositions(fields, ranges).join(delim)
}

function tr(stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['c', 'd', 's'] })
  const del = flags.has('d')
  const squeeze = flags.has('s')
  const complement = flags.has('c')
  if (del && squeeze) return unsupported('option', 'tr', '-d -s', 'tr: -d combined with -s is not supported')
  if (squeeze && !del && positional.length === 2) return unsupported('feature', 'tr', 'translate and squeeze', 'tr: combined translation and squeezing is not supported')
  const want = (del || squeeze) ? 1 : 2
  if (positional.length !== want) return usage('tr [-c] SET1 SET2  |  tr [-c] -d SET  |  tr [-c] -s SET')
  if (/\P{ASCII}/u.test(stdin + positional.join(''))) return unsupported('feature', 'tr', 'non-ASCII bytes', 'tr: translation of non-ASCII bytes is not supported')
  if (positional.some((s) => /\[[:.=]|\[[^\]]*\*/u.test(s))) return unsupported('feature', 'tr', 'set expressions', 'tr: character classes, equivalence classes and repetition expressions are not supported')
  if (positional.some((s) => /\\[0-7]{2}|\\[1-7abfrv]/u.test(s))) return unsupported('feature', 'tr', 'set escapes', 'tr: these set escape sequences are not supported')
  if (positional.some((s) => /(?:^|[^\\])(?:\\\\)*\\$/u.test(s))) return unsupported('feature', 'tr', 'trailing backslash', 'tr: an unescaped trailing backslash in a set is not supported')
  const set1 = expandTrSet(positional[0])
  if (set1.error) return set1.error
  const members = new Set(set1.chars)
  // `-c` inverts membership rather than materialising the complement,
  // which would be every byte NOT in SET1.
  const selected = (ch) => complement !== members.has(ch)
  if (del) { consumeStdin(ctx); return ok([...stdin].filter((c) => !selected(c)).join('')) }
  if (squeeze) { consumeStdin(ctx); return ok(squeezeChars(stdin, selected)) }
  const set2 = expandTrSet(positional[1])
  if (set2.error) return set2.error
  if (set2.chars.length === 0) return err('tr: SET2 must not be empty')
  consumeStdin(ctx)
  // Complement order is byte order; either mode pads SET2 with its last byte.
  const from = complement
    ? Array.from({ length: 256 }, (_, i) => String.fromCodePoint(i)).filter((c) => !members.has(c))
    : set1.chars
  const map = new Map()
  const pad = set2.chars.at(-1)
  for (let i = 0; i < from.length; i++) map.set(from[i], set2.chars[i] ?? pad)
  return ok([...stdin].map((c) => map.get(c) ?? c).join(''))
}

function expandTrSet(spec) {
  const chars = []
  let i = 0
  const readUnit = () => {
    if (spec[i] !== '\\') return spec[i++]
    if (i + 1 >= spec.length) return null
    const e = spec[i + 1]
    i += 2
    return e === 'n' ? '\n' : e === 't' ? '\t' : e === '\\' ? '\\' : e === '0' ? '\0' : e
  }
  while (i < spec.length) {
    const c = readUnit()
    if (spec[i] === '-' && i + 1 < spec.length) {
      i++
      const endC = readUnit()
      if (endC === null) return { error: err('tr: trailing backslash in set') }
      const start = c.codePointAt(0)
      const end = endC.codePointAt(0)
      if (end < start) return { error: err(`tr: reversed range: ${c}-${endC}`) }
      for (let cc = start; cc <= end; cc++) chars.push(String.fromCodePoint(cc))
    } else {
      chars.push(c)
    }
  }
  return { chars }
}

function squeezeChars(s, selected) {
  let out = ''
  let prev = null
  for (const c of s) {
    if (selected(c) && c === prev) continue
    out += c
    prev = c
  }
  return out
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

function formatDate(d, fmt, utc) {
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

export const EXTRA_COMMANDS = { cut, tac, tr, seq, nl, which: whichCmd, hexdump, base64, rm }
export const HIDDEN_EXTRAS = { whoami, date, od, xxd }
