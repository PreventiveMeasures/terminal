import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// `gzip -d` is the one command here whose work a line cannot do for itself:
// inflating bytes is `DecompressionStream`'s, which answers asynchronously.
// So it is done before the line runs, by `runAsync`, and `run` has nothing to
// read — which is the gap it reports rather than an answer it does not have.
// Every diagnostic below was recorded from GNU gzip 1.12 over the same bytes
// written to disk.
// The members are gzip's own, of `alpha\nbeta\n` and of six bytes that spell
// no text, with one cut short and one whose check will not add up.
const GOOD = Uint8Array.of(0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x03, 0x4b, 0xcc, 0x29, 0xc8, 0x48, 0xe4, 0x4a, 0x4a, 0x2d, 0x49, 0xe4, 0x02, 0x00, 0x6e, 0x50, 0x30, 0x6e, 0x0b, 0x00, 0x00, 0x00)
const BINARY = Uint8Array.of(0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x03, 0xeb, 0x0c, 0xf0, 0x73, 0xff, 0xcf, 0x05, 0x00, 0x5f, 0x8b, 0x81, 0xcd, 0x06, 0x00, 0x00, 0x00)
const TRUNCATED = GOOD.slice(0, GOOD.length - 5)
const CORRUPT = Uint8Array.from(GOOD, (byte, at) => (at === GOOD.length - 5 ? byte ^ 0xff : byte))
const SOURCES = {
  'data.gz': GOOD,
  'named.dat': GOOD,
  'img.gz': BINARY,
  'arch.tgz': GOOD,
  'trunc.gz': TRUNCATED,
  'crc.gz': CORRUPT,
  'empty.gz': new Uint8Array(),
  'plain.txt': 'not compressed\n',
  'dir/inner.txt': 'inner\n',
}

const terminal = (sources = SOURCES) => createTerminal(sources, { mount: '/repo', writable: '/tmp/' })
const result = (stdout = '', { stderr = '', exitCode = 0, notes = [], unsupported = [] } = {}) =>
  ({ stdout, stderr, exitCode, cwd: '/repo', notes, unsupported })

// A gap reports on every channel: the command fails, says why, and the run
// carries the diagnostic where a redirect cannot hide it.
async function gap(t, command, detail, stderr) {
  const r = await t.runAsync(command)
  assert.deepEqual(r.unsupported.map((u) => u.detail), [detail], command)
  assert.equal(r.stderr, stderr, command)
  assert.notEqual(r.exitCode, 0, command)
  return r
}

