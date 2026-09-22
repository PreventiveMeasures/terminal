import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// curl is the one command here that reaches outside the tree, and the one no
// terminal has unless it was asked for. The request itself is the runtime's
// `fetch`, which answers asynchronously — a line waits for it where it meets
// it, as it waits for a compressor — so the `fetch` under test here is one of
// this file's own, recording what was asked of it and answering as a server
// would. What each transfer is held to is what curl 8.5.0 does with the same
// command line, and the exit codes are curl's own.
const SOURCES = {
  'a.txt': 'alpha\nbeta\n',
  'body.json': '{"a":1}\n',
  'img.png': Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0xff, 0x0a),
}
const HOST = 'https://api.test'
const online = (sources = SOURCES, opts = {}) => createTerminal(sources, { mount: '/repo', writable: '/tmp/', network: true, ...opts })
const offline = (sources = SOURCES, opts = {}) => createTerminal(sources, { mount: '/repo', writable: '/tmp/', ...opts })
const result = (stdout = '', { stderr = '', exitCode = 0, notes = [], unsupported = [] } = {}) =>
  ({ stdout, stderr, exitCode, cwd: '/repo', notes, unsupported })

const HEADER_NOTE = 'curl: the response header block is rendered from the headers as the runtime hands them back: names lowercased and sorted, under a status line reading HTTP/1.1 whichever version the connection spoke'

// Every request the line made, in order, with what it carried: a test asks
// what went out as readily as what came back, since half of what curl does is
// in the request.
function serving(t, routes) {
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: Object.fromEntries(init.headers ?? []),
      body: init.body === undefined ? null : new TextDecoder().decode(init.body),
      signal: init.signal ?? null,
      redirect: init.redirect,
    })
    const answer = typeof routes === 'function' ? routes(url, init) : routes[new URL(url).pathname]
    if (answer === undefined) return new Response('not a route\n', { status: 404, statusText: 'Not Found' })
    return typeof answer === 'function' ? answer(url, init) : answer
  })
  return calls
}

const text = (body, status = 200, headers = {}) => () => new Response(body, { status, statusText: status === 200 ? 'OK' : '', headers: { 'content-type': 'text/plain', ...headers } })
const moved = (to, status = 302) => () => new Response('', { status, headers: { location: to } })
const refused = (code, message) => () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) }) }

describe('a terminal has no network unless it asked for one', () => {
  it('does not have the command, and says which of the two reasons it is', async () => {
    const t = offline()
    const r = await t.run('curl https://example.test/')
    assert.equal(r.exitCode, 127)
    assert.match(r.stderr, /^curl: this terminal has no network\. `createTerminal` takes `network: true`/u)
    assert.deepEqual(r.unsupported.map(({ kind, command, detail }) => ({ kind, command, detail })), [{ kind: 'feature', command: 'curl', detail: 'network' }])
    // It is not in the list of names either, so nothing offers what is not there.
    assert.deepEqual(t.complete('cur'), [])
    assert.doesNotMatch(r.stderr, /Available:/u)
    // A bin-prefixed spelling is the same name, and gets the same answer.
    const bin = await t.run('/usr/bin/curl https://example.test/')
    assert.equal(bin.exitCode, 127)
    assert.match(bin.stderr, /^\/usr\/bin\/curl: this terminal has no network/u)
  })

  it('offers the name, and the list of names, once it has one', async () => {
    const t = online()
    assert.deepEqual(t.complete('cur'), ['curl'])
    assert.deepEqual(t.complete('cat a.txt | cur'), ['cat a.txt | curl'])
    const missing = await t.run('frobnicate')
    assert.match(missing.stderr, /Available: .*\bcurl\b/u)
  })

  it('leaves the name free for a caller to wire while the network is off', async () => {
    const wired = offline(SOURCES, { commands: { curl: () => 'mine\n' } })
    assert.deepEqual(await wired.run('curl https://example.test/'), result('mine\n'))
    // With a network it is a built-in, and a built-in is not redefinable.
    assert.throws(() => online(SOURCES, { commands: { curl: () => 'mine\n' } }), /curl: cannot redefine a built-in command/u)
  })

  it('takes true or false and nothing else', () => {
    assert.throws(() => createTerminal(SOURCES, { network: 'yes' }), /network must be true or false \(got string\)/u)
    assert.throws(() => createTerminal(SOURCES, { network: null }), /network must be true or false \(got null\)/u)
    assert.equal(typeof createTerminal(SOURCES, { network: false }).run, 'function')
  })

  it('is the terminal\'s rather than the line\'s, so a fork is over the same one', async (t) => {
    serving(t, { '/x': text('from the fork\n') })
    const parent = online()
    const child = parent.fork()
    assert.deepEqual(await child.run(`curl ${HOST}/x`), { ...result('from the fork\n'), cwd: '/repo' })
    assert.throws(() => parent.fork({ network: false }), /fork: unknown option `network`/u)
  })
})

