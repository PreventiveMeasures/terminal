// head and tail: the first or last of each input, by lines or by bytes, with
// the obsolete spellings both still take and a banner per named operand.

import { unsupported } from '../unsupported.js'
import { parseArgs } from '../args.js'
import { UINT64_MAX } from '../numeric.js'
import { consumeStdin, decodeUtf8, encodeUtf8Loose, err, inputLabel, ok, okWith, parseSignedCount, quoteLocale, readInputs, usageError } from '../util.js'

// head and tail share count syntax, byte/line slicing and operand presentation.
export function headTail(cmd, stdin, tokens, ctx) {
  const isHead = cmd === 'head'
  const old = isHead ? obsoleteHead(tokens) : obsoleteTail(tokens, ctx)
  if (old?.error) return old.error
  let banner = null, count, positional, unit
  if (old?.files) ({ unit, count, files: positional } = old)
  else {
    const args = old?.tokens ?? tokens
    const digit = digitOption(args)
    if (digit) return isHead ? usageError('head', `invalid trailing option -- ${digit}`) : err(`tail: option used in invalid context -- ${digit}`)
    const parsed = parseArgs(args, { short: ['q', 'v'], valueShort: ['c', 'n'] })
    positional = parsed.positional
    unit = parsed.order.findLast((o) => o.name === 'n' || o.name === 'c')?.name ?? 'n'
    count = parseSignedCount(parsed.values.get(unit) ?? '10', cmd, unit, ctx)
    if (count.error) return count.error
    const header = parsed.order.findLast((o) => o.name === 'q' || o.name === 'v')
    banner = header ? header.name === 'v' : null
  }
  const fromStart = count.sign === '+'
  // head opens zero-count operands; tail's last-zero form opens nothing.
  if (isHead && count.value === 0 && count.sign !== '-') {
    return takeFrom(cmd, stdin, positional, ctx, () => '', { unit, banner, leftover: (content) => content, readOptions: { noRead: true } })
  }
  if (!isHead && count.value === 0 && !fromStart) {
    // A file snapshot may be stale; only buffered pipes can be counted unread.
    if (!ctx.stdinFile && (!positional.length || positional.includes('-') || positional.includes('/dev/stdin'))) {
      const note = truncationNote(cmd, stdin, '', unit, 'standard input')
      if (note) ctx.notes.add(note)
    }
    return ok()
  }
  const range = (total) => {
    if (isHead) return [0, count.sign === '-' ? Math.max(0, total - count.value) : count.value]
    const start = fromStart ? Math.min(total, Math.max(0, count.value - 1)) : Math.max(0, total - count.value)
    return [start, total]
  }
  const pick = (content) => {
    if (unit === 'c') return sliceBytes(content, range)
    const fromEnd = isHead ? count.sign === '-' : !fromStart
    const n = isHead || fromEnd ? count.value : Math.max(0, count.value - 1)
    const boundary = lineBoundary(content, n, fromEnd)
    return isHead ? content.slice(0, boundary) : content.slice(boundary)
  }
  const leftover = isHead ? headLeftover(count, unit, ctx) : undefined
  // tail gives up at a directory where it counts bytes, from either end, or
  // copies a whole input from its first line, and carries on past one where
  // it counts any other lines.
  const readOptions = !isHead && (unit === 'c' || (fromStart && count.value <= 1)) ? { stopOnDir: true } : undefined
  return takeFrom(cmd, stdin, positional, ctx, pick, { unit, banner, leftover, readOptions })
}

// head -c leaves exactly the unread bytes. On file-backed stdin, -n also leaves
// unread lines; pipe reads and negative counts consume the buffered input.
function headLeftover(count, unit, ctx) {
  if (count.sign === '-' || (unit === 'n' && !ctx.stdinFile)) return () => ''
  if (unit === 'c') return (content) => sliceBytes(content, (total) => [Math.min(count.value, total), total])
  return (content) => content.slice(lineBoundary(content, count.value))
}

// A final newline terminates a record; it does not add an empty last record.
function lineBoundary(content, count, fromEnd = false) {
  if (fromEnd) {
    if (count === 0) return content.length
    let pos = content.length - Number(content.endsWith('\n'))
    for (let k = 0; k < count; k++) {
      if (pos <= 0) return 0
      pos = content.lastIndexOf('\n', pos - 1)
      if (pos < 0) return 0
    }
    return pos + 1
  }
  let pos = 0
  for (let k = 0; k < count && pos < content.length; k++) {
    const nl = content.indexOf('\n', pos)
    pos = nl === -1 ? content.length : nl + 1
  }
  return pos
}

// Only the first argument admits head's obsolete -NUM form, with the letters
// it takes after the digits: `c`, or a `b`, `k` or `m` multiplier, for bytes,
// `l` for lines, and `q` or `v`. Rewrite it before option parsing so later
// -n/-c retain normal last-option precedence; -- still protects numeric
// filenames.
function obsoleteHead(tokens) {
  const m = /^-(\d+)(.*)$/su.exec(tokens[0] ?? '')
  if (m === null) return null
  let multiplier = '', unit = 'n'
  const flags = []
  for (const letter of m[2]) {
    if (letter === 'c' || 'bkm'.includes(letter)) { unit = 'c'; multiplier = letter === 'c' ? '' : letter }
    else if (letter === 'l') unit = 'n'
    else if (letter === 'q' || letter === 'v') flags.push('-' + letter)
    else if (letter === 'z') return { error: unsupported('option', 'head', '-z', 'head: unknown option: -z') }
    else return { error: usageError('head', `invalid trailing option -- ${letter}`) }
  }
  return { tokens: ['-' + unit, m[1] + multiplier, ...flags, ...tokens.slice(1)] }
}

