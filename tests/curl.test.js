import assert from 'node:assert/strict'
import { ReadableStream } from 'node:stream/web'
import { describe, it } from 'node:test'
import { TextEncoder } from 'node:util'
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

const TRY = "curl: try 'curl --help' or 'curl --manual' for more information\n"
const feed = (r) => r.unsupported.map(({ kind, detail }) => ({ kind, detail }))

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
  it('does not have the command, and says no more than that', async () => {
    const t = offline()
    const r = await t.run('curl https://example.test/')
    assert.equal(r.exitCode, 127)
    assert.deepEqual(r.unsupported.map(({ kind, command, detail }) => ({ kind, command, detail })), [{ kind: 'command', command: 'curl', detail: 'curl' }])
    // Word for word the miss any other name gets, with `curl` not among the
    // names it offers — the compressors and the digests read the same way
    // where the runtime cannot do their work, and for the same reason: how a
    // terminal was built is nothing a line running inside it can act on, so
    // nothing tells it.
    const other = await t.run('frobnicate https://example.test/')
    assert.match(r.stderr, /^curl: command not found\. Available: /u)
    assert.equal(r.stderr.replace('curl', 'frobnicate'), other.stderr)
    assert.doesNotMatch(r.stderr, /network|createTerminal|fetch/u)
    // It is not in the list of names either, so nothing offers what is not there.
    assert.deepEqual(t.complete('cur'), [])
    // A bin-prefixed spelling is a name like any other, and misses like one.
    const bin = await t.run('/usr/bin/curl https://example.test/')
    assert.equal(bin.exitCode, 127)
    assert.match(bin.stderr, /^\/usr\/bin\/curl: command not found\. Available: /u)
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
    assert.deepEqual(await term.run(`curl -s ${HOST}/img | base64`), result('iVBOR/8K\n'))
    assert.deepEqual(await term.run(`curl -s ${HOST}/img > /tmp/copy.png; sha256sum /tmp/copy.png`),
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

  it('refuses -i and -I, whose header block the runtime does not hand back as it came', async (t) => {
    const calls = serving(t, { '/x': text('hello\n', 200, { 'x-answer': '42' }) })
    for (const option of ['-i', '-I']) {
      // oxlint-disable-next-line no-await-in-loop -- one option after the last.
      const r = await online().run(`curl ${option} ${HOST}/x`)
      assert.deepEqual([r.stdout, r.exitCode, feed(r)], ['', 2, [{ kind: 'option', detail: option }]], option)
    }
    assert.equal(calls.length, 0)
    // A body and -I ask for two methods, which curl says before anything else.
    const both = await online().run(`curl -I -d a ${HOST}/x`)
    assert.deepEqual([both.stderr, both.exitCode, both.unsupported], ['Warning: You can only select one HTTP request method! You asked for both POST \nWarning: (-d, --data) and HEAD (-I, --head).\n', 2, []])
  })

  it('sends curl\'s own headers, and the coding curl\'s request asks for', async (t) => {
    const calls = serving(t, { '/x': text('ok\n') })
    await online().run(`curl ${HOST}/x`)
    assert.deepEqual([calls[0].headers['user-agent'], calls[0].headers.accept, calls[0].headers['accept-encoding']], ['curl/8.5.0', '*/*', 'identity'])
    await online().run(`curl --compressed ${HOST}/x`)
    assert.equal(calls[1].headers['accept-encoding'], 'deflate, gzip, br, zstd')
    // A request with no User-Agent is one the runtime will not make.
    const bare = await online().run(`curl -A '' ${HOST}/x`)
    assert.deepEqual([bare.exitCode, feed(bare)], [2, [{ kind: 'option', detail: '-A' }]])
  })

  it('takes several URLs one after another', async (t) => {
    const calls = serving(t, { '/one': text('1\n'), '/two': text('2\n') })
    assert.deepEqual(await online().run(`curl ${HOST}/one ${HOST}/two`), result('1\n2\n'))
    assert.deepEqual(calls.map((call) => call.url), [`${HOST}/one`, `${HOST}/two`])
  })

  it('prints curl\'s usage over a line that named no URL, and curl\'s list for --help', async () => {
    const term = online()
    const bare = await term.run('curl')
    assert.deepEqual([bare.stderr, bare.exitCode], [TRY, 2])
    const silent = await term.run('curl -s')
    assert.deepEqual([silent.stderr, silent.exitCode], [`curl: (2) no URL specified\n${TRY}`, 2])
    const help = await term.run('curl --help')
    assert.equal(help.exitCode, 0)
    assert.match(help.stdout, /^Usage: curl \[options\.\.\.\] <url>\n -d, --data <data> {10}HTTP POST data\n/u)
    assert.match(help.stdout, /For all options use the manual or "--help all"\.\n$/u)
    assert.deepEqual(await term.run('curl -sh'), help)
    // Anything after it is a category curl would list, which is not kept here.
    const category = await term.run('curl -h https://api.test/x')
    assert.deepEqual([category.exitCode, feed(category)], [2, [{ kind: 'option', detail: '--help' }]])
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
    const calls = serving(t, { '/post': text('taken\n') })
    const r = await online().run(`curl -d @nope.json ${HOST}/post`)
    assert.equal(r.exitCode, 26)
    assert.equal(r.stderr, `curl: Failed to open nope.json\ncurl: option -d: error encountered when reading a file\n${TRY}`)
    // -s silences the first of the two, where it comes before the option.
    assert.equal((await online().run(`curl -s --data @nope.json ${HOST}/post`)).stderr, `curl: option --data: error encountered when reading a file\n${TRY}`)
    assert.equal(calls.length, 0)
  })

  it('carries --json as JSON, and joins it to data the way curl does', async (t) => {
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
    // A `--json` piece joins on to what came before, anything else after a `&`.
    await term.run(`curl -d a --json b --json c -d d ${HOST}/post`)
    assert.deepEqual([calls[2].body, calls[2].headers['content-type']], ['abc&d', 'application/json'])
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
    const calls = serving(t, { '/x': text('ok\n') })
    const term = online()
    // `Name:` takes away a header the runtime sends, which is the runtime's own.
    const taken = await term.run(`curl -H 'Accept:' ${HOST}/x`)
    assert.equal(taken.exitCode, 2)
    assert.deepEqual(feed(taken), [{ kind: 'option', detail: '-H' }])
    // The runtime sends its own Host, and will not send some headers at all.
    for (const header of ['Host: example.test', 'Expect: 100-continue', 'Transfer-Encoding: chunked', 'X-Twice: 1']) {
      // oxlint-disable-next-line no-await-in-loop -- one header after the last.
      const r = await term.run(`curl -H '${header}' -H 'X-Twice: 2' ${HOST}/x`)
      assert.deepEqual([r.exitCode, feed(r)], [2, [{ kind: 'option', detail: '-H' }]], header)
    }
    // What is no header to curl is not one here either: it sends nothing for it.
    assert.deepEqual(await term.run(`curl -H nonsense -H ': empty' -H 'X-Gone:' ${HOST}/x`), result('ok\n'))
    assert.deepEqual(Object.keys(calls[0].headers).sort(), ['accept', 'accept-encoding', 'user-agent'])
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

  it('keeps a method -X named on every hop, without the body a GET would drop', async (t) => {
    const calls = serving(t, { '/post': moved('/landed'), '/landed': text('landed\n') })
    await online().run(`curl -L -X POST -d a=1 ${HOST}/post`)
    assert.deepEqual(calls.map(({ method, body }) => ({ method, body })), [{ method: 'POST', body: 'a=1' }, { method: 'POST', body: null }])
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

  it('leaves the credential behind on a hop to another origin', async (t) => {
    const calls = serving(t, {
      '/same': moved('/landed'), '/away': moved('https://elsewhere.test/landed'),
      '/plain': moved('http://api.test/landed'), '/port': moved('https://api.test:8443/landed'),
      '/landed': text('landed\n'),
    })
    const term = online()
    const sent = (at) => ({ authorization: calls[at].headers.authorization, cookie: calls[at].headers.cookie, tok: calls[at].headers['x-tok'] })
    // The origin that was asked for is the origin the credential was for, so
    // a hop within it carries it and a hop out of it does not — which is what
    // curl does without `--location-trusted`, and what `fetch` does for a
    // redirect it follows itself.
    await term.run(`curl -L -u ada:secret -H 'Cookie: s=1' -H 'X-Tok: keep' ${HOST}/same`)
    assert.deepEqual(sent(1), { authorization: 'Basic YWRhOnNlY3JldA==', cookie: 's=1', tok: 'keep' })
    await term.run(`curl -L -u ada:secret -H 'Cookie: s=1' -H 'X-Tok: keep' ${HOST}/away`)
    assert.equal(calls[3].url, 'https://elsewhere.test/landed')
    assert.deepEqual(sent(3), { authorization: undefined, cookie: undefined, tok: 'keep' })
    // A host that stays and a scheme or a port that does not is another
    // origin too: the credential would be going somewhere else either way.
    await term.run(`curl -L -u ada:secret ${HOST}/plain`)
    assert.equal(sent(5).authorization, undefined)
    await term.run(`curl -L -u ada:secret ${HOST}/port`)
    assert.equal(sent(7).authorization, undefined)
    // What is left of the request is what it was: only the credential goes.
    assert.equal(calls[7].method, 'GET')
  })

  it('refuses the option that would send the credential anyway', async (t) => {
    serving(t, { '/away': moved('https://elsewhere.test/landed') })
    const r = await online().run(`curl -L --location-trusted -u ada:secret ${HOST}/away`)
    assert.equal(r.exitCode, 2)
    assert.deepEqual(r.unsupported.map(({ kind, detail }) => ({ kind, detail })), [{ kind: 'option', detail: '--location-trusted' }])
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
    assert.deepEqual(await term.run(`cd /tmp && curl -s -o one.txt -O ${HOST}/one ${HOST}/two; cat /tmp/one.txt /tmp/two`),
      { ...result('1\n2\n'), cwd: '/tmp' })
    // A URL past the last output target writes to stdout, as it does in curl,
    // and `-o -` is stdout named.
    assert.deepEqual(await term.run(`curl -s -o /tmp/kept.txt ${HOST}/one ${HOST}/three`), { ...result('3\n'), cwd: '/tmp' })
    assert.deepEqual(await term.run(`curl -o - ${HOST}/one`), { ...result('1\n'), cwd: '/tmp' })
    assert.deepEqual(await term.run(`curl -s -o /dev/null ${HOST}/one`), { ...result(), cwd: '/tmp' })
  })

  it('refuses the progress meter curl draws where its output is not the terminal', async (t) => {
    const calls = serving(t, { '/x': text('hello\n') })
    const term = online()
    for (const line of [`curl -o /tmp/x ${HOST}/x`, `curl ${HOST}/x | cat`, `curl ${HOST}/x > /tmp/y`]) {
      // oxlint-disable-next-line no-await-in-loop -- one line after the last.
      const r = await term.run(line)
      assert.deepEqual(feed(r), [{ kind: 'feature', detail: 'progress meter' }], line)
    }
    assert.equal(calls.length, 0)
    // Silent, without the meter, or with nowhere for it to be seen, there is none.
    for (const line of [`curl -s ${HOST}/x | cat`, `curl --no-progress-meter -o /tmp/x ${HOST}/x`, `curl ${HOST}/x 2>/dev/null | cat`]) {
      // oxlint-disable-next-line no-await-in-loop -- one line after the last.
      assert.deepEqual((await term.run(line)).unsupported, [], line)
    }
  })

  it('says a file system that cannot be written is one, rather than writing nowhere', async (t) => {
    serving(t, { '/x': text('hello\n') })
    const r = await online(SOURCES, { writable: false }).run(`curl -s -o out.txt ${HOST}/x`)
    assert.equal(r.exitCode, 23)
    assert.equal(r.stderr, 'curl: (23) out.txt: file system is read-only\n')
    assert.deepEqual(r.unsupported.map(({ kind, detail }) => ({ kind, detail })), [{ kind: 'feature', detail: 'read-only target' }])
  })

  it('has nothing to call a file where the URL ends in a slash', async (t) => {
    serving(t, { '/': text('root\n') })
    const r = await online().run(`cd /tmp && curl -O ${HOST}/`)
    assert.equal(r.exitCode, 23)
    assert.equal(r.stderr, 'curl: Remote file name has no length\ncurl: (23) Failed writing received data to disk/application\n')
  })
})

describe('curl reports a transfer that failed the way curl reports it', () => {
  it('gives each failure curl\'s own number, and curl\'s words where they are known', async (t) => {
    const term = online()
    serving(t, { '/resolve': refused('ENOTFOUND', 'getaddrinfo ENOTFOUND api.test') })
    assert.deepEqual(await term.run(`curl ${HOST}/resolve`), result('', { stderr: 'curl: (6) Could not resolve host: api.test\n', exitCode: 6 }))
    // curl says how long it waited, which only its own connection knows: a
    // quiet line gets curl's answer, and one that would print it a gap.
    for (const [path, route, code] of [
      ['/connect', refused('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:443'), 7],
      ['/reset', refused('ECONNRESET', 'socket hang up'), 56],
      ['/cert', refused('CERT_HAS_EXPIRED', 'certificate has expired'), 60],
    ]) {
      serving(t, { [path]: route })
      // oxlint-disable-next-line no-await-in-loop -- one failure after the last.
      assert.deepEqual(await term.run(`curl -s ${HOST}${path}`), result('', { exitCode: code }), path)
      // oxlint-disable-next-line no-await-in-loop -- one failure after the last.
      const told = await term.run(`curl ${HOST}${path}`)
      assert.deepEqual([told.exitCode, feed(told)], [code, [{ kind: 'feature', detail: 'transfer error message' }]], path)
    }
  })

  it('writes what came of a body that stopped short, then says by how much', async (t) => {
    const cut = () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('only ten\n\n')) },
      pull(controller) { controller.error(Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })) },
    }), { headers: { 'content-length': '100' } })
    serving(t, { '/cut': cut })
    assert.deepEqual(await online().run(`curl ${HOST}/cut`), result('only ten\n\n', { stderr: 'curl: (18) transfer closed with 90 bytes remaining to read\n', exitCode: 18 }))
  })

  it('refuses an answer the runtime decoded where curl would write it encoded', async (t) => {
    serving(t, { '/gz': text('decoded\n', 200, { 'content-encoding': 'gzip' }) })
    const plain = await online().run(`curl ${HOST}/gz`)
    assert.deepEqual([plain.stdout, plain.exitCode, feed(plain)], ['', 2, [{ kind: 'feature', detail: 'content encoding' }]])
    // Under --compressed curl decodes it too.
    assert.deepEqual(await online().run(`curl --compressed ${HOST}/gz`), result('decoded\n'))
  })

  it('puts a deadline on the request where --max-time asked for one', async (t) => {
    const calls = serving(t, { '/slow': () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) } })
    const r = await online().run(`curl -s -m 2 ${HOST}/slow`)
    assert.deepEqual([r.stderr, r.exitCode], ['', 28])
    assert.equal(calls[0].signal instanceof AbortSignal, true)
    const misspelt = await online().run(`curl -m soon ${HOST}/slow`)
    assert.equal(misspelt.exitCode, 2)
    assert.equal(misspelt.stderr, `curl: option -m: expected a proper numerical parameter\n${TRY}`)
    assert.equal((await online().run(`curl --max-time -1 ${HOST}/slow`)).stderr, `curl: option --max-time: expected a positive numerical parameter\n${TRY}`)
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

  it('exits with what came of the last transfer', async (t) => {
    serving(t, { '/one': text('1\n'), '/gone': text('no\n', 404) })
    const r = await online().run(`curl -sf ${HOST}/gone ${HOST}/one`)
    assert.deepEqual([r.stdout, r.exitCode], ['1\n', 0])
    assert.equal((await online().run(`curl -sf ${HOST}/one ${HOST}/gone`)).exitCode, 22)
  })

  it('refuses a URL it cannot read and a protocol it does not speak', async (t) => {
    serving(t, { '/x': text('ok\n') })
    const term = online()
    const malformed = await term.run('curl "http://api.test/a b"')
    assert.equal(malformed.exitCode, 3)
    assert.equal(malformed.stderr, 'curl: (3) URL rejected: Malformed input to a URL function\n')
    // One to three slashes after the scheme are curl's; four are not.
    assert.deepEqual(await term.run('curl http:/api.test/x; curl http:////api.test/x'),
      result('ok\n', { stderr: 'curl: (3) URL rejected: Unsupported number of slashes following scheme\n', exitCode: 3 }))
    for (const url of ['file:///etc/passwd', 'ftp://api.test/x', 'ftp.api.test/x']) {
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

  it('accepts the two that ask for what it can do', async (t) => {
    const calls = serving(t, { '/x': text('ok\n') })
    assert.deepEqual(await online().run(`curl --compressed --no-progress-meter ${HOST}/x`), result('ok\n'))
    assert.equal(calls.length, 1)
  })

  it('refuses a URL the runtime would send other than as curl sends it', async (t) => {
    const calls = serving(t, { '/x': text('ok\n') })
    const term = online()
    for (const [url, detail] of [
      [`'${HOST}/x[1-3]'`, 'URL globbing'], [`'${HOST}/{x,y}'`, 'URL globbing'],
      [`'${HOST}/a/%2e%2e/x'`, 'URL rewriting'], [`'${HOST}/x?q="a"'`, 'URL rewriting'], [`'${HOST}/é'`, 'URL rewriting'],
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one URL after the last.
      const r = await term.run(`curl ${url}`)
      assert.deepEqual([r.exitCode, feed(r)], [2, [{ kind: 'feature', detail }]], url)
    }
    assert.equal(calls.length, 0)
    // What both read alike goes: dot segments, a fragment, and with -g brackets.
    for (const url of [`'${HOST}/a/../x'`, `'${HOST}/x#top'`, `-g '${HOST}/x?[1]'`]) {
      // oxlint-disable-next-line no-await-in-loop -- one URL after the last.
      assert.deepEqual(await term.run(`curl ${url}`), result('ok\n'), url)
    }
  })

  it('sends the credentials a URL carries as curl does, as basic authentication', async (t) => {
    const calls = serving(t, { '/x': text('ok\n') })
    assert.deepEqual(await online().run('curl http://ada:se%20cret@api.test/x'), result('ok\n'))
    assert.deepEqual([calls[0].url, calls[0].headers.authorization], ['http://api.test/x', 'Basic YWRhOnNlIGNyZXQ='])
  })

  it('refuses a method the runtime would send otherwise', async (t) => {
    const calls = serving(t, { '/x': text('ok\n') })
    for (const line of ['-X post', '-X GET -d a', '-X HEAD', "-X 'BAD METHOD'", '-X TRACE']) {
      // oxlint-disable-next-line no-await-in-loop -- one line after the last.
      const r = await online().run(`curl ${line} ${HOST}/x`)
      assert.deepEqual([r.exitCode, feed(r)], [2, [{ kind: 'option', detail: '-X' }]], line)
    }
    assert.equal(calls.length, 0)
  })
})
