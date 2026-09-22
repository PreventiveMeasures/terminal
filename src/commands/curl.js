import { encodeUtf8, joinBytes } from '../util.js'
import { markUnsupported } from '../unsupported.js'
import { discard, readUrl, receive, transfer } from '../net.js'
import { fail, gap, readCommandLine } from './curl-options.js'

// curl, over the runtime's `fetch` (../net.js). It is here only where the
// caller asked for a terminal with a network — `createTerminal(sources, {
// network: true })` — and where the runtime has a `fetch` to make the request
// with; without either, the name is not a command, which is what it was
// before this one was written, and what is then not found says which of the
// two it was rather than leaving someone to guess.
//
// What it is: the request the command line describes, made once, and the
// answer written out. What it is not is libcurl. A transfer here is one
// request and its response — no connection to reuse, no cookie jar, no
// proxy, no resume, and no progress meter, since there is no terminal to
// draw one on — and the options that would ask for those are refused by name
// rather than accepted and quietly dropped, because someone who typed `-k` is
// asking for something specific and deserves to be told it did not happen.
//
// What comes back is bytes, as it is for every other command here that writes
// what no string need spell: a pipe and a file take them, and this terminal's
// own output takes the text they spell, or reports that they spell none. So
// `curl "$url" > /tmp/out.png` and `curl "$url" | sha256sum` read the answer
// itself, and its encoding is never guessed at.

// A hop that keeps the method and the body, and one that does not: 303 is a
// GET afterwards by specification, and 301 and 302 are what every client
// turned into one long before the specification caught up. curl agrees.
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const REWRITTEN = new Set([301, 302, 303])

export async function curl(stdin, tokens, ctx) {
  const state = { ctx, events: [], stderr: '', status: 0, gap: null, quiet: false }
  const { help, refusal, opts, urls, targets } = readCommandLine(tokens, stdin, state)
  if (help) return { stdout: HELP, stderr: '', exitCode: 0 }
  if (refusal) return refusal
  // A command line that could not be read has already said why, on both
  // channels a line reads: what is left is to hand back what it said.
  if (opts === null) return answer(state)
  if (urls.length === 0) return usage()
  for (const [at, url] of urls.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- one URL after the last, as curl takes them.
    await one(url, targets[at] ?? null, opts, state)
  }
  return answer(state)
}

// What curl prints when the command line named no URL at all, and the status
// it exits with for anything it could not read there.
const usage = () => ({ stdout: '', stderr: 'curl: try \'curl --help\' for more information\n', exitCode: 2 })

// The options this curl carries, which is what `--help` is for here: curl's
// own list runs to hundreds of lines, most of them naming something this
// command refuses, and a list that offers what it would then refuse is worse
// than no list. What is missing from it reports when it is asked for.
const HELP = `Usage: curl [options...] <url>
 -d, --data <data>        send data in a POST body; @file reads a file, @- the pipe
     --data-raw <data>    the same, taking a leading @ as data rather than a name
     --data-binary <data> the same, keeping a file's line endings
     --json <data>        send data as JSON, and ask for JSON back
 -f, --fail               write no body, and exit 22, on a failing status
 -H, --header <header>    send a header: "Name: value", or "Name;" to send it empty
 -A, --user-agent <name>  send a user agent
 -u, --user <user:pass>   send basic authentication
 -i, --include            write the response headers in front of the body
 -I, --head               ask for the headers alone
 -L, --location           follow a redirect, up to --max-redirs <num>
 -m, --max-time <seconds> give up on a transfer that takes longer
 -o, --output <file>      write to a file rather than to stdout ("-" is stdout)
 -O, --remote-name        write to a file named after the URL
 -s, --silent             say nothing about a transfer that failed
 -S, --show-error         say it anyway, alongside -s
 -X, --request <method>   use another method
     --compressed         ask for a compressed answer, which the runtime does anyway
 -h, --help               this list

Every other option curl carries is refused by name, and says what would have
to exist here for it to work.
`

// What it wrote, in the order it wrote it, and the gap it met if it met one —
// carried on the result rather than in place of it, so a URL that answered
// before the gap is not lost to it.
function answer(state) {
  const events = [...state.events, ...(state.stderr ? [{ fd: 2, text: state.stderr }] : [])]
  const result = { stdout: '', stderr: state.stderr, exitCode: state.status, events }
  return state.gap ? markUnsupported(result, state.gap.kind, 'curl', state.gap.detail, state.gap.message) : result
}

// One URL: the request, the hops it may take, and what came back.
async function one(spelt, target, opts, state) {
  const read = readUrl(spelt)
  if (read.protocol) return gap(state, 'feature', 'protocol', 1, protocolMessage(read.protocol))
  if (read.malformed) return fail(state, 3, 'URL using bad/illegal format or missing URL')
  // `-O` names the file after the URL as it was given, before any redirect:
  // what was asked for is what the caller typed.
  const file = target?.remote ? remoteName(read.url) : target?.file ?? null
  const hop = { url: read.url, method: opts.method, body: opts.body, headers: opts.headers }
  // One deadline for the transfer rather than one per hop, since what
  // `--max-time` is given is the time this URL may take — the hops it turns
  // out to need included, as they are in curl.
  const signal = opts.timeout === null ? null : AbortSignal.timeout(opts.timeout)
  let headers = ''
  for (let followed = 0; ; followed++) {
    // oxlint-disable-next-line no-await-in-loop -- one hop of a chain after the last.
    const { response, failed } = await transfer(hop.url, init(hop, signal), opts.timeout)
    if (failed) return fail(state, failed.code, failed.message)
    // Under `-i` curl prints the headers of every response in the chain, the
    // hops included, because each of them is a response that arrived.
    if (opts.include || opts.head) headers += headerBlock(response, state.ctx)
    const next = redirect(response, hop, opts)
    if (next === null) return finish(response, hop.url, headers, file, opts, state)
    // oxlint-disable-next-line no-await-in-loop -- the hop's body is let go before the next request.
    await discard(response)
    if (followed >= opts.redirects) return fail(state, 47, `Maximum (${opts.redirects}) redirects followed`)
    if (next.protocol) return gap(state, 'feature', 'protocol', 1, protocolMessage(next.protocol))
    Object.assign(hop, next)
  }
}