describe('gzip decompresses what a runtime inflated for it', () => {
  it('writes a member to stdout', async () => {
    const t = terminal()
    assert.deepEqual(await t.runAsync('gzip -dc data.gz'), result('alpha\nbeta\n'))
    assert.deepEqual(await t.runAsync('gzip -d -c data.gz'), result('alpha\nbeta\n'))
    assert.deepEqual(await t.runAsync('gzip --decompress --stdout data.gz'), result('alpha\nbeta\n'))
    // The name says nothing about what the bytes are: `-c` reads the member.
    assert.deepEqual(await t.runAsync('gzip -dc named.dat'), result('alpha\nbeta\n'))
    assert.equal((await t.runAsync('gzip -dc data.gz | wc -l')).stdout, '2\n')
  })

  it('answers under the bin names it is reached by', async () => {
    const t = terminal()
    const bins = ['/usr/bin/gzip', '/bin/gzip', '/usr/local/bin/gzip']
    const answers = await Promise.all(bins.map((name) => t.runAsync(`${name} -dc data.gz`)))
    for (const answer of answers) assert.deepEqual(answer, result('alpha\nbeta\n'))
    // It is not one of the commands this terminal offers, so it is not in the
    // list of them either.
    const missing = await t.runAsync('nosuchcommand')
    assert.match(missing.stderr, /command not found\. Available: /u)
    assert.doesNotMatch(missing.stderr, /gzip/u)
    assert.deepEqual(t.complete('gzi'), [])
  })

  it('has nothing to read where nothing waited for the work', async () => {
    const t = terminal()
    const sync = t.run('gzip -dc data.gz')
    assert.deepEqual(sync.unsupported.map((u) => u.detail), ['synchronous decompression'])
    assert.equal(sync.stderr, 'gzip: decompressing a file is only supported by runAsync\n')
    assert.equal(sync.exitCode, 1)
    // The same line through the call that can wait answers it.
    assert.deepEqual(await t.runAsync('gzip -dc data.gz'), result('alpha\nbeta\n'))
  })

  it('says what GNU says of what is not a member', async () => {
    const t = terminal()
    // Data errors carry a newline ahead of them, as gzip writes them.
    assert.deepEqual(await t.runAsync('gzip -dc plain.txt'), result('', { stderr: '\ngzip: plain.txt: not in gzip format\n', exitCode: 1 }))
    assert.deepEqual(await t.runAsync('gzip -dc empty.gz'), result('', { stderr: '\ngzip: empty.gz: unexpected end of file\n', exitCode: 1 }))
    // What it inflated before the end it ran into is still written.
    assert.deepEqual(await t.runAsync('gzip -dc trunc.gz'), result('alpha\nbeta\n', { stderr: '\ngzip: trunc.gz: unexpected end of file\n', exitCode: 1 }))
    assert.deepEqual(await t.runAsync('gzip -dc crc.gz'), result('', { stderr: '\ngzip: crc.gz: invalid compressed data--crc error\n', exitCode: 1 }))
    // A file it could not open, and one it passed over, are reported as they
    // stand — and a warning is a status of its own.
    assert.deepEqual(await t.runAsync('gzip -dc missing.gz'), result('', { stderr: 'gzip: missing.gz: No such file or directory\n', exitCode: 1 }))
    assert.deepEqual(await t.runAsync('gzip -dc dir'), result('', { stderr: 'gzip: dir is a directory -- ignored\n', exitCode: 2 }))
  })

  it('reads a pipe the way GNU reads one carrying anything else', async () => {
    // Stdin is text here, and no text spells a member: the second byte of the
    // header begins no character at all.
    const t = terminal()
    assert.deepEqual(await t.runAsync('echo x | gzip -d'), result('', { stderr: '\ngzip: stdin: not in gzip format\n', exitCode: 1 }))
    assert.deepEqual(await t.runAsync('printf "" | gzip -dc'), result('', { stderr: '\ngzip: stdin: unexpected end of file\n', exitCode: 1 }))
  })

  it('takes every operand it was given, and the worst of what they answer', async () => {
    const t = terminal()
    assert.deepEqual(await t.runAsync('gzip -dc data.gz plain.txt'), result('alpha\nbeta\n', { stderr: '\ngzip: plain.txt: not in gzip format\n', exitCode: 1 }))
    // A directory alone is a warning; an error beside it is what is reported.
    assert.deepEqual(await t.runAsync('gzip -dc dir plain.txt'), result('', { stderr: 'gzip: dir is a directory -- ignored\n\ngzip: plain.txt: not in gzip format\n', exitCode: 1 }))
  })

  it('writes the file beside the one it came from, where that can be written', async () => {
    const t = terminal()
    assert.deepEqual(await t.runAsync('cp data.gz /tmp/x.gz && gzip -d /tmp/x.gz && cat /tmp/x'), result('alpha\nbeta\n'))
    // The copy is gone with it, unless `-k` keeps it.
    assert.deepEqual(await t.runAsync('ls /tmp'), result('x\n'))
    assert.deepEqual(await t.runAsync('cp data.gz /tmp/k.gz && gzip -dk /tmp/k.gz && ls /tmp'), result('k\nk.gz\nx\n'))
    // `.tgz` is the one suffix that leaves a name behind rather than taking
    // one off, and a name with no suffix to take off is left alone.
    assert.deepEqual(await t.runAsync('cp arch.tgz /tmp/a.tgz && gzip -d /tmp/a.tgz && cat /tmp/a.tar'), result('alpha\nbeta\n'))
    assert.deepEqual(await t.runAsync('cp named.dat /tmp/n.dat && gzip -d /tmp/n.dat'), result('', { stderr: 'gzip: /tmp/n.dat: unknown suffix -- ignored\n', exitCode: 2 }))
    assert.deepEqual(await t.runAsync('cp data.gz /tmp/x.gz && gzip -d /tmp/x.gz'), result('', { stderr: 'gzip: /tmp/x already exists;\tnot overwritten\n', exitCode: 2 }))
  })

  it('refuses to write where nothing can be written', async () => {
    await gap(terminal(), 'gzip -d data.gz', 'read-only target', 'gzip: data: file system is read-only\n')
  })

  it('carries bytes that spell no text into a file, and refuses to print them', async () => {
    const t = terminal()
    // Written to a file, a member of bytes is those bytes.
    assert.deepEqual(await t.runAsync('cp img.gz /tmp/i.gz && gzip -d /tmp/i.gz && wc -c /tmp/i'), result('6 /tmp/i\n'))
    assert.deepEqual(await t.runAsync('base64 /tmp/i'), result('iVBOR/8K\n'))
    // Printed, they are the output this terminal cannot carry.
    await gap(t, 'gzip -dc img.gz', 'partial UTF-8 byte sequence',
      'gzip: byte output that is not valid UTF-8 cannot be represented by this string-based terminal\n')
  })

  it('refuses what it does not do at all', async () => {
    const t = terminal()
    await gap(t, 'gzip plain.txt', 'compression', 'gzip: compressing is not supported\n')
    await gap(t, 'gzip -dl data.gz', '-l', 'gzip: unknown option: -l\n')
    await gap(t, 'gzip -dv data.gz', '-v', 'gzip: unknown option: -v\n')
  })
})
