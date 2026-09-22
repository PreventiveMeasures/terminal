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
// not found, which is what it was before the command was written.
//
// Two rules hold whatever is asked for. What it will speak is http and https
// and nothing else: `file:` would be the host filesystem this package does
// not have, `data:` is bytes pretending to be a transfer, and every other
// scheme is a protocol nothing here speaks — a redirect is held to the same
// rule, since a hop is a request. And nothing is read off the host to make
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

const SCHEMES = Object.freeze(['http:', 'https:'])
const SCHEME_WRITTEN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/u

// curl reads a bare host as http — the one guess it makes about a URL, and
// the one made here. Everything else a URL can be wrong in is the URL
// parser's to say, and what it refuses is curl's code 3.
export function readUrl(text) {
  const spelt = SCHEME_WRITTEN.test(text) ? text : 'http://' + text
  let url
  try { url = new URL(spelt) } catch { return { malformed: true } }
  if (!SCHEMES.includes(url.protocol)) return { protocol: url.protocol.slice(0, -1) }
  if (url.hostname === '') return { malformed: true }
  return { url }
}

// What the runtime says went wrong, in the numbers curl gives the same
// trouble. A `fetch` that fails says little and says it differently in every
// runtime, so the classification goes by the error code underneath where
// there is one, and what is left is reported as the connection failure it
// most often is — with the runtime's own words kept, rather than dropped for
// a tidier guess.
const RESOLVE = new Set(['ENOTFOUND', 'EAI_AGAIN'])
const TIMEOUT = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])
const RESET = new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE'])
const CERTIFICATE = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
])

// A request carries no deadline of its own unless one was asked for, so an
// abort is `--max-time` running out; a runtime that aborts for its own
// reasons reports the same timeout, which is what it is.
const ABORTS = new Set(['TimeoutError', 'AbortError'])

function failure(e, url, timeout) {
  const code = causeCode(e)
  const why = reasonOf(e)
  const where = `Failed to connect to ${url.hostname} port ${portOf(url)}`
  if (ABORTS.has(e?.name) || TIMEOUT.has(code)) {
    return { code: 28, message: timeout === null ? `Operation timed out: ${why}` : `Operation timed out after ${timeout} milliseconds` }
  }
  if (RESOLVE.has(code)) return { code: 6, message: `Could not resolve host: ${url.hostname}` }
  if (CERTIFICATE.has(code)) return { code: 60, message: `SSL certificate problem: ${why}` }
  if (RESET.has(code)) return { code: 56, message: `Recv failure: ${why}` }
  return { code: 7, message: `${where}: ${why}` }
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
export async function transfer(url, init, timeout = null) {
  try {
    return { response: await fetch(url.href, init) }
  } catch (e) {
    return { failed: failure(e, url, timeout) }
  }
}

// The body, whole, as the bytes it is — what a terminal carrying its output
// as a string then makes of them is the caller's business, as it is for every
// other command here that writes bytes. A body that stops early is its own
// failure, told apart from a connection that never opened.
export async function receive(response, url, timeout = null) {
  try {
    return { bytes: new Uint8Array(await response.arrayBuffer()) }
  } catch (e) {
    const { code, message } = failure(e, url, timeout)
    return { failed: code === 7 ? { code: 56, message: `Recv failure: ${reasonOf(e)}` } : { code, message } }
  }
}

// A redirect whose body nobody will read is still a body the runtime is
// holding open; letting go of it is not something a caller can be made to
// wait on, and a runtime that has already closed it says so by throwing.
export async function discard(response) {
  try { await response.body?.cancel() } catch { /* already closed, which is the same thing */ }
}
