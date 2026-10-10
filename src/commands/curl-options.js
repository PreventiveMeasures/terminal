import { parseArgs } from '../args.js'
import { consumeStdin, encodeUtf8, joinBytes, readBytesOf } from '../util.js'
import { lookupWithNote } from '../notes.js'
import { unsupported, unsupportedNote } from '../unsupported.js'
import { requestHeaders } from './curl-headers.js'

// Reading a curl command line: the options this one carries, the ones it
// refuses by name, and everything the request is then made of. The two
// reporters are here as well, because a line that could not be read says so
// in the same words a transfer that failed says it in — `curl: (N) …`, in
// curl's own numbers — and reaches the same two channels.

// The options this curl carries. A name that is not here is an unknown option
// and reports as one; a name that is here and refused is in REFUSED below,
// which is how a thing curl can do but this cannot is told apart from a thing
// curl has never had.
const SCHEMA = {
  short: ['h', 's', 'S', 'i', 'I', 'L', 'f', 'O', 'k', 'v', 'G', 'n', 'g'],
  long: [
    'help', 'silent', 'show-error', 'no-progress-meter', 'include', 'head', 'location', 'location-trusted', 'fail', 'remote-name',
    'compressed', 'insecure', 'verbose', 'get', 'netrc', 'globoff',
  ],
  valueShort: ['X', 'A', 'm', 'u', 'e', 'b', 'c', 'w', 'x', 'T', 'r', 'C', 'E', 'D', 'F'],
  valueLong: [
    'request', 'user-agent', 'max-time', 'user', 'max-redirs',
    'referer', 'cookie', 'cookie-jar', 'write-out', 'proxy', 'proxy-user', 'upload-file', 'range',
    'continue-at', 'cert', 'key', 'cacert', 'capath', 'dump-header', 'connect-timeout', 'retry',
    'limit-rate', 'resolve', 'interface', 'form',
  ],
  // Read back off `order` rather than out of `values`, so `-d a -d b` and
  // `-o one -O` keep the order they were written in — which is the order curl
  // joins data in, and the order it pairs outputs with URLs in.
  repeatable: ['H', 'header', 'd', 'data', 'data-raw', 'data-ascii', 'data-binary', 'json', 'o', 'output'],
}

// Options curl has that this one will not do, and why. Each says what would
// have to exist for it to work and, where the same thing can be asked for
// with what is here, says that instead.
const REFUSED = new Map([
  ['k', 'certificates are the runtime\'s to check, and nothing here can tell it not to'],
  ['insecure', 'certificates are the runtime\'s to check, and nothing here can tell it not to'],
  ['v', 'the trace is of a connection this code never sees'],
  ['verbose', 'the trace is of a connection this code never sees'],
  ['location-trusted', 'a credential is for the origin it was given for; `-L` follows the hop without it'],
  ['G', 'moving the data into the query string is not implemented; put it in the URL'],
  ['get', 'moving the data into the query string is not implemented; put it in the URL'],
  ['n', 'there is no home directory here to read a `.netrc` from'],
  ['netrc', 'there is no home directory here to read a `.netrc` from'],
  ['b', 'there is no cookie jar here; a cookie to send is `-H "Cookie: …"`'],
  ['cookie', 'there is no cookie jar here; a cookie to send is `-H "Cookie: …"`'],
  ['c', 'there is no cookie jar here to write'],
  ['cookie-jar', 'there is no cookie jar here to write'],
  ['w', 'the transfer keeps no measurements of its own to write out'],
  ['write-out', 'the transfer keeps no measurements of its own to write out'],
  ['x', 'a proxy is the runtime\'s own setting, and nothing here passes it one'],
  ['proxy', 'a proxy is the runtime\'s own setting, and nothing here passes it one'],
  ['proxy-user', 'a proxy is the runtime\'s own setting, and nothing here passes it one'],
  ['F', 'a multipart body is not implemented; `--data-binary` sends one you spell out yourself'],
  ['form', 'a multipart body is not implemented; `--data-binary` sends one you spell out yourself'],
  ['T', 'uploading a file is not implemented; `-X PUT --data-binary @file` sends the same bytes'],
  ['upload-file', 'uploading a file is not implemented; `-X PUT --data-binary @file` sends the same bytes'],
  ['r', 'a ranged request is `-H "Range: bytes=…"`'],
  ['range', 'a ranged request is `-H "Range: bytes=…"`'],
  ['C', 'there is nothing to resume: a transfer here is one request and its answer'],
  ['continue-at', 'there is nothing to resume: a transfer here is one request and its answer'],
  ['E', 'client certificates are the runtime\'s own'],
  ['cert', 'client certificates are the runtime\'s own'],
  ['key', 'client certificates are the runtime\'s own'],
  ['cacert', 'the trust store is the runtime\'s own'],
  ['capath', 'the trust store is the runtime\'s own'],
  ['e', 'a referer is `-H "Referer: …"`'],
  ['referer', 'a referer is `-H "Referer: …"`'],
  ['D', 'writing the headers to a file of their own is not implemented'],
  ['dump-header', 'writing the headers to a file of their own is not implemented'],
  ['connect-timeout', 'only the whole transfer can be timed here, which is `--max-time`'],
  ['retry', 'retrying is not implemented: a transfer here is one request and its answer'],
  ['limit-rate', 'the runtime reads the response at its own pace'],
  ['resolve', 'name resolution is the runtime\'s own'],
  ['interface', 'the interface a request leaves by is the runtime\'s own'],
])

