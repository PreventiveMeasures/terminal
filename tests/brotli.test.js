import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// brotli, where the runtime's streams know the format — Node has it, and a
// runtime that does not says so rather than guessing. Every diagnostic below
// was recorded from brotli 1.1.0 over the same bytes written to disk, which
// is also where the two habits that are not gzip's come from: brotli keeps
// the file it read unless told otherwise, and stops at the first operand it
// could not do.
//
// The members are the real tool's own, of `alpha\nbeta\n` and of six bytes
// that spell no text, with one cut short.
const GOOD = Uint8Array.of(0x0f, 0x05, 0x80, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x0a, 0x62, 0x65, 0x74, 0x61, 0x0a, 0x03)
const BINARY = Uint8Array.of(0x8f, 0x02, 0x80, 0x89, 0x50, 0x4e, 0x47, 0xff, 0x0a, 0x03)
const TRUNCATED = GOOD.slice(0, GOOD.length - 3)
const SOURCES = {
  'data.br': GOOD,
  'named.dat': GOOD,
  'img.br': BINARY,
  'trunc.br': TRUNCATED,
  'plain.txt': 'not compressed\n',
  'dir/inner.txt': 'inner\n',
}

const terminal = (sources = SOURCES) => createTerminal(sources, { mount: '/repo', writable: '/tmp/' })
const result = (stdout = '', { stderr = '', exitCode = 0, notes = [], unsupported = [] } = {}) =>
  ({ stdout, stderr, exitCode, cwd: '/repo', notes, unsupported })

// A gap reports on every channel: the command fails, says why, and the run
// carries the diagnostic where a redirect cannot hide it.
async function gap(t, command, detail, stderr) {
  const r = await t.run(command)
  assert.deepEqual(r.unsupported.map((u) => u.detail), [detail], command)
  assert.equal(r.stderr, stderr, command)
  assert.notEqual(r.exitCode, 0, command)
  return r
}

describe('brotli reads what the real tool wrote', () => {
  it('writes a member to stdout', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('brotli -dc data.br'), result('alpha\nbeta\n'))
    assert.deepEqual(await t.run('brotli --decompress --stdout data.br'), result('alpha\nbeta\n'))
    assert.equal((await t.run('brotli -dc data.br | wc -l')).stdout, '2\n')
    // With `-c` there is no name to derive, so a name that says nothing about
    // what the bytes are is read as the member it is.
    assert.deepEqual(await t.run('brotli -dc named.dat'), result('alpha\nbeta\n'))
  })

  it('answers under the bin names it is reached by', async () => {
    const t = terminal()
    for (const name of ['/usr/bin/brotli', '/bin/brotli', '/usr/local/bin/brotli']) {
      assert.deepEqual(await t.run(`${name} -dc data.br`), result('alpha\nbeta\n'), name)
    }
    // It is not one of the commands this terminal offers, so it is not in the
    // list of them either.
    const missing = await t.run('nosuchcommand')
    assert.match(missing.stderr, /command not found\. Available: /u)
    assert.doesNotMatch(missing.stderr, /brotli/u)
    assert.deepEqual(t.complete('brot'), [])
  })

  it('says what brotli says, without a command in front of it', async () => {
    const t = terminal()
    // A stream that stops short is the one thing brotli says of any input it
    // could not read to the end, and it writes nothing of what came before.
    assert.deepEqual(await t.run('brotli -dc trunc.br'), result('', { stderr: 'corrupt input [trunc.br]\n', exitCode: 1 }))
    assert.deepEqual(await t.run('brotli -dc plain.txt'), result('', { stderr: 'corrupt input [plain.txt]\n', exitCode: 1 }))
    assert.deepEqual(await t.run('brotli -d missing.br'), result('', { stderr: 'failed to open input file [missing.br]: No such file or directory\n', exitCode: 1 }))
    assert.deepEqual(await t.run('brotli dir'), result('', { stderr: 'failed to read input [dir]: Is a directory\n', exitCode: 1 }))
    // A pipe carries text, which is not a member — and brotli names what it
    // read from one after the console it was first written for.
    assert.deepEqual(await t.run('echo x | brotli -d'), result('', { stderr: 'corrupt input [con]\n', exitCode: 1 }))
  })

  it('takes a name it can shorten, and refuses one it cannot', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('brotli -d plain.txt'), result('', { stderr: 'input file [plain.txt] suffix mismatch\n', exitCode: 1 }))
    // A name with no room for the suffix leaves nothing to call the file.
    assert.deepEqual(await t.run('brotli -d .br'), result('', { stderr: 'empty output file name for [.br] input file\n', exitCode: 1 }))
    // With `-c` there is no name to derive, so neither rule applies.
    assert.deepEqual(await t.run('brotli -dc trunc.br'), result('', { stderr: 'corrupt input [trunc.br]\n', exitCode: 1 }))
  })

  it('stops at the first operand it could not do, where gzip takes them all', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('cp data.br /tmp/one.br; cp data.br /tmp/two.br; cd /tmp; brotli -d missing.br one.br; ls'),
      { ...result('one.br\ntwo.br\n'), stderr: 'failed to open input file [missing.br]: No such file or directory\n', exitCode: 0, cwd: '/tmp' })
    assert.deepEqual(await t.run('brotli -d one.br two.br; ls'),
      { ...result('one\none.br\ntwo\ntwo.br\n'), cwd: '/tmp' })
  })

  it('writes to stdout for one file and says so for more', async () => {
    // brotli prints its usage over more than one file rather than picking.
    const t = terminal()
    assert.deepEqual(await t.run('brotli -dc data.br named.dat'), result('Usage: brotli [OPTION]... [FILE]...\n', { exitCode: 1 }))
  })
})