describe('curl makes the request the command line describes', () => {
  it('writes the body to stdout, and hands it on as the bytes it is', async (t) => {
    const calls = serving(t, { '/x': text('hello\n'), '/img': () => new Response(SOURCES['img.png']) })
    const term = online()
    assert.deepEqual(await term.run(`curl ${HOST}/x`), result('hello\n'))
    assert.equal(calls[0].method, 'GET')
    assert.equal(calls[0].body, null)
    // A redirect is this code's to take or not take, so the runtime is asked
    // to hand one back rather than follow it.
    assert.equal(calls[0].redirect, 'manual')
    // Bytes that spell no text are what a pipe and a file take, and what this
    // terminal's own output says it cannot carry.
    assert.deepEqual(await term.run(`curl ${HOST}/img | base64`), result('iVBOR/8K\n'))
    assert.deepEqual(await term.run(`curl ${HOST}/img > /tmp/copy.png; sha256sum /tmp/copy.png`),
      result('679ae6a4120cc43d94e6462f34fa9fef218ba7de581f7e509e5bc5f924338b34  /tmp/copy.png\n'))
    const carried = await term.run(`curl ${HOST}/img`)
    assert.equal(carried.exitCode, 1)
    assert.deepEqual(carried.unsupported.map((u) => u.detail), ['partial UTF-8 byte sequence'])
  })

  it('reads a bare host as http, which is the one guess curl makes', async (t) => {
    const calls = serving(t, { '/plain': text('guessed\n') })
    assert.deepEqual(await online().run('curl api.test/plain'), result('guessed\n'))
    assert.equal(calls[0].url, 'http://api.test/plain')
  })

  it('prints the header block under -i, and says how it was rendered', async (t) => {
    serving(t, { '/x': text('hello\n', 200, { 'x-answer': '42' }) })
    const r = await online().run(`curl -i ${HOST}/x`)
    assert.equal(r.stdout, 'HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\nx-answer: 42\r\n\r\nhello\n')
    assert.deepEqual(r.notes, [HEADER_NOTE])
    assert.equal(r.exitCode, 0)
  })

  it('asks for the headers alone under -I', async (t) => {
    const calls = serving(t, { '/x': text('never read\n') })
    const r = await online().run(`curl -I ${HOST}/x`)
    assert.equal(calls[0].method, 'HEAD')
    assert.equal(r.stdout, 'HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\n')
  })

  it('takes several URLs one after another', async (t) => {
    const calls = serving(t, { '/one': text('1\n'), '/two': text('2\n') })
    assert.deepEqual(await online().run(`curl ${HOST}/one ${HOST}/two`), result('1\n2\n'))
    assert.deepEqual(calls.map((call) => call.url), [`${HOST}/one`, `${HOST}/two`])
  })

  it('prints its usage over a line that named no URL, and the list it points at', async () => {
    const term = online()
    const bare = await term.run('curl')
    assert.equal(bare.exitCode, 2)
    assert.match(bare.stderr, /^curl: try 'curl --help'/u)
    // The list it points at is a list of what this curl carries, not of what
    // curl has: it will not offer what it would then refuse.
    const help = await term.run('curl --help')
    assert.equal(help.exitCode, 0)
    assert.match(help.stdout, /^Usage: curl \[options\.\.\.\] <url>\n/u)
    assert.match(help.stdout, /^ -L, --location {11}follow a redirect, up to --max-redirs <num>$/mu)
    assert.doesNotMatch(help.stdout, /--insecure|--proxy|--cookie/u)
    assert.deepEqual(help.unsupported, [])
    // It answers before whatever else the line asked for, as curl does.
    assert.deepEqual(await term.run('curl -h https://api.test/x'), await term.run('curl --help'))
  })
})