// How a piece of data reads what follows it. `@name` is a file for all but
// `--data-raw`, which takes the `@` as data; the text forms drop the line
// endings out of a file, as curl does, and the other two send it as it is.
const DATA = new Map([
  ['d', 'text'], ['data', 'text'], ['data-ascii', 'text'],
  ['data-raw', 'raw'], ['data-binary', 'binary'], ['json', 'json'],
])
const OUTPUT_OPTIONS = new Set(['o', 'output'])
const REMOTE_OPTIONS = new Set(['O', 'remote-name'])
// curl's own ceiling on a chain of redirects; `--max-redirs` moves it, and
// `-1` is curl's spelling for no ceiling at all.
const MAX_REDIRS = 50
const LINE_ENDINGS = new Set([0x0a, 0x0d])

// What curl says under a complaint about its command line, which is printed
// whatever -s says.
export const TRY = "curl: try 'curl --help' or 'curl --manual' for more information\n"

// What a whole command line comes to: the refusal it met, or the request it
// describes, the URLs it names, and where each of their answers goes.
export function readCommandLine(tokens, stdin, state) {
  // curl takes no `--name=value`: it is a name it does not know.
  const glued = tokens.slice(0, tokens.includes('--') ? tokens.indexOf('--') : tokens.length).find((t) => /^--[^=]+=/u.test(t))
  if (glued !== undefined) return { refusal: unknownOption(glued) }
  let parsed
  try { parsed = parseArgs(tokens, SCHEMA) } catch (e) {
    const note = unsupportedNote(e)
    if (note) return { refusal: unknownOption(note.detail) }
    const missing = /^(\S+) requires an argument$/u.exec(e.message)
    return { usage: `curl: option ${missing ? missing[1] : ''}: requires parameter\n${TRY}` }
  }
  const { flags, values, positional, order } = parsed
  // Asked for what it can do, it answers before anything else it was handed,
  // as curl does — with its own words, which name a category only when one
  // follows the option.
  const help = order.findIndex(({ name }) => name === 'h' || name === 'help')
  if (help !== -1) return helpFor(tokens, order.slice(0, help))
  const refusal = refusedOption(flags, values)
  return { refusal, opts: refusal ? null : readOptions(flags, values, order, stdin, state), urls: positional, targets: outputTargets(order) }
}

const unknownOption = (label) => unsupported('option', 'curl', label, `curl: option ${label}: is unknown\n${TRY.trimEnd()}`, 2)

