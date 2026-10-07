import { stdoutIsTerminal } from '../util.js'
import { markUnsupported, unsupportedNote } from '../unsupported.js'
import { discard, receive, transfer } from '../net.js'
import { TRY, fail, gap, readCommandLine } from './curl-options.js'
import { plainLocation, readCurlUrl } from './curl-url.js'

// curl, over the runtime's `fetch` (../net.js). It is here only where the
// caller asked for a terminal with a network — `createTerminal(sources, {
// network: true })` — and where the runtime has a `fetch` to make the request
// with; without either, the name is not a command at all, and says no more
// than that. How a terminal was built is the caller's business and nothing a
// line running inside it can do anything about, so a missing `curl` reads
// exactly as it did before this command was written.
//
// What it is: the request the command line describes, made once, and the
// answer written out. What it is not is libcurl. A transfer here is one
// request and its response — no connection to reuse, no cookie jar, no
// proxy, no resume, no progress meter and no header block, since the
// runtime hands back neither a clock for the one nor the bytes of the other
// — and the options that would ask for those are refused by name rather than
// accepted and quietly dropped, because someone who typed `-k` is asking for
// something specific and deserves to be told it did not happen. The request
// itself carries a few headers of the runtime's own (./curl-headers.js).
//
// What comes back is bytes, as it is for every other command here that writes
// what no string need spell: a pipe and a file take them, and this terminal's
// own output takes the text they spell, or reports that they spell none. So
// `curl "$url" > /tmp/out.png` and `curl "$url" | sha256sum` read the answer
// itself, and its encoding is never guessed at.

const REDIRECTS = new Set([301, 302, 303, 307, 308])

export async function curl(stdin, tokens, ctx) {
  const state = { ctx, events: [], stderr: '', status: 0, gap: null, quiet: false }
  if (tokens.length === 0) return { stdout: '', stderr: TRY, exitCode: 2 }
  const { help, refusal, usage, opts, urls, targets } = readCommandLine(tokens, stdin, state)
  if (help) return { stdout: HELP, stderr: '', exitCode: 0 }
  if (refusal) return refusal
  if (usage) return { stdout: '', stderr: usage, exitCode: 2 }
  // A command line that could not be read has already said why, on both
  // channels a line reads: what is left is to hand back what it said.
  if (opts === null) return answer(state)
  // curl settles the method before it makes a request: a body and -I ask
  // for two.
  if (opts.head && opts.body !== null) {
    if (!state.quiet) state.stderr += 'Warning: You can only select one HTTP request method! You asked for both POST \nWarning: (-d, --data) and HEAD (-I, --head).\n'
    state.status = 2
    return answer(state)
  }
  if (urls.length === 0) return { stdout: '', stderr: `curl: (2) no URL specified\n${TRY}`, exitCode: 2 }
  // The header block -i and -I write is the response as the server sent it —
  // its names' case, their order, a name sent twice, the HTTP version — and
  // the runtime hands back none of that.
  if (opts.head || opts.include) {
    const label = opts.head ? '-I' : '-i'
    return answer(gap(state, 'option', label, 2, `${label}: the header block as the server sent it (the case and order of its names, a name sent twice, the HTTP version) is not what the runtime hands back`) ?? state)
  }
  if (!methodIsSendable(opts, state)) return answer(state)
  for (const [at, url] of urls.entries()) {
    // The status is the last transfer's, failed or not, as curl's is.
    state.status = 0
    // oxlint-disable-next-line no-await-in-loop -- one URL after the last, as curl takes them.
    await one(url, targets[at] ?? null, opts, state)
    // A refusal ends the line: nothing after it is asked of the network.
    if (state.gap) break
  }
  return answer(state)
}

// curl 8.5.0's `--help`, word for word.
const HELP = `Usage: curl [options...] <url>
 -d, --data <data>          HTTP POST data
 -f, --fail                 Fail fast with no output on HTTP errors
 -h, --help <category>      Get help for commands
 -i, --include              Include protocol response headers in the output
 -o, --output <file>        Write to file instead of stdout
 -O, --remote-name          Write output to a file named as the remote file
 -s, --silent               Silent mode
 -T, --upload-file <file>   Transfer local FILE to destination
 -u, --user <user:password> Server user and password
 -A, --user-agent <name>    Send User-Agent <name> to server
 -v, --verbose              Make the operation more talkative
 -V, --version              Show version number and quit

This is not the full help, this menu is stripped into categories.
Use "--help category" to get an overview of all categories.
For all options use the manual or "--help all".
`

// What it wrote, in the order it wrote it, and the gap it met if it met one —
// carried on the result rather than in place of it, so a URL that answered
// before the gap is not lost to it.
function answer(state) {
  const events = [...state.events, ...(state.stderr ? [{ fd: 2, text: state.stderr }] : [])]
  const result = { stdout: '', stderr: state.stderr, exitCode: state.status, events }
  return state.gap ? markUnsupported(result, state.gap.kind, 'curl', state.gap.detail, state.gap.message) : result
}

