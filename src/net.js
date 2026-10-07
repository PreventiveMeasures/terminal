import { joinBytes } from './bytes.js'

// The network is the runtime's work rather than this code's, exactly as
// compression is (./compression.js): `fetch` makes the request, and it
// answers asynchronously where everything over the tree answers at once — so
// the command waits for it where it meets it, which is what an asynchronous
// `run` is for.
//
// It is also the one thing here that reaches outside. Everything else this
// package does happens over a tree that exists only in memory: no host
// filesystem, no processes, nothing a command line can touch that the caller
// did not hand over. A request does leave, so it is asked for rather than
// assumed — `createTerminal(sources, { network: true })` — and without that
// the command that would make one is not in the registry at all: the name is
// not found, which is what it was before the command was written, and is the
// whole of what a line inside such a terminal is told about it.
//
// Two rules hold whatever is asked for. What it will speak is http and https
// and nothing else (./commands/curl-url.js reads a URL): `file:` would be the
// host filesystem this package does not have, `data:` is bytes pretending to
// be a transfer, and every other scheme is a protocol nothing here speaks —
// a redirect is held to the same rule, since a hop is a request. And nothing is read off the host to make
// the request with: no environment, no `.netrc`, no cookie jar, no client
// certificate. What goes out is what the command line said.

// Whether a request can be made at all — asked when the registry is built,
// since a runtime does not grow a `fetch` later. Nothing here reaches for one
// it has not first been told is there, and it is the runtime's own `fetch`
// that is reached for, named as this file names any other of its intrinsics.
export const networkUsable = () => typeof fetch === 'function'

// Only the two, and the option is the whole of it: there is no allow-list, no
// proxy and no credential store here, so `true` means whatever the runtime's
// own `fetch` can reach. A caller who needs less than that wires a `curl` of
// their own through `opts.commands`, which is exactly what that is for.
export function networkOption(opts) {
  if (opts.network !== undefined && typeof opts.network !== 'boolean') {
    throw new TypeError(`createTerminal: network must be true or false (got ${opts.network === null ? 'null' : typeof opts.network})`)
  }
  return opts.network === true
}

// What the runtime says went wrong, in the numbers curl gives the same
// trouble. A `fetch` that fails says little and says it differently in every
// runtime, so the classification goes by the error code underneath where
// there is one. curl's own words for most of these carry what only a
// connection it held could say — how long it waited, how many bytes came —
// so `exact` says whether the message here is curl's word for word; a caller
// that would print one that is not has a gap to report instead. `refused` is
// a request the runtime would not make at all, which curl would have made.
const RESOLVE = new Set(['ENOTFOUND', 'EAI_AGAIN'])
const TIMEOUT = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])
const RESET = new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE'])
const CERTIFICATE = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
])
// What undici says of a request it will not send: a header or a port the
// Fetch standard keeps for itself, or an argument it does not take.
const REFUSALS = new Set(['UND_ERR_INVALID_ARG', 'UND_ERR_NOT_SUPPORTED'])

// A request carries no deadline of its own unless one was asked for, so an
// abort is `--max-time` running out; a runtime that aborts for its own
// reasons reports the same timeout, which is what it is.
const ABORTS = new Set(['TimeoutError', 'AbortError'])

function failure(e, url) {
  const code = causeCode(e)
  const why = reasonOf(e)
  if (ABORTS.has(e?.name) || TIMEOUT.has(code)) return { code: 28, message: `Operation timed out: ${why}`, exact: false }
  if (RESOLVE.has(code)) return { code: 6, message: `Could not resolve host: ${url.hostname}`, exact: true }
  // A Request that cannot be built is thrown bare; a port the standard bars
  // is a network error naming it.
  if (REFUSALS.has(code) || (e instanceof TypeError && e.cause === undefined) || why === 'bad port') return { refused: why }
  if (CERTIFICATE.has(code)) return { code: 60, message: `SSL certificate problem: ${why}`, exact: false }
  if (RESET.has(code)) return { code: 56, message: `Recv failure: ${why}`, exact: false }
  return { code: 7, message: `Failed to connect to ${url.hostname} port ${portOf(url)}: ${why}`, exact: false }
}

const portOf = (url) => url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : url.port

// Runtimes wrap what went wrong: `TypeError: fetch failed` over the cause
// that says which failure it was. Read down the chain for the first code,
// and stop rather than follow one that points at itself.
function causeCode(e) {
  for (let at = e, depth = 0; at !== null && at !== undefined && depth < 8; at = at.cause, depth++) {
    if (typeof at.code === 'string') return at.code
  }
  return null
}

// The innermost thing said about the failure, which is the one that names it:
// the outer layer is `fetch failed` in every runtime that wraps.
function reasonOf(e) {
  let message = typeof e?.message === 'string' && e.message !== '' ? e.message : 'transfer failed'
  for (let at = e?.cause, depth = 0; at !== null && at !== undefined && depth < 8; at = at.cause, depth++) {
    if (typeof at.message === 'string' && at.message !== '') message = at.message
  }
  return message
}

// One request and what came back, or what stopped it. Nothing is thrown from
// here: a transfer that fails is an answer a command has words for.
export async function transfer(url, init) {
  try {
    return { response: await fetch(url.href, init) }
  } catch (e) {
    return { failed: failure(e, url) }
  }
}

// The body as the bytes it is, read as it arrives — what a terminal carrying
// its output as a string then makes of them is the caller's business, as it
// is for every other command here that writes bytes. A body that stops early
// hands back what did arrive, which curl has written by then, and the
// failure: one that stops short of the length it was given is curl's code 18
// in curl's words, since the count is the response's own.
export async function receive(response, url) {
  const chunks = []
  let received = 0
  try {
    const reader = response.body?.getReader()
    // oxlint-disable-next-line no-await-in-loop -- the body arrives a piece after the last.
    for (let part = await reader?.read(); part && !part.done; part = await reader.read()) {
      chunks.push(part.value)
      received += part.value.length
    }
    return { bytes: joinBytes([...chunks, new Uint8Array()]) }
  } catch (e) {
    return { bytes: joinBytes([...chunks, new Uint8Array()]), failed: bodyFailure(e, response, url, received) }
  }
}

function bodyFailure(e, response, url, received) {
  const found = failure(e, url)
  if (found.code === 28 || found.code === 56) return found
  const length = response.headers.get('content-length')
  if (/^\d+$/u.test(length ?? '') && !response.headers.has('content-encoding')) {
    return { code: 18, message: `transfer closed with ${Number(length) - received} bytes remaining to read`, exact: true }
  }
  if (/chunked/iu.test(response.headers.get('transfer-encoding') ?? '')) return { code: 18, message: 'transfer closed with outstanding read data remaining', exact: true }
  return { code: 56, message: `Recv failure: ${reasonOf(e)}`, exact: false }
}

// A redirect whose body nobody will read is still a body the runtime is
// holding open; letting go of it is not something a caller can be made to
// wait on, and a runtime that has already closed it says so by throwing.
export async function discard(response) {
  try { await response.body?.cancel() } catch { /* already closed, which is the same thing */ }
}