describe('curl sends what it was told to send', () => {
  it('joins the data options in the order they were written', async (t) => {
    const calls = serving(t, { '/post': text('taken\n') })
    const term = online()
    await term.run(`curl -d one=1 -d two=2 ${HOST}/post`)
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].body, 'one=1&two=2')
    assert.equal(calls[0].headers['content-type'], 'application/x-www-form-urlencoded')
    // `@name` is a file of the virtual tree, whose line endings the text
    // forms drop and the binary form keeps; `--data-raw` takes the `@` as data.
    await term.run(`curl -d @body.json ${HOST}/post`)
    assert.equal(calls[1].body, '{"a":1}')
    await term.run(`curl --data-binary @a.txt ${HOST}/post`)
    assert.equal(calls[2].body, 'alpha\nbeta\n')
    await term.run(`curl --data-raw @a.txt ${HOST}/post`)
    assert.equal(calls[3].body, '@a.txt')
  })

  it('reads the pipe with @-, and takes it as read', async (t) => {
    const calls = serving(t, { '/post': text('taken\n') })
    assert.deepEqual(await online().run(`printf 'x=1' | curl -d @- ${HOST}/post`), result('taken\n'))
    assert.equal(calls[0].body, 'x=1')
    // What one command in a group takes is not there for the next to take.
    const shared = await online().run(`printf 'x=1' | { curl -d @- ${HOST}/post; cat; }`)
    assert.deepEqual(shared, result('taken\n'))
  })

  it('says so, rather than sending nothing, when the data file is not there', async (t) => {
    serving(t, { '/post': text('taken\n') })
    const r = await online().run(`curl -d @nope.json ${HOST}/post`)
    assert.equal(r.exitCode, 26)
    assert.equal(r.stderr, 'curl: (26) Failed to open/read local data from file/application\n')
  })

  it('carries --json as JSON, and refuses a body that is both', async (t) => {
    const calls = serving(t, { '/post': text('{}\n') })
    const term = online()
    await term.run(`curl --json '{"a":1}' ${HOST}/post`)
    assert.equal(calls[0].headers['content-type'], 'application/json')
    assert.equal(calls[0].headers.accept, 'application/json')
    assert.equal(calls[0].body, '{"a":1}')
    // `--json` is `--data-binary` under two headers, so a file it is given
    // keeps the line endings a document has.
    await term.run(`curl --json @body.json ${HOST}/post`)
    assert.equal(calls[1].body, '{"a":1}\n')
    const mixed = await term.run(`curl --json '{}' -d a=1 ${HOST}/post`)
    assert.equal(mixed.exitCode, 2)
    assert.equal(mixed.stderr, 'curl: --json cannot be mixed with --data\n')
    assert.equal(calls.length, 2)
  })

  it('sets the headers it was given, and the two it is a shorthand for', async (t) => {
    const calls = serving(t, { '/x': text('ok\n') })
    const term = online()
    await term.run(`curl -H 'X-One: 1' -H 'X-Two: 2' -H 'X-Empty;' -A reader/1 -u ada:secret ${HOST}/x`)
    assert.equal(calls[0].headers['x-one'], '1')
    assert.equal(calls[0].headers['x-two'], '2')
    assert.equal(calls[0].headers['x-empty'], '')
    assert.equal(calls[0].headers['user-agent'], 'reader/1')
    assert.equal(calls[0].headers.authorization, 'Basic YWRhOnNlY3JldA==')
    // A custom method, and the content type a body implies, which -H replaces.
    await term.run(`curl -X PATCH -d a=1 -H 'Content-Type: application/json' ${HOST}/x`)
    assert.equal(calls[1].method, 'PATCH')
    assert.equal(calls[1].headers['content-type'], 'application/json')
  })

  it('refuses the header spellings it cannot answer for', async (t) => {
    serving(t, { '/x': text('ok\n') })
    const term = online()
    // `Name:` takes away a header the runtime sends, which is the runtime's own.
    const taken = await term.run(`curl -H 'Accept:' ${HOST}/x`)
    assert.equal(taken.exitCode, 2)
    assert.deepEqual(taken.unsupported.map(({ kind, detail }) => ({ kind, detail })), [{ kind: 'option', detail: '-H' }])
    const malformed = await term.run(`curl -H nonsense ${HOST}/x`)
    assert.equal(malformed.exitCode, 2)
    assert.equal(malformed.stderr, 'curl: -H: not a header: nonsense\n')
    // A password curl would have prompted a terminal for, and there is none here.
    const prompted = await term.run(`curl -u ada ${HOST}/x`)
    assert.equal(prompted.exitCode, 2)
    assert.deepEqual(prompted.unsupported.map((u) => u.detail), ['-u'])
  })
})

