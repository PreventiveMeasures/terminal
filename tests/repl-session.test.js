import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import process from 'node:process'

// The development REPL is not part of the published package and nothing else
// imports it, so this runs it the way a developer does: a directory to mount
// and lines on stdin. Piped input is a batch of commands — no prompt, no
// banner on stdout — which is what makes the session readable here, and what
// catches a method it calls being taken off the public surface.
const CLI = join(import.meta.dirname, '..', 'bin', 'terminal.js')
const FILES = { 'a.txt': 'alpha\nbeta\n', 'b.txt': 'x\n', 'img.png': Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0xff, 0x0a) }

function session(input, files = FILES, flags = []) {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-repl-'))
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
    const r = spawnSync(process.execPath, [CLI, ...flags, dir], { input, encoding: 'utf8', timeout: 30_000 })
    assert.equal(r.error, undefined)
    // Anything thrown is a bug in the terminal rather than a command's own
    // failure, and the session prints it rather than swallowing it: no
    // session here has one to print.
    assert.doesNotMatch(r.stderr, /INTERNAL/u)
    return { stdout: r.stdout, stderr: r.stderr, status: r.status, dir }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the development REPL runs a session over a real directory', () => {
  it('runs each line and reports the last status', () => {
    const r = session('wc -l a.txt\nls\nexit 3\n')
    assert.equal(r.stdout, '2 a.txt\na.txt\nb.txt\nimg.png\n')
    // A session mounted inside /tmp says it has no overlay, which is the one
    // thing on stderr here besides the status.
    assert.match(r.stderr, /\[exit 3\]\n$/u)
    assert.equal(r.status, 3)
  })

  it('collects a line that stops inside a compound command', () => {
    // Reading the line is what says it is unfinished rather than wrong: the
    // REPL asks for the next line, as a bash prompt does.
    const r = session('for f in 1 2; do\necho $f\ndone\n')
    assert.equal(r.stdout, '1\n2\n')
    assert.equal(r.status, 0)
  })

  it('reports a line that is wrong rather than unfinished', () => {
    const r = session('echo "unterminated\n')
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /unterminated double quote/u)
    assert.equal(r.status, 2)
  })

  it('mounts a file whose bytes spell no text as those bytes', () => {
    const r = session('wc -c img.png\nbase64 img.png\n')
    assert.equal(r.stdout, '6 img.png\niVBOR/8K\n')
    assert.equal(r.status, 0)
  })

  it('reports a failing command on stderr and keeps going', () => {
    const r = session('cd /nope\necho after\n')
    assert.equal(r.stdout, 'after\n')
    assert.match(r.stderr, /cd: \/nope: No such file or directory/u)
    assert.equal(r.status, 0)
  })

  it('prints what it mounted, and what it left out, on request', () => {
    const r = session('.info\n')
    assert.match(r.stderr, /mounted from the host: 3 files/u)
    assert.equal(r.status, 0)
  })
})

// A session that reaches the real network has to be waited for rather than
// run to completion in one call: the server it talks to is in this process,
// and a blocking spawn would never let it answer.
function running(input, flags, dir) {
  const child = spawn(process.execPath, [CLI, ...flags, dir], { stdio: ['pipe', 'pipe', 'pipe'] })
  const out = { stdout: '', stderr: '' }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { out.stdout += chunk })
  child.stderr.on('data', (chunk) => { out.stderr += chunk })
  child.stdin.end(input)
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (status) => resolve({ ...out, status }))
  })
}

describe('the development REPL reaches the network only with --network', () => {
  it('has no curl without the flag, and a curl that really transfers with it', async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(`${request.method} ${request.url} from the host\n`)
    })
    const dir = mkdtempSync(join(tmpdir(), 'terminal-repl-'))
    try {
      writeFileSync(join(dir, 'a.txt'), 'alpha\n')
      await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
      const url = `http://127.0.0.1:${server.address().port}/hello`
      // Without the flag the name is not a command, and that is all it says:
      // how the session was started is not the session's to report.
      const off = await running(`curl ${url}\n`, [], dir)
      assert.equal(off.stdout, '')
      assert.match(off.stderr, /curl: command not found\. Available: /u)
      assert.doesNotMatch(off.stderr, /network|--network/u)
      // With it, the request leaves this process and the answer comes back
      // through the same terminal every other command writes to.
      const on = await running(`curl -sS ${url} | tr a-z A-Z\n`, ['--network'], dir)
      assert.doesNotMatch(on.stderr, /INTERNAL|UNSUPPORTED/u)
      assert.equal(on.stdout, 'GET /HELLO FROM THE HOST\n')
      assert.equal(on.status, 0)
      // The session says what it is over, and this is the one line of that
      // which is about something outside it.
      const info = await running('.info\n', ['--network'], dir)
      assert.match(info.stderr, /curl reaches the real network: requests leave this host/u)
      assert.doesNotMatch((await running('.info\n', [], dir)).stderr, /reaches the real network/u)
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names the flag in its usage', () => {
    const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', timeout: 30_000 })
    assert.match(r.stdout, /^Usage: bin\/terminal\.js \[--network\] <path-to-dir>/u)
    assert.match(r.stdout, /--network {4}let `curl` make real requests/u)
    assert.equal(r.status, 0)
  })
})