// `--help` with nothing after it is curl's short list, word for word; with
// anything after it, curl takes that for a category to list, which is not
// kept here. An option before it that curl would have read and failed on
// first is not looked at either.
function helpFor(tokens, before) {
  const last = tokens.at(-1)
  const alone = last === '--help' || /^-[sSiILfOkvGng]*h/u.test(last)
  if (alone && !before.some(({ name }) => ['m', 'max-time', 'max-redirs'].includes(name) || DATA.has(name))) return { help: true }
  return { refusal: unsupported('option', 'curl', '--help', 'curl: --help: listing a category of options is not supported', 2) }
}

function refusedOption(flags, values) {
  for (const [name, why] of REFUSED) {
    if (!flags.has(name) && !values.has(name)) continue
    const label = (name.length === 1 ? '-' : '--') + name
    return unsupported('option', 'curl', label, `curl: ${label}: ${why}`, 2)
  }
  return null
}

// The spelling a value option was given under last, which is the one curl
// names when it cannot read the value.
function spelling(order, names) {
  const last = order.findLast(({ name }) => names.includes(name))
  return last === undefined ? null : (last.name.length === 1 ? '-' : '--') + last.name
}

// Everything the request is made of, read once. What a redirect may change —
// the method, the body, and what the body had the request say about it — it
// changes on the way rather than here.
function readOptions(flags, values, order, stdin, state) {
  state.quiet = (flags.has('s') || flags.has('silent')) && !flags.has('S') && !flags.has('show-error')
  const body = requestBody(order, stdin, state)
  if (body === null) return null
  const seconds = number(values.get('m') ?? values.get('max-time'), spelling(order, ['m', 'max-time']), seconds2ms, state)
  const redirects = number(values.get('max-redirs'), '--max-redirs', redirectCount, state)
  if (redirects === null || seconds === null) return null
  const head = flags.has('I') || flags.has('head')
  const compressed = flags.has('compressed')
  const headers = requestHeaders({ values, order, body, compressed, state })
  if (headers === null) return null
  return {
    headers: headers.list,
    implied: headers.implied,
    body: body.bytes,
    head,
    include: flags.has('i') || flags.has('include'),
    compressed,
    globoff: flags.has('g') || flags.has('globoff'),
    location: flags.has('L') || flags.has('location'),
    failEarly: flags.has('f') || flags.has('fail'),
    progress: !(flags.has('s') || flags.has('silent') || flags.has('no-progress-meter')),
    custom: values.get('X') ?? values.get('request') ?? null,
    request: head ? 'HEAD' : body.bytes === null ? 'GET' : 'POST',
    redirects: redirects === undefined ? MAX_REDIRS : redirects < 0 ? Infinity : redirects,
    // A deadline of no time at all is no deadline, as it is to curl.
    timeout: seconds === undefined || seconds === 0 ? null : seconds,
  }
}

// A number curl would take, read the way curl reads it — strtod for a time,
// strtol for a count — and refused in the words curl refuses one with.
// Nothing where the option was not given, which is not the same answer as a
// value that was given and was not a number.
function number(written, label, read, state) {
  if (written === undefined) return
  const answer = read(written)
  if (typeof answer === 'number') return answer
  state.stderr += `curl: option ${label}: ${answer}\n${TRY}`
  state.status = 2
  return null
}

const BLANKS = /^[ \t\n\v\f\r]*/u
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u
const HEX = /^[+-]?0[xX][0-9a-fA-F]+$/u
const TOO_LARGE = 'too large number'
const LONG_MAX = 2n ** 63n - 1n
const BAD = 'expected a proper numerical parameter'

function seconds2ms(written) {
  const text = written.replace(BLANKS, '')
  const value = DECIMAL.test(text) ? Number(text) : HEX.test(text) ? Number.parseInt(text, 16) : Number.NaN
  if (Number.isNaN(value)) return BAD
  if (value > 2 ** 63 / 1000) return TOO_LARGE
  if (value < 0) return 'expected a positive numerical parameter'
  return Math.trunc(value * 1000)
}