// tail's obsolete spelling — `+N` from the start or `-N` from the end, then
// `b`, `c` or `l`, then `f` — is read only where it stands first, alone or
// before a single operand that is no option, `--` aside. A missing count is
// ten lines, or ten 512-byte blocks for `b`.
function obsoleteTail(tokens, ctx) {
  const [first, second] = tokens
  const shape = tokens.length === 1 || (tokens.length === 2 && !(second.startsWith('-') && second.length > 1)) || ((tokens.length === 2 || tokens.length === 3) && second === '--')
  const m = shape ? /^([+-])(\d*)([bcl]?)(f?)$/u.exec(first) : null
  if (m === null || (m[1] === '-' && ['', 'c'].includes(first.slice(1)))) return null
  if (m[4]) return { error: unsupported('option', 'tail', '-f', 'tail: following a file is not supported') }
  const blocks = m[3] === 'b' ? 512n : 1n
  const digits = BigInt(m[2] || 10)
  if (digits * blocks > UINT64_MAX) {
    return { error: err(`tail: invalid number: ${quoteLocale(first, ctx)}${digits > UINT64_MAX ? ': Numerical result out of range' : ''}`) }
  }
  const value = Number(digits * blocks > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : digits * blocks)
  return { unit: m[3] === 'b' || m[3] === 'c' ? 'c' : 'n', count: { value, sign: m[1] }, files: tokens.slice(second === '--' ? 2 : 1) }
}

// getopt reads a digit as an option of its own wherever one stands past the
// obsolete form: head calls it a trailing option, tail one used out of
// context. A letter neither takes is left for parseArgs to refuse.
function digitOption(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '--') return null
    if (!token.startsWith('-') || token.length < 2 || token.startsWith('--')) continue
    for (let j = 1; j < token.length; j++) {
      if (/\d/u.test(token[j])) return token[j]
      if (token[j] === 'n' || token[j] === 'c') { if (j === token.length - 1) i++; break }
      if (token[j] !== 'q' && token[j] !== 'v') return null
    }
  }
  return null
}

// Output must remain valid UTF-8: partial bytes cannot cross a string
// pipeline faithfully, so the shared decoder reports that limitation.
function sliceBytes(content, range) {
  const bytes = encodeUtf8Loose(content)
  // `range` resolves against THIS input's byte length, so `-c -3` drops
  // the last three bytes of each input separately, as GNU does.
  const [start, end] = range(bytes.length)
  if (start === 0 && end >= bytes.length) return content
  return decodeUtf8(bytes.subarray(start, end))
}

// Banner presence depends on named operands, including missing ones. Only opened
// operands get banners; directories get an empty body. A later banner terminates
// the preceding body if needed. Shared stdin operands consume sequentially.
function takeFrom(cmd, stdin, files, ctx, pick, { unit, banner, leftover = () => '', readOptions }) {
  const r = readInputs(cmd, files, stdin, ctx, readOptions)
  // `-q` / `-v` override the operand-count rule outright; `banner` is
  // null when neither was given.
  const showHeader = banner ?? files.length > 1
  const opened = r.entries.filter((e) => e.kind !== 'missing')
  const blocks = [], notes = []
  let rest = null
  for (let i = 0; i < opened.length; i++) {
    const { name, kind, shared } = opened[i]
    let { content } = opened[i]
    if (shared || name === null) {
      if (rest !== null) content = rest
      rest = leftover(content)
      consumeStdin(ctx, rest)
    }
    // A directory yields no body at all — not even the newline an empty
    // line-pick would append — so `pick` is skipped for it entirely.
    const body = kind === 'dir' ? '' : pick(content)
    if (kind === 'file' && body !== content) {
      const note = truncationNote(cmd, content, body, unit, inputLabel(name, ctx))
      if (note) notes.push(note)
    }
    // Both implicit stdin and an explicit - operand use the standard-input label.
    const label = name === null || name === '-' ? 'standard input' : name
    blocks.push(showHeader ? `${i > 0 ? '\n' : ''}==> ${label} <==\n${body}` : body)
  }
  // A later slice may reject partial UTF-8 and discard the buffered output.
  for (const note of notes) ctx.notes.add(note)
  return okWith(blocks.join(''), r)
}

function countRecords(text) {
  let count = Number(text.length > 0 && !text.endsWith('\n'))
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++
  return count
}

function truncationNote(cmd, content, body, unit, input) {
  const count = unit === 'c' ? (text) => encodeUtf8Loose(text).length : countRecords
  const selected = count(body), total = count(content)
  if (selected >= total) return null
  const label = (unit === 'c' ? 'byte' : 'line') + (total === 1 ? '' : 's')
  return `${cmd}: selected ${selected} of ${total} ${label} from ${input}.`
}