describe('curl follows a redirect where -L asked for it', () => {
  const CHAIN = { '/go': moved('/there'), '/there': text('arrived\n'), '/loop': moved('/loop') }

  it('stays where it was sent without -L, and goes with it under -L', async (t) => {
    const calls = serving(t, CHAIN)
    const term = online()
    assert.deepEqual(await term.run(`curl ${HOST}/go`), result())
    assert.equal(calls.length, 1)
    assert.deepEqual(await term.run(`curl -L ${HOST}/go`), result('arrived\n'))
    assert.deepEqual(calls.slice(1).map((call) => call.url), [`${HOST}/go`, `${HOST}/there`])
  })

  it('prints every response in the chain under -i', async (t) => {
    serving(t, CHAIN)
    const r = await online().run(`curl -iL ${HOST}/go`)
    assert.equal(r.stdout, 'HTTP/1.1 302\r\ncontent-type: text/plain;charset=UTF-8\r\nlocation: /there\r\n\r\nHTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\narrived\n')
  })

  it('turns the older three into a GET and keeps the method on a 307', async (t) => {
    const calls = serving(t, { '/post': moved('/landed'), '/keep': moved('/landed', 307), '/landed': text('landed\n') })
    const term = online()
    await term.run(`curl -L -d a=1 ${HOST}/post`)
    assert.deepEqual(calls.map(({ method, body }) => ({ method, body })), [{ method: 'POST', body: 'a=1' }, { method: 'GET', body: null }])
    // A request that no longer carries a body says nothing about one.
    assert.equal(calls[1].headers['content-type'], undefined)
    await term.run(`curl -L -d a=1 ${HOST}/keep`)
    assert.deepEqual(calls.slice(2).map(({ method, body }) => ({ method, body })), [{ method: 'POST', body: 'a=1' }, { method: 'POST', body: 'a=1' }])
  })

  it('stops at the ceiling rather than going round for ever', async (t) => {
    const calls = serving(t, CHAIN)
    const term = online()
    const looped = await term.run(`curl -L ${HOST}/loop`)
    assert.equal(looped.exitCode, 47)
    assert.equal(looped.stderr, 'curl: (47) Maximum (50) redirects followed\n')
    assert.equal(calls.length, 51)
    const none = await term.run(`curl -L --max-redirs 0 ${HOST}/go`)
    assert.equal(none.exitCode, 47)
    assert.equal(none.stderr, 'curl: (47) Maximum (0) redirects followed\n')
  })

  it('holds a hop to the protocols a first request is held to', async (t) => {
    serving(t, { '/away': moved('ftp://api.test/x') })
    const r = await online().run(`curl -L ${HOST}/away`)
    assert.equal(r.exitCode, 1)
    assert.equal(r.stderr, 'curl: (1) Protocol "ftp" not supported or disabled in libcurl\n')
    assert.deepEqual(r.unsupported.map(({ kind, detail }) => ({ kind, detail })), [{ kind: 'feature', detail: 'protocol' }])
  })
})

