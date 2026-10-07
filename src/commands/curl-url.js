import { toBase64 } from '@exodus/bytes/base64.js'
import { encodeUtf8 } from '../util.js'

// A URL as curl reads it, held to what the runtime's own URL parser makes of
// it — which is what `fetch` will send, and the one thing this curl cannot
// tell it otherwise.
//
// curl sends the path and query of a URL nearly as written: it drops the
// fragment, takes out `.` and `..` segments, writes the bytes past ASCII in
// the path as `%xx` in lowercase, and leaves everything else alone. The
// runtime's parser is the WHATWG one, which encodes a good deal more —
// quotes, angle brackets, a `'` in a query, bytes past ASCII in uppercase —
// reads `%2e` as a dot and `\` as `/`. Where the two would put different
// bytes on the request line, the URL is refused rather than sent as the
// runtime spells it.

const SCHEMES = Object.freeze(['http:', 'https:'])
const SCHEME_WRITTEN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u

// curl guesses a scheme for a URL that names none by how the host starts,
// and http for any other.
const GUESSED = [['ftp.', 'ftp'], ['dict.', 'dict'], ['ldap.', 'ldap'], ['imap.', 'imap'], ['smtp.', 'smtp'], ['pop3.', 'pop3']]

// What a URL comes to: the URL, and the credentials it carried, which curl
// sends as basic authentication where `-u` does not; or why it cannot be
// asked for. `malformed` is curl's code 3, with curl's words where they are
// known; `refused` is a URL this curl would send differently.
export function readCurlUrl(text, globoff) {
  if (!globoff && globbed(text)) return { refused: ['URL globbing', 'URL globbing ([...] and {...} ranges) is not supported; -g reads them as they are written'] }
  // A blank is no part of a URL to curl.
  if (text.includes(' ')) return { malformed: 'URL rejected: Malformed input to a URL function' }
  if ([...text].some((c) => c.codePointAt(0) < 0x20 || c.codePointAt(0) === 0x7f)) return { refused: ['URL control character', 'a URL holding a control character is not supported'] }
  // A scheme is a name, a colon and a slash, which curl takes with one to
  // three of them; a URL without one gets the scheme its host suggests.
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):(\/+)/u.exec(text)
  if (scheme && scheme[2].length > 3) return { malformed: 'URL rejected: Unsupported number of slashes following scheme' }
  const spelt = scheme ? `${scheme[1]}://${text.slice(scheme[0].length)}` : `${guessScheme(text)}://${text}`
  let url
  try { url = new URL(spelt) } catch { return { malformed: null } }
  if (!SCHEMES.includes(url.protocol)) return { protocol: url.protocol.slice(0, -1) }
  if (url.hostname === '') return { malformed: null }
  const auth = credentials(url)
  if (auth === null) return { refused: ['URL credentials', 'credentials in a URL that do not decode are not supported'] }
  if (target(url) !== sentTarget(spelt)) return { refused: ['URL rewriting', `the runtime would send ${JSON.stringify(text)} as ${JSON.stringify(url.href)}, which is not what curl sends`] }
  return { url, auth }
}

function guessScheme(text) {
  const host = text.toLowerCase()
  return GUESSED.find(([prefix]) => host.startsWith(prefix))?.[1] ?? 'http'
}

// curl's globbing: a `[...]` or `{...}` anywhere but around an IPv6 address
// in the host, which it reads as one.
function globbed(text) {
  const start = SCHEME_WRITTEN.exec(text)?.[0].length ?? 0
  const host = /^(?:[^/?#@]*@)?\[[0-9a-fA-F:.]+(?:%[0-9a-zA-Z._~-]+)?\]/u.exec(text.slice(start))
  const rest = host ? text.slice(0, start) + text.slice(start + host[0].length) : text
  return /[[\]{}]/u.test(rest)
}

// The user and password a URL carries, decoded as curl decodes them, and
// taken out of the URL the runtime is handed — it will not take a URL that
// has them. Empty for a URL with none, null for a percent-escape that does
// not decode.
function credentials(url) {
  if (url.username === '' && url.password === '') return ''
  let pair
  try { pair = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` } catch { return null }
  url.username = ''
  url.password = ''
  return `Basic ${toBase64(encodeUtf8(pair))}`
}

// The request target the runtime sends, as bytes: the serialized URL from
// its path on, less the fragment.
function target(url) {
  const bare = new URL(url)
  bare.hash = ''
  return bare.href.slice(bare.origin.length)
}

// The request target curl sends for what was typed, as bytes (one character
// per byte).
function sentTarget(spelt) {
  let rest = spelt.slice(SCHEME_WRITTEN.exec(spelt)[0].length)
  rest = rest.slice(rest.search(/[/?#]|$/u))
  const hash = rest.indexOf('#')
  if (hash !== -1) rest = rest.slice(0, hash)
  const mark = rest.indexOf('?')
  const path = mark === -1 ? rest : rest.slice(0, mark)
  const query = mark === -1 ? '' : rest.slice(mark)
  const bytes = (text) => Array.from(encodeUtf8(text), (byte) => String.fromCodePoint(byte)).join('')
  const encoded = [...bytes(withoutDots(path === '' ? '/' : path))].map((c) => c.codePointAt(0) > 0x7f ? '%' + c.codePointAt(0).toString(16).padStart(2, '0') : c).join('')
  return encoded + bytes(query)
}

// RFC 3986 remove_dot_segments, which curl applies to a path as written.
function withoutDots(path) {
  const out = []
  let input = path
  while (input !== '') {
    if (input.startsWith('../')) input = input.slice(3)
    else if (input.startsWith('./') || input.startsWith('/./')) input = input.slice(2)
    else if (input === '/.') input = '/'
    else if (input.startsWith('/../') || input === '/..') { input = '/' + input.slice(4); out.pop() }
    else if (input === '.' || input === '..') input = ''
    else {
      const segment = /^\/?[^/]*/u.exec(input)[0]
      out.push(segment)
      input = input.slice(segment.length)
    }
  }
  return out.join('')
}

// A redirect is followed to a URL the response named, which curl reads with
// its own parser and the runtime with its own: one written in characters both
// leave alone is the one place this terminal can be sure they agree.
export const plainLocation = (location) => /^[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]*$/u.test(location) && !/%2e/iu.test(location)