function redirectCount(written) {
  const text = written.replace(BLANKS, '')
  if (!/^[+-]?\d+$/u.test(text)) return BAD
  const value = Number(text)
  if (BigInt(text.replace(/^\+/u, '')) > LONG_MAX || BigInt(text.replace(/^\+/u, '')) < -LONG_MAX - 1n) return TOO_LARGE
  return value < -1 ? BAD : value
}

// The body, from the data options in the order they were written and joined
// as curl joins them: `&` before each piece but a `--json` one, which joins
// on to what came before. A file that cannot be read stops the command line
// where curl stops it, in its words.
function requestBody(order, stdin, state) {
  let joined = null
  let json = false
  for (const { name, value } of order) {
    const how = DATA.get(name)
    if (how === undefined) continue
    const piece = dataPiece(how, value, stdin, state, (name.length === 1 ? '-' : '--') + name)
    if (piece === null) return null
    if (how === 'json') json = true
    joined = joined === null ? piece : joinBytes([joined, encodeUtf8(how === 'json' ? '' : '&'), piece])
  }
  return { bytes: joined, json }
}

function dataPiece(how, value, stdin, state, label) {
  if (how === 'raw' || !value.startsWith('@')) return encodeUtf8(value)
  const name = value.slice(1)
  const bytes = name === '-' ? pipedBytes(stdin, state.ctx) : fileBytes(name, state, label)
  if (bytes === null) return null
  if (how !== 'text') return bytes
  // The text forms read a file as a string: its line endings go, and so does
  // everything from a NUL on, which is where the string ends.
  const text = bytes.filter((byte) => !LINE_ENDINGS.has(byte))
  const nul = text.indexOf(0)
  return nul === -1 ? text : text.subarray(0, nul)
}

// Taking the pipe is taking it: the next command in the group finds it at its
// end, as it would a stdin this one had read to the end.
function pipedBytes(stdin, ctx) {
  const piped = ctx.stdinBytes
  const text = ctx.stdinLeft === '' ? stdin : ctx.stdinLeft
  consumeStdin(ctx, '', true)
  return piped ?? encodeUtf8(text)
}

// A file that cannot be read is curl's code 26, said twice: once as it opens
// it — which -s, if it came first, silences — and once as the option it was
// reading, which nothing silences.
function fileBytes(name, state, label) {
  const { ctx } = state
  const found = lookupWithNote(ctx, 'curl', name)
  if (found.error || ctx.fs.isDir(found.path)) {
    if (!state.quiet) state.stderr += `curl: Failed to open ${name}\n`
    state.stderr += `curl: option ${label}: error encountered when reading a file\n${TRY}`
    state.status = 26
    return null
  }
  return readBytesOf(ctx.fs, found.path)
}

// Where each URL's answer goes: `-o` names a file, `-o -` and no option at
// all are stdout, and `-O` takes the name off the URL it is paired with. They
// pair with the URLs in the order both were written, which is how curl pairs
// them.
function outputTargets(order) {
  const targets = []
  for (const { name, value } of order) {
    if (OUTPUT_OPTIONS.has(name)) targets.push(value === '-' ? null : { file: value })
    else if (REMOTE_OPTIONS.has(name)) targets.push({ remote: true })
  }
  return targets
}

// A transfer that failed, in the number curl gives the same failure. `-s` is
// silence about the transfer, so it is silence here — and never silence on
// the diagnostic feed, which carries this implementation's own report rather
// than the transfer's noise.
export function fail(state, code, message) {
  if (!state.quiet) state.stderr += `curl: (${code}) ${message}\n`
  state.status = code
  return false
}

// What this curl cannot do. The first one met is the one reported, as it is
// everywhere else here, and a run that met one still writes what it had
// already written.
export function gap(state, kind, detail, code, text) {
  state.gap ??= { kind, detail, message: `curl: (${code}) ${text}` }
  state.stderr += `curl: (${code}) ${text}\n`
  state.status = code
  return null
}