describe('curl writes where it was told to write', () => {
  it('pairs -o and -O with the URLs in the order both were written', async (t) => {
    serving(t, { '/one': text('1\n'), '/two': text('2\n'), '/three': text('3\n') })
    const term = online()
    assert.deepEqual(await term.run(`cd /tmp && curl -o one.txt -O ${HOST}/one ${HOST}/two; cat /tmp/one.txt /tmp/two`),
      { ...result('1\n2\n'), cwd: '/tmp' })
    // A URL past the last output target writes to stdout, as it does in curl,
    // and `-o -` is stdout named.
    assert.deepEqual(await term.run(`curl -o /tmp/kept.txt ${HOST}/one ${HOST}/three`), { ...result('3\n'), cwd: '/tmp' })
    assert.deepEqual(await term.run(`curl -o - ${HOST}/one`), { ...result('1\n'), cwd: '/tmp' })
  })

  it('writes the headers into the file too, where -i asked for them', async (t) => {
    serving(t, { '/x': text('hello\n') })
    const r = await online().run(`curl -i -o /tmp/full.txt ${HOST}/x; cat /tmp/full.txt`)
    assert.equal(r.stdout, 'HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\nhello\n')
  })

  it('says a file system that cannot be written is one, rather than writing nowhere', async (t) => {
    serving(t, { '/x': text('hello\n') })
    const r = await online(SOURCES, { writable: false }).run(`curl -o out.txt ${HOST}/x`)
    assert.equal(r.exitCode, 23)
    assert.equal(r.stderr, 'curl: (23) out.txt: file system is read-only\n')
    assert.deepEqual(r.unsupported.map(({ kind, detail }) => ({ kind, detail })), [{ kind: 'feature', detail: 'read-only target' }])
  })

  it('has nothing to call a file where the URL ends in a slash', async (t) => {
    serving(t, { '/': text('root\n') })
    const r = await online().run(`cd /tmp && curl -O ${HOST}/`)
    assert.equal(r.exitCode, 23)
    assert.equal(r.stderr, 'curl: (23) Remote filename has no length\n')
  })
})

describe('curl reports a transfer that failed the way curl reports it', () => {
  it('gives each failure curl\'s own number', async (t) => {
    const term = online()
    const cases = [
      ['/resolve', refused('ENOTFOUND', 'getaddrinfo ENOTFOUND api.test'), 6, 'curl: (6) Could not resolve host: api.test\n'],
      ['/connect', refused('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:443'), 7, 'curl: (7) Failed to connect to api.test port 443: connect ECONNREFUSED 127.0.0.1:443\n'],
      ['/reset', refused('ECONNRESET', 'socket hang up'), 56, 'curl: (56) Recv failure: socket hang up\n'],
      ['/cert', refused('CERT_HAS_EXPIRED', 'certificate has expired'), 60, 'curl: (60) SSL certificate problem: certificate has expired\n'],
    ]
    for (const [path, route, code, stderr] of cases) {
      serving(t, { [path]: route })
      // oxlint-disable-next-line no-await-in-loop -- one failure after the last.
      const r = await term.run(`curl ${HOST}${path}`)
      assert.equal(r.exitCode, code, path)
      assert.equal(r.stderr, stderr, path)
      assert.deepEqual(r.unsupported, [], path)
    }
  })

  it('puts a deadline on the request where --max-time asked for one', async (t) => {
    const calls = serving(t, { '/slow': () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) } })
    const r = await online().run(`curl -m 2 ${HOST}/slow`)
    assert.equal(r.exitCode, 28)
    assert.equal(r.stderr, 'curl: (28) Operation timed out after 2000 milliseconds\n')
    assert.equal(calls[0].signal instanceof AbortSignal, true)
    const misspelt = await online().run(`curl -m soon ${HOST}/slow`)
    assert.equal(misspelt.exitCode, 2)
    assert.equal(misspelt.stderr, 'curl: option --max-time: expected a proper numerical parameter\n')
  })

  it('makes -f a failing status, and leaves the body alone without it', async (t) => {
    serving(t, { '/gone': text('sorry\n', 404) })
    const term = online()
    assert.deepEqual(await term.run(`curl ${HOST}/gone`), result('sorry\n'))
    const failed = await term.run(`curl -f ${HOST}/gone`)
    assert.equal(failed.exitCode, 22)
    assert.equal(failed.stdout, '')
    assert.equal(failed.stderr, 'curl: (22) The requested URL returned error: 404\n')
  })

  it('is silent about a transfer under -s, and says it again under -S', async (t) => {
    serving(t, { '/connect': refused('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:443') })
    const term = online()
    const quiet = await term.run(`curl -s ${HOST}/connect`)
    assert.equal(quiet.stderr, '')
    assert.equal(quiet.exitCode, 7)
    const shown = await term.run(`curl -sS ${HOST}/connect`)
    assert.match(shown.stderr, /^curl: \(7\) Failed to connect/u)
    assert.equal(shown.exitCode, 7)
  })

  it('exits on the last transfer that failed', async (t) => {
    serving(t, { '/one': text('1\n'), '/gone': text('no\n', 404) })
    const r = await online().run(`curl -f ${HOST}/gone ${HOST}/one`)
    assert.equal(r.stdout, '1\n')
    assert.equal(r.exitCode, 22)
  })

  it('refuses a URL it cannot read and a protocol it does not speak', async (t) => {
    serving(t, {})
    const term = online()
    const malformed = await term.run('curl "ht tp://not a url"')
    assert.equal(malformed.exitCode, 3)
    assert.equal(malformed.stderr, 'curl: (3) URL using bad/illegal format or missing URL\n')
    for (const url of ['file:///etc/passwd', 'data:text/plain,hi', 'ftp://api.test/x']) {
      // oxlint-disable-next-line no-await-in-loop -- one URL after the last.
      const r = await term.run(`curl ${url}`)
      assert.equal(r.exitCode, 1, url)
      assert.deepEqual(r.unsupported.map(({ kind, detail }) => ({ kind, detail })), [{ kind: 'feature', detail: 'protocol' }], url)
    }
  })
})