// curl sends the method it was given as it was given. The runtime will not
// send some at all, writes the six it knows in capitals however they were
// typed, and sends no body with a GET or a HEAD; a HEAD asked for with -X
// is one curl then waits on for the body its answer announces.
const KNOWN = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'])
const BARRED = new Set(['CONNECT', 'TRACE', 'TRACK'])
function methodIsSendable(opts, state) {
  const method = opts.custom ?? opts.request
  const refuse = (why) => { gap(state, 'option', '-X', 2, `-X ${method}: ${why}`); return false }
  if (opts.custom !== null) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(method) || BARRED.has(method.toUpperCase())) return refuse('the runtime will not send this method')
    if (KNOWN.has(method.toUpperCase()) && method !== method.toUpperCase()) return refuse('the runtime sends this method in capitals')
    if (method === 'HEAD') return refuse('curl waits for the body a HEAD answer announces, which the runtime does not')
  }
  if (opts.body !== null && (method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD')) return refuse('the runtime sends no body with this method')
  return true
}

// One URL: the request, the hops it may take, and what came back.
async function one(spelt, target, opts, state) {
  const read = readCurlUrl(spelt, opts.globoff)
  if (read.refused) return gap(state, 'feature', read.refused[0], 2, read.refused[1])
  if (read.protocol) return gap(state, 'feature', 'protocol', 1, protocolMessage(read.protocol))
  if (read.malformed !== undefined) {
    // curl's words for a URL its parser turns down are its own; where they are
    // not known here, a quiet line still gets curl's answer.
    if (read.malformed !== null || state.quiet) return fail(state, 3, read.malformed ?? '')
    return gap(state, 'feature', 'malformed URL', 3, 'URL using bad/illegal format or missing URL')
  }
  // `-O` names the file after the URL as it was given, before any redirect:
  // what was asked for is what the caller typed.
  const file = target?.remote ? remoteName(read.url) : target?.file ?? null
  if (file === '') {
    if (!state.quiet) state.stderr += 'curl: Remote file name has no length\n'
    return fail(state, 23, 'Failed writing received data to disk/application')
  }
  // curl draws a progress meter on stderr while a transfer's output goes
  // anywhere but a terminal, and what it draws is timing.
  const stderrShown = !['null', 'closed'].includes(state.ctx.outputFds?.[2])
  if (opts.progress && stderrShown && (file !== null || !stdoutIsTerminal(state.ctx))) {
    return gap(state, 'feature', 'progress meter', 2, 'the progress meter curl draws on stderr when its output is not a terminal is not supported; -s or --no-progress-meter leaves it out')
  }
  const base = new Headers(opts.headers)
  if (read.auth && !base.has('authorization')) base.set('authorization', read.auth)
  const first = read.url
  const hop = { url: first, request: opts.request, body: opts.body, headers: base }
  // One deadline for the transfer rather than one per hop, since what
  // `--max-time` is given is the time this URL may take — the hops it turns
  // out to need included, as they are in curl.
  const signal = opts.timeout === null ? null : AbortSignal.timeout(opts.timeout)
  for (let followed = 0; ; followed++) {
    // oxlint-disable-next-line no-await-in-loop -- one hop of a chain after the last.
    const { response, failed } = await transfer(hop.url, init(hop, opts, signal))
    if (failed) return failure(state, failed)
    const next = redirect(response, hop, opts)
    if (next === null) return finish(response, hop, file, opts, state)
    // oxlint-disable-next-line no-await-in-loop -- the hop's body is let go before the next request.
    await discard(response)
    if (followed >= opts.redirects) return fail(state, 47, `Maximum (${opts.redirects}) redirects followed`)
    if (next.refused) return gap(state, 'feature', 'redirect URL', 2, next.refused)
    if (next.protocol) return gap(state, 'feature', 'protocol', 1, protocolMessage(next.protocol))
    hop.url = next.url
    hop.request = next.request
    hop.body = next.body
    hop.headers = carried(base, opts.implied, hop.request === 'GET' && opts.request !== 'GET', !sameHost(first, next.url))
  }
}

const protocolMessage = (protocol) => `Protocol "${protocol}" not supported or disabled in libcurl`
const remoteName = (url) => url.pathname.slice(url.pathname.lastIndexOf('/') + 1)

// A failure in curl's words where they are curl's; where they carry what
// only curl's own connection could say, a quiet line still gets curl's
// answer, and a line that would print them gets a gap.
function failure(state, failed) {
  if (failed.refused) return gap(state, 'feature', 'request', 2, `the runtime will not make this request: ${failed.refused}`)
  if (failed.exact || state.quiet) return fail(state, failed.code, failed.message)
  return gap(state, 'feature', 'transfer error message', failed.code, failed.message)
}

const init = (hop, opts, signal) => ({
  method: opts.custom ?? hop.request,
  headers: hop.headers,
  // Every hop is this code's to take or not take, so the runtime is told to
  // hand a redirect back rather than follow one: `-L` is the asking, and a
  // hop that would leave http or https is refused as a first request is.
  redirect: 'manual',
  ...(hop.body === null ? {} : { body: hop.body }),
  ...(signal === null ? {} : { signal }),
})

// Where a response says to go next, if it says so and `-L` asked: libcurl's
// Curl_follow. A 301 or a 302 turns a POST into a GET, a 303 turns anything
// into one, and the body goes with it; a method a line named with -X is the
// one every hop is made with, whatever became of the body.
function redirect(response, hop, opts) {
  if (!opts.location || !REDIRECTS.has(response.status)) return null
  const location = response.headers.get('location')
  if (location === null || location === '') return null
  if (!plainLocation(location)) return { refused: `following a redirect to ${JSON.stringify(location)} is not supported: the runtime would read that URL differently from curl` }
  let url
  try { url = new URL(location, hop.url) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { protocol: url.protocol.slice(0, -1) }
  const toGet = response.status === 303 ? hop.request !== 'GET' : (response.status === 301 || response.status === 302) && hop.request === 'POST'
  return { url, request: toGet ? 'GET' : hop.request, body: toGet ? null : hop.body }
}

// What a hop carries of the request the line made. A request that no longer
// carries a body says nothing about one; and a hop to another host carries
// no credential, because a credential is addressed to the host it was given
// for, and the host it is now being sent to was named by the answer rather
// than by whoever wrote the line. curl judges that against the first host,
// so a chain that comes back carries them again; it drops a -H Authorization
// or Cookie the same way, and so does `fetch` for a redirect it follows.
const CREDENTIALS = Object.freeze(['authorization', 'cookie'])
function carried(base, implied, rewritten, crossed) {
  const left = new Headers(base)
  if (rewritten && implied.has('content-type')) left.delete('content-type')
  if (crossed) for (const name of CREDENTIALS) left.delete(name)
  return left
}

const portOf = (url) => url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
const sameHost = (a, b) => a.hostname === b.hostname && portOf(a) === portOf(b) && a.protocol === b.protocol

// The response the chain ended on: what `-f` makes of a failing status, and
// otherwise the body, as much of it as came.
async function finish(response, hop, file, opts, state) {
  if (opts.failEarly && response.status >= 400) {
    await discard(response)
    return fail(state, 22, `The requested URL returned error: ${response.status}`)
  }
  const encoding = response.headers.get('content-encoding')
  if (response.status !== 204 && response.status !== 304 && !decodedAlike(encoding, opts.compressed)) {
    await discard(response)
    return gap(state, 'feature', 'content encoding', 2, `the answer is ${encoding}-encoded, and the runtime hands back only the decoded bytes, where curl ${opts.compressed ? 'does not know the coding' : 'writes them as they came without --compressed'}`)
  }
  const body = await receive(response, hop.url)
  if (!write(body.bytes, file, state, body.failed !== undefined)) return false
  return body.failed ? failure(state, body.failed) : true
}

// The runtime decodes every coding curl does under --compressed, and curl
// decodes none without it.
const DECODED = new Set(['gzip', 'x-gzip', 'deflate', 'br', 'zstd', 'identity'])
function decodedAlike(encoding, compressed) {
  const codings = (encoding ?? '').split(',').map((coding) => coding.trim().toLowerCase()).filter(Boolean)
  return codings.every((coding) => coding === 'identity' || (compressed && DECODED.has(coding)))
}

// The body, to stdout or to the file — which curl makes when the first bytes
// come, or at the end of a transfer that brought none.
function write(body, file, state, failed) {
  if (file !== null) return failed && body.length === 0 ? true : toFile(file, body, state)
  if (body.length > 0) state.events.push({ fd: 1, bytes: body })
  return true
}

// Into the overlay, which is the only place a file can be written here. A
// terminal without one says so rather than reporting a transfer that wrote
// nowhere.
function toFile(name, body, state) {
  const { ctx } = state
  // The device every system has takes it and keeps nothing.
  if (name === '/dev/null') return true
  let handle
  try { handle = ctx.writable && ctx.fs.openWritable?.(ctx.cwd, name) } catch (e) {
    // A write the filesystem refuses as unsupported stays that refusal.
    const note = unsupportedNote(e)
    if (note) return gap(state, note.kind, note.detail, 23, e.message)
    if (!state.quiet) state.stderr += `Warning: Failed to open the file ${name}: ${e?.fsError ?? String(e?.message).split(': ').at(-1)}\n`
    // A transfer that brought nothing finds out at the end, and says no more.
    if (body.length === 0) { state.status = 23; return false }
    return fail(state, 23, 'Failure writing output to destination')
  }
  if (!handle) return gap(state, 'feature', 'read-only target', 23, `${name}: file system is read-only`)
  handle.writeBytes(body)
  return true
}