describe('brotli compresses with the stream the runtime has', () => {
  it('writes the member beside the file it came from, and keeps that file', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('cp plain.txt /tmp/p && brotli /tmp/p && ls /tmp'), result('p\np.br\n'))
    // What it wrote is what it reads back, and the file it read is still there.
    assert.deepEqual(await t.run('brotli -dc /tmp/p.br'), result('not compressed\n'))
    // `--rm` is what takes it, and `-k` is the default it already was.
    assert.deepEqual(await t.run('cp plain.txt /tmp/k && brotli -k /tmp/k && ls /tmp'), result('k\nk.br\np\np.br\n'))
    assert.deepEqual(await t.run('cp plain.txt /tmp/r && brotli --rm /tmp/r && ls /tmp'), result('k\nk.br\np\np.br\nr.br\n'))
  })

  it('refuses a name already taken, unless forced', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('cp plain.txt /tmp/p && brotli /tmp/p && brotli /tmp/p'),
      result('', { stderr: 'failed to open output file [/tmp/p.br]: File exists\n', exitCode: 1 }))
    assert.deepEqual(await t.run('brotli -f /tmp/p && ls /tmp'), result('p\np.br\n'))
  })

  it('carries bytes that spell no text through the round trip', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('cp img.br /tmp/i.br && brotli --rm -d /tmp/i.br && brotli --rm /tmp/i && brotli --rm -d /tmp/i.br && base64 /tmp/i'), result('iVBOR/8K\n'))
  })

  it('cannot hand back a member whose bytes spell no text', async () => {
    const t = terminal()
    const message = 'brotli: byte output that is not valid UTF-8 cannot be represented by this string-based terminal\n'
    await gap(t, 'brotli -c plain.txt', 'partial UTF-8 byte sequence', message)
    await gap(t, 'echo hi | brotli', 'partial UTF-8 byte sequence', message)
    // The bytes of a member of nothing at all do spell text, and that is what
    // a terminal carrying its output as a string can hand back.
    assert.deepEqual(await t.run('printf "" | brotli'), result(';'))
  })

  it('refuses what it does not do at all', async () => {
    const t = terminal()
    await gap(t, 'brotli plain.txt', 'read-only target', 'brotli: plain.txt.br: file system is read-only\n')
    // A stream compresses as hard as it compresses and is told nothing about
    // it, so a level is refused rather than accepted and ignored.
    await gap(t, 'brotli -9 plain.txt', '-9', 'brotli: -9: choosing a compression level is not supported\n')
    await gap(t, 'brotli -q 5 plain.txt', '-q', 'brotli: -q: choosing a compression level is not supported\n')
    await gap(t, 'brotli -Z plain.txt', '-Z', 'brotli: -Z: choosing a compression level is not supported\n')
    await gap(t, 'brotli --best plain.txt', '--best', 'brotli: --best: choosing a compression level is not supported\n')
    await gap(t, 'brotli -t data.br', '-t', 'brotli: unknown option: -t\n')
  })
})

describe('brotli where the runtime has no brotli', () => {
  // The streams are the runtime's, and which formats they know is the
  // runtime's business: gzip is everywhere they are, brotli only where it was
  // added. A terminal on a runtime without it says so rather than guessing at
  // the bytes — and gzip, whose format is still there, is untouched.
  const withoutBrotli = async (fn) => {
    const streams = [['CompressionStream', globalThis.CompressionStream], ['DecompressionStream', globalThis.DecompressionStream]]
    for (const [name, Real] of streams) {
      globalThis[name] = class extends Real {
        constructor(format) {
          if (format === 'brotli') throw new TypeError(`Unsupported compression format: '${format}'`)
          super(format)
        }
      }
    }
    try { return await fn() } finally { for (const [name, Real] of streams) globalThis[name] = Real }
  }

  it('reports the gap rather than an answer it does not have', async () => {
    await withoutBrotli(async () => {
      const t = terminal()
      await gap(t, 'brotli -dc data.br', 'decompression', 'brotli: this runtime cannot decompress: DecompressionStream does not do brotli\n')
      await gap(t, 'cp plain.txt /tmp/p && brotli /tmp/p', 'compression', 'brotli: this runtime cannot compress: CompressionStream does not do brotli\n')
      // What it could answer without the stream, it still answers.
      assert.deepEqual(await t.run('brotli -d missing.br'), result('', { stderr: 'failed to open input file [missing.br]: No such file or directory\n', exitCode: 1 }))
      // gzip is a format every one of these streams knows, and is unaffected.
      assert.deepEqual(await t.run('cp plain.txt /tmp/g && gzip /tmp/g && gzip -dc /tmp/g.gz'), result('not compressed\n'))
    })
    // Put back, the same line answers.
    assert.deepEqual(await terminal().run('brotli -dc data.br'), result('alpha\nbeta\n'))
  })
})
