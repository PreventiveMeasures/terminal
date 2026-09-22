import { toBase64 } from '@exodus/bytes/base64.js'
import { parseArgs } from '../args.js'
import { consumeStdin, encodeUtf8, joinBytes, readBytesOf } from '../util.js'
import { lookupWithNote } from '../notes.js'
import { unsupported } from '../unsupported.js'

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
  short: ['h', 's', 'S', 'i', 'I', 'L', 'f', 'O', 'k', 'v', 'G', 'n'],
  long: [
    'help', 'silent', 'show-error', 'no-progress-meter', 'include', 'head', 'location', 'location-trusted', 'fail', 'remote-name',
    'compressed', 'insecure', 'verbose', 'get', 'netrc',
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
  ['v', 'the trace is of a connection this code never sees; `-i` prints the response headers'],
  ['verbose', 'the trace is of a connection this code never sees; `-i` prints the response headers'],
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
  ['D', 'writing the headers to a file of their own is not implemented; `-i` writes them in front of the body'],
  ['dump-header', 'writing the headers to a file of their own is not implemented; `-i` writes them in front of the body'],
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
const HEADER_OPTIONS = new Set(['H', 'header'])
const OUTPUT_OPTIONS = new Set(['o', 'output'])
const REMOTE_OPTIONS = new Set(['O', 'remote-name'])
const FORM_TYPE = 'application/x-www-form-urlencoded'
const JSON_TYPE = 'application/json'
// curl's own ceiling on a chain of redirects; `--max-redirs` moves it, and
// `-1` is curl's spelling for no ceiling at all.
const MAX_REDIRS = 50
const LINE_ENDINGS = new Set([0x0a, 0x0d])

// What a whole command line comes to: the refusal it met, or the request it
// describes, the URLs it names, and where each of their answers goes.
export function readCommandLine(tokens, stdin, state) {
  const { flags, values, positional, order } = parseArgs(tokens, SCHEMA)
  // Asked for what it can do, it answers before anything else it was handed,
  // as curl does — and answers with what it carries rather than with curl's
  // own list, since it will not offer what it would then refuse.
  if (flags.has('h') || flags.has('help')) return { help: true }
  const refusal = refusedOption(flags, values)
  if (refusal) return { refusal }
  return { opts: readOptions(flags, values, order, stdin, state), urls: positional, targets: outputTargets(order) }
}

function refusedOption(flags, values) {
  for (const [name, why] of REFUSED) {
    if (!flags.has(name) && !values.has(name)) continue
    const label = (name.length === 1 ? '-' : '--') + name
    return unsupported('option', 'curl', label, `curl: ${label}: ${why}`, 2)
  }
  return null
}

// Everything the request is made of, read once. What a redirect may change —
// the method, the body, and what the body had the request say about it — it
// changes on the way rather than here.
function readOptions(flags, values, order, stdin, state) {
  state.quiet = (flags.has('s') || flags.has('silent')) && !flags.has('S') && !flags.has('show-error')
  const body = requestBody(order, stdin, state)
  if (body === null) return null
  const headers = requestHeaders(values, order, body, state)
  if (headers === null) return null
  const redirects = count(values.get('max-redirs'), '--max-redirs', state)
  const seconds = count(values.get('m') ?? values.get('max-time'), '--max-time', state)
  if (redirects === null || seconds === null) return null
  // A deadline is the runtime's to keep, and a runtime without a signal to
  // hand it one cannot keep this one: that is a gap rather than a request
  // made without the limit it was given.
  if (seconds !== undefined && typeof AbortSignal?.timeout !== 'function') {
    return gap(state, 'feature', '--max-time', 2, 'this runtime cannot put a deadline on a request')
  }
  const head = flags.has('I') || flags.has('head')
  return {
    headers,
    body: body.bytes,
    head,
    include: flags.has('i') || flags.has('include'),
    location: flags.has('L') || flags.has('location'),
    failEarly: flags.has('f') || flags.has('fail'),
    method: values.get('X') ?? values.get('request') ?? (head ? 'HEAD' : body.bytes === null ? 'GET' : 'POST'),
    redirects: redirects === undefined ? MAX_REDIRS : redirects < 0 ? Infinity : redirects,
    timeout: seconds === undefined ? null : Math.round(seconds * 1000),
  }
}

// A number curl would take, refused in the words curl refuses one with.
// Nothing where the option was not given, which is not the same answer as a
// value that was given and was not a number.
function count(written, label, state) {
  if (written === undefined) return
  const value = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(written.trim()) ? Number(written.trim()) : Number.NaN
  if (!Number.isFinite(value)) {
    state.stderr += `curl: option ${label}: expected a proper numerical parameter\n`
    state.status = 2
    return null
  }
  return value
}

// The body, from the data options in the order they were written and joined
// as curl joins them: `&` between the pieces of a form, nothing between the
// pieces of a `--json`. A file that cannot be read stops the command where
// curl stops it.
function requestBody(order, stdin, state) {
  const parts = []
  const kinds = new Set()
  for (const { name, value } of order) {
    const how = DATA.get(name)
    if (how === undefined) continue
    const piece = dataPiece(how, value, stdin, state)
    if (piece === null) return null
    kinds.add(how === 'json' ? 'json' : 'form')
    parts.push(piece)
  }
  if (parts.length === 0) return { bytes: null, json: false }
  // curl takes one or the other: a body that is a form and a body that is
  // JSON disagree about what joins their pieces and what the request should
  // say it is carrying, and picking one of the two would answer the other.
  if (kinds.size > 1) {
    state.stderr += 'curl: --json cannot be mixed with --data\n'
    state.status = 2
    return null
  }
  const json = kinds.has('json')
  const joined = []
  for (const [at, part] of parts.entries()) {
    if (at > 0 && !json) joined.push(encodeUtf8('&'))
    joined.push(part)
  }
  return { bytes: joinBytes([...joined, new Uint8Array()]), json }
}

function dataPiece(how, value, stdin, state) {
  if (how === 'raw' || !value.startsWith('@')) return encodeUtf8(value)
  const name = value.slice(1)
  const bytes = name === '-' ? pipedBytes(stdin, state.ctx) : fileBytes(name, state)
  if (bytes === null) return null
  // The text forms drop the line endings a file carries, which is what makes
  // `-d @body.txt` the one field it looks like rather than one with a newline
  // stuck on the end. `--data-binary` keeps them, and so does `--json`, which
  // is that same option under two headers — a document is what it holds.
  return how === 'text' ? bytes.filter((byte) => !LINE_ENDINGS.has(byte)) : bytes
}

// Taking the pipe is taking it: the next command in the group finds it at its
// end, as it would a stdin this one had read to the end.
function pipedBytes(stdin, ctx) {
  const piped = ctx.stdinBytes
  const text = ctx.stdinLeft === '' ? stdin : ctx.stdinLeft
  consumeStdin(ctx, '', true)
  return piped ?? encodeUtf8(text)
}

function fileBytes(name, state) {
  const { ctx } = state
  const found = lookupWithNote(ctx, 'curl', name)
  if (found.error || ctx.fs.isDir(found.path)) {
    fail(state, 26, 'Failed to open/read local data from file/application')
    return null
  }
  return readBytesOf(ctx.fs, found.path)
}

// What the request carries: what was asked for, what a body needs said about
// it, and nothing off the host — no environment, no stored credential, and no
// header added behind the caller's back beyond the content type a body
// implies, which `-H` overrides as it does in curl.
function requestHeaders(values, order, body, state) {
  const headers = new Headers()
  if (body.bytes !== null) headers.set('content-type', body.json ? JSON_TYPE : FORM_TYPE)
  if (body.json) headers.set('accept', JSON_TYPE)
  const agent = values.get('A') ?? values.get('user-agent')
  if (agent !== undefined) headers.set('user-agent', agent)
  const credentials = values.get('u') ?? values.get('user')
  if (credentials !== undefined) {
    // curl asks a terminal for the password a `-u user` leaves out, and there
    // is no terminal here to ask — the same reason `read` is not a builtin.
    if (!credentials.includes(':')) return gap(state, 'feature', '-u', 2, 'there is no interactive input here to read a password from')
    headers.set('authorization', `Basic ${toBase64(encodeUtf8(credentials))}`)
  }
  for (const { name, value } of order) {
    if (!HEADER_OPTIONS.has(name)) continue
    if (!setWritten(headers, value, state)) return null
  }
  return headers
}

// curl's three spellings of a custom header: `Name: value` sends it, `Name;`
// sends it empty, and `Name:` takes away one curl would have sent. The third
// is the one that cannot be done here — what a request carries beyond what is
// set is the runtime's own — so it is refused rather than taken for a header
// that was set and then was not.
function setWritten(headers, written, state) {
  const cut = written.indexOf(':')
  if (cut === -1) {
    if (!written.endsWith(';')) return badHeader(state, written)
    return setHeader(headers, written.slice(0, -1), '', state)
  }
  const value = written.slice(cut + 1).trim()
  if (value === '') {
    gap(state, 'option', '-H', 2, `-H "${written}": taking away a header the runtime sends is not supported`)
    return false
  }
  return setHeader(headers, written.slice(0, cut), value, state)
}

function setHeader(headers, name, value, state) {
  try { headers.set(name.trim(), value) } catch { return badHeader(state, name.trim()) }
  return true
}

function badHeader(state, written) {
  state.stderr += `curl: -H: not a header: ${written}\n`
  state.status = 2
  return false
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
  fail(state, code, text)
  return null
}
