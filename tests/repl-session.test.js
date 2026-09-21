import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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

function session(input, files = FILES) {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-repl-'))
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
    const r = spawnSync(process.execPath, [CLI, dir], { input, encoding: 'utf8', timeout: 30_000 })
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