describe('curl refuses what it cannot do rather than dropping it', () => {
  it('names the option, and what would have to exist for it to work', async (t) => {
    serving(t, { '/x': () => new Response('ok\n') })
    const term = online()
    for (const [option, detail] of [
      ['-k', '-k'], ['--insecure', '--insecure'], ['-v', '-v'], ['-x http://proxy.test', '-x'],
      ['-b jar.txt', '-b'], ['-w "%{http_code}"', '-w'], ['-T a.txt', '-T'], ['-F a=@a.txt', '-F'],
      ['-G', '-G'], ['-r 0-99', '-r'], ['-E cert.pem', '-E'], ['--retry 3', '--retry'],
      ['--connect-timeout 2', '--connect-timeout'], ['-D headers.txt', '-D'],
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one option after the last.
      const r = await term.run(`curl ${option} ${HOST}/x`)
      assert.equal(r.exitCode, 2, option)
      assert.deepEqual(r.unsupported.map(({ kind, command, detail: seen }) => ({ kind, command, detail: seen })),
        [{ kind: 'option', command: 'curl', detail }], option)
      assert.notEqual(r.stderr, '', option)
    }
  })

  it('reports an option it does not have, wherever the line hides its stderr', async (t) => {
    serving(t, { '/x': () => new Response('ok\n') })
    const term = online()
    const direct = await term.run('curl --audit-missing-option')
    assert.deepEqual(direct.unsupported.map(({ kind, command, detail }) => ({ kind, command, detail })),
      [{ kind: 'option', command: 'curl', detail: '--audit-missing-option' }])
    for (const line of [
      'curl --audit-missing-option 2>/dev/null | cat',
      '{ curl --audit-missing-option; } >/dev/null 2>&1 || true',
      'for u in one two; do curl --audit-missing-option; done 2>/dev/null',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one line after the last.
      const r = await term.run(line)
      assert.deepEqual(r.unsupported.map((u) => u.detail), ['--audit-missing-option'], line)
      assert.equal(r.stderr, '', line)
    }
  })

  it('keeps what a URL before the gap had already written', async (t) => {
    serving(t, { '/one': text('1\n') })
    const r = await online().run(`curl ${HOST}/one file:///etc/passwd`)
    assert.equal(r.stdout, '1\n')
    assert.equal(r.exitCode, 1)
    assert.deepEqual(r.unsupported.map((u) => u.detail), ['protocol'])
  })

  it('accepts the two that ask for what it does anyway', async (t) => {
    const calls = serving(t, { '/x': text('ok\n') })
    // The runtime decompresses what it is sent, and there is no meter to hide.
    assert.deepEqual(await online().run(`curl --compressed --no-progress-meter ${HOST}/x`), result('ok\n'))
    assert.equal(calls.length, 1)
  })
})
