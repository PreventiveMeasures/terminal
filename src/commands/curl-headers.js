import { toBase64 } from '@exodus/bytes/base64.js'
import { encodeUtf8 } from '../util.js'
import { gap } from './curl-options.js'

// What a request carries, as curl puts it together: its own headers —
// User-Agent, Accept, and for a body Content-Type — each of which a `-H` of
// the same name replaces, and the `-H` ones after them; nothing off the host,
// no environment, no stored credential.
//
// The request is the runtime's `fetch`, which sends some of its own whatever
// it is told: `connection`, `accept-language: *` and `sec-fetch-mode: cors`
// always, every name in lower case and in an order of its own, and an
// `accept-encoding` where it is given none — which is set here to `identity`,
// the coding curl's request asks for by naming none, so that a server answers
// in the bytes curl would get. Those are what this curl cannot take back;
// what is refused below is every header a line asks for that the runtime
// would send differently, or not at all.

const FORM_TYPE = 'application/x-www-form-urlencoded'
const JSON_TYPE = 'application/json'
// What `--compressed` asks for, as curl 8.5 asks for it.
export const CODINGS = 'deflate, gzip, br, zstd'
// curl asks a server to wait for a large body before sending it.
const EXPECT_THRESHOLD = 1024 * 1024

// Headers a line cannot take away, since the runtime sends them regardless.
const KEPT = new Set(['host', 'user-agent', 'accept'])
// Headers the runtime will not send as written, or at all.
const FIXED = new Set(['host', 'expect', 'transfer-encoding', 'keep-alive', 'upgrade', 'content-length'])
const HEADER_OPTIONS = new Set(['H', 'header'])

export function requestHeaders({ values, order, body, compressed, state }) {
  const headers = new Headers()
  const implied = new Set()
  const agent = values.get('A') ?? values.get('user-agent')
  if (agent === '') return gap(state, 'option', '-A', 2, '-A "": a request without a User-Agent cannot be made here; the runtime sends one')
  headers.set('user-agent', agent ?? 'curl/8.5.0')
  headers.set('accept', body.json ? JSON_TYPE : '*/*')
  headers.set('accept-encoding', compressed ? CODINGS : 'identity')
  const credentials = values.get('u') ?? values.get('user')
  if (credentials !== undefined) {
    // curl asks a terminal for the password a `-u user` leaves out, and there
    // is no terminal here to ask — the same reason `read` is not a builtin.
    if (!credentials.includes(':')) return gap(state, 'feature', '-u', 2, 'there is no interactive input here to read a password from')
    headers.set('authorization', `Basic ${toBase64(encodeUtf8(credentials))}`)
  }
  if (body.bytes !== null) {
    headers.set('content-type', body.json ? JSON_TYPE : FORM_TYPE)
    implied.add('content-type')
  }
  const sent = new Set()
  let expect = body.bytes !== null && body.bytes.length > EXPECT_THRESHOLD
  for (const { name, value } of order) {
    if (!HEADER_OPTIONS.has(name)) continue
    const header = customHeader(value)
    if (header === null) continue
    if (header.name.toLowerCase() === 'expect' && header.value === null) expect = false
    if (!setCustom(headers, implied, header, sent, state, value, body.bytes !== null)) return null
  }
  if (expect) return gap(state, 'feature', 'Expect', 2, 'a body over 1 MiB is sent after `Expect: 100-continue`, which the runtime does not do; -H "Expect:" sends it without')
  return { list: headers, implied }
}

// libcurl's reading of a `-H`: `Name: value` sends it, `Name;` sends it
// empty, `Name:` with nothing after it sends nothing and takes away a header
// of that name curl would have sent. Anything else — no colon, a name that
// is empty, a `;` with something after it — is no header at all, and curl
// sends nothing for it.
function customHeader(written) {
  const colon = written.indexOf(':')
  if (colon === -1) {
    const semicolon = written.indexOf(';')
    if (semicolon <= 0 || written.slice(semicolon + 1).trim() !== '') return null
    return { name: written.slice(0, semicolon), value: '' }
  }
  if (colon === 0) return null
  const value = written.slice(colon + 1).replace(/^[ \t\n\v\f\r]+/u, '')
  return { name: written.slice(0, colon), value: value === '' ? null : value }
}

function setCustom(headers, implied, { name, value }, sent, state, written, hasBody) {
  const key = name.toLowerCase()
  const refuse = (why) => gap(state, 'option', '-H', 2, `-H ${JSON.stringify(written)}: ${why}`)
  if (value === null) {
    // The runtime sends a body's length whatever the line says, so taking
    // it away is refused wherever there is a body, typed or not.
    if (KEPT.has(key) || (key === 'content-length' && hasBody)) return refuse('taking away a header the runtime sends is not supported')
    if (key !== 'accept-encoding') headers.delete(key)
    implied.delete(key)
    return true
  }
  if (FIXED.has(key)) return refuse('the runtime sends this header its own way, or not at all')
  if (key === 'connection' && !/^(?:close|keep-alive)$/iu.test(value.trim())) return refuse('the runtime sends this header its own way, or not at all')
  if (key === 'sec-fetch-mode' && value.trim() !== 'cors') return refuse('the runtime sends this header its own way, or not at all')
  // curl sends each -H line as it is, so a name given twice goes twice; the
  // runtime joins them into one.
  if (sent.has(key)) return refuse('a header given twice is sent once, joined, by the runtime')
  sent.add(key)
  // The bytes of the value as written, which the runtime writes one per
  // character: past ASCII, that is the UTF-8 curl would send.
  const bytes = Array.from(encodeUtf8(value), (byte) => String.fromCodePoint(byte)).join('')
  try { headers.set(name, bytes) } catch { return refuse('the runtime will not send this header') }
  implied.delete(key)
  return true
}