const protocolMessage = (protocol) => `Protocol "${protocol}" not supported or disabled in libcurl`
const remoteName = (url) => url.pathname.slice(url.pathname.lastIndexOf('/') + 1)

const init = (hop, signal) => ({
  method: hop.method,
  headers: hop.headers,
  // Every hop is this code's to take or not take, so the runtime is told to
  // hand a redirect back rather than follow one: `-L` is the asking, and a
  // hop that would leave http or https is refused as a first request is.
  redirect: 'manual',
  ...(hop.body === null ? {} : { body: hop.body }),
  ...(signal === null ? {} : { signal }),
})

// Where a response says to go next, if it says so and `-L` asked. The method
// survives a 307 or a 308 and nothing else: the older three become a GET
// without a body, which is what every client does with them.
function redirect(response, hop, opts) {
  if (!opts.location || !REDIRECTS.has(response.status)) return null
  const location = response.headers.get('location')
  if (location === null || location === '') return null
  let url
  try { url = new URL(location, hop.url) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { protocol: url.protocol.slice(0, -1) }
  const rewritten = REWRITTEN.has(response.status) && hop.method !== 'HEAD' && hop.method !== 'GET'
  return {
    url,
    method: rewritten ? 'GET' : hop.method,
    body: rewritten ? null : hop.body,
    headers: rewritten ? withoutBody(hop.headers) : hop.headers,
  }
}

// A request that no longer carries a body says nothing about one.
function withoutBody(headers) {
  const left = new Headers(headers)
  left.delete('content-type')
  left.delete('content-length')
  return left
}

// The response the chain ended on: what `-f` makes of a failing status, and
// otherwise the headers if they were asked for and the body if there is one.
async function finish(response, url, headers, file, opts, state) {
  if (opts.failEarly && response.status >= 400) {
    await discard(response)
    return fail(state, 22, `The requested URL returned error: ${response.status}`)
  }
  // A HEAD asks for no body, and curl prints none for one.
  if (opts.head) {
    await discard(response)
    return write(headers, null, file, state)
  }
  const body = await receive(response, url, opts.timeout)
  if (body.failed) return fail(state, body.failed.code, body.failed.message)
  return write(headers, body.bytes, file, state)
}

// Headers are text and a body is bytes, and the two are one stream: a file
// takes the whole of it as bytes, and stdout takes the headers as the text
// they are — so a terminal reading its output as a string is never told that
// a header block spells no text when it is the body that does not.
function write(headers, body, file, state) {
  if (file !== null) return toFile(file, headers, body, state)
  if (headers !== '') state.events.push({ fd: 1, text: headers })
  if (body !== null && body.length > 0) state.events.push({ fd: 1, bytes: body })
  return true
}

// Into the overlay, which is the only place a file can be written here. A
// terminal without one says so rather than reporting a transfer that wrote
// nowhere.
function toFile(name, headers, body, state) {
  const { ctx } = state
  if (name === '') return fail(state, 23, 'Remote filename has no length')
  let handle
  try { handle = ctx.writable && ctx.fs.openWritable?.(ctx.cwd, name) } catch (e) { return fail(state, 23, `Failure writing output to destination: ${e.message}`) }
  if (!handle) return gap(state, 'feature', 'read-only target', 23, `${name}: file system is read-only`)
  handle.writeBytes(joinBytes([encodeUtf8(headers), body ?? new Uint8Array()]))
  return true
}

// The status line and the headers, rendered from what the runtime hands back
// rather than read off the wire: `fetch` reports neither the order the
// headers arrived in nor the version that carried them, so the block is the
// names lowercased and sorted, under a status line spelt the way curl spells
// an HTTP/1.1 one. The run says as much on the note channel, beside the
// answer, since it is a difference from the real tool rather than a failure.
function headerBlock(response, ctx) {
  ctx.notes?.add('curl: the response header block is rendered from the headers as the runtime hands them back: names lowercased and sorted, under a status line reading HTTP/1.1 whichever version the connection spoke')
  const lines = [`HTTP/1.1 ${response.status}${response.statusText === '' ? '' : ` ${response.statusText}`}`]
  // Cookies are the one header a response may carry several of, and the one
  // the iteration below cannot answer for: a runtime hands them back joined into
  // one value, or repeated once per cookie, and neither says how many were
  // sent. `getSetCookie` is the one that does, so it answers for all of them
  // at the place the first one sorts to, and the rest are passed over.
  const cookies = response.headers.getSetCookie?.() ?? []
  let written = false
  for (const [name, value] of response.headers) {
    if (name !== 'set-cookie') { lines.push(`${name}: ${value}`); continue }
    if (cookies.length === 0) { lines.push(`${name}: ${value}`); continue }
    if (written) continue
    written = true
    for (const cookie of cookies) lines.push(`${name}: ${cookie}`)
  }
  return lines.join('\r\n') + '\r\n\r\n'
}
