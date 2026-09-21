import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// A pipe carries what the stage before it wrote, which is text until a stage
// writes bytes into it — a file of bytes read by `cat`, a member a stream
// inflated — and bytes from then on. The stage after it reads them as the
// bytes they are where it works in bytes, as the text they spell where they
// spell one, and refuses where they spell none, naming the input as it names
// a file it cannot read.
//
// `gzip -n -c` wrote the member, over `alpha\nbeta\n` and over six bytes that
// spell no text.
const TEXT_MEMBER = Uint8Array.of(0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x4b, 0xcc, 0x29, 0xc8, 0x48, 0xe4, 0x4a, 0x4a, 0x2d, 0x49, 0xe4, 0x02, 0x00, 0x6e, 0x50, 0x30, 0x6e, 0x0b, 0x00, 0x00, 0x00)
const BYTE_MEMBER = Uint8Array.of(0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xeb, 0x0c, 0xf0, 0x73, 0xff, 0xcf, 0x05, 0x00, 0x5f, 0x8b, 0x81, 0xcd, 0x06, 0x00, 0x00, 0x00)
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0xff, 0x0a)
const SOURCES = { 'img.png': PNG, 'text.gz': TEXT_MEMBER, 'img.gz': BYTE_MEMBER, 'a.txt': 'alpha\n' }

const terminal = () => createTerminal(SOURCES, { mount: '/repo', writable: '/tmp/' })
const result = (stdout = '', { stderr = '', exitCode = 0, notes = [], unsupported = [] } = {}) =>
  ({ stdout, stderr, exitCode, cwd: '/repo', notes, unsupported })
const NOT_TEXT = (cmd) => `${cmd}: byte output that is not valid UTF-8 cannot be represented by this string-based terminal\n`
const unreadable = (cmd) => `${cmd}: standard input holds bytes that spell no text, and reading them as text is not supported\n`

describe('a pipe carries the bytes a stage wrote', () => {
  it('reads a member out of a file and through a pipe, which is what was asked for', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('cat text.gz | gzip -d'), result('alpha\nbeta\n'))
    assert.deepEqual(await t.run('cat img.gz | gzip -d | hexdump -C'), result('00000000  89 50 4e 47 ff 0a                                 |.PNG..|\n00000006\n'))
    assert.deepEqual(await t.run('cat img.gz | gzip -d | base64'), result('iVBOR/8K\n'))
    assert.equal((await t.run('cat text.gz | gzip -d | wc -l')).stdout, '2\n')
  })

  it('hands a file of bytes to whatever reads bytes', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('cat img.png | base64'), result('iVBOR/8K\n'))
    assert.deepEqual(await t.run('cat img.png | wc -c'), result('6\n'))
    assert.deepEqual(await t.run('cat img.png | xxd'), result('00000000: 8950 4e47 ff0a                           .PNG..\n'))
    assert.equal((await t.run('cat img.png | sha256sum')).stdout, '679ae6a4120cc43d94e6462f34fa9fef218ba7de581f7e509e5bc5f924338b34  -\n')
    // `-` names the same stdin, and reads the same bytes.
    assert.deepEqual(await t.run('cat img.png | wc -c -'), result('6 -\n'))
  })

  it('keeps what a stage wrote in the order it wrote it', async () => {
    const t = terminal()
    // One `cat` reading a file of text and a file of bytes writes both.
    assert.deepEqual(await t.run('cat a.txt img.png | base64'), result('YWxwaGEKiVBOR/8K\n'))
    assert.deepEqual(await t.run('cat img.png a.txt | wc -c'), result('12\n'))
    assert.deepEqual(await t.run('printf x | cat img.png - | base64'), result('iVBOR/8KeA==\n'))
  })

  it('is the text the bytes spell, where they spell one', async () => {
    const t = terminal()
    // The member inflates to text, so what reads text reads it.
    assert.deepEqual(await t.run('gzip -dc text.gz | tr a-z A-Z'), result('ALPHA\nBETA\n'))
    assert.deepEqual(await t.run('gzip -dc text.gz | grep beta'), result('beta\n'))
    assert.deepEqual(await t.run('gzip -dc text.gz | sed -n 2p'), result('beta\n'))
  })

  it('names the input where a reader of text is handed bytes that spell none', async () => {
    const t = terminal()
    for (const [command, cmd] of [['tr a b', 'tr'], ['sed -n p', 'sed'], ['sort', 'sort'], ['head -c2', 'head'], ['xargs echo', 'xargs'], ['awk "{print}"', 'awk']]) {
      const r = await t.run(`cat img.png | ${command}`)
      assert.deepEqual(r.unsupported.map((u) => u.detail), ['binary file'], command)
      assert.equal(r.stderr, unreadable(cmd), command)
      assert.equal(r.stdout, '', command)
    }
  })

  it('refuses only where a string is what is left', async () => {
    const t = terminal()
    // The terminal's own output is a string, so the command writing bytes
    // there is the one that reports it — in a pipe, that is the last stage.
    const printed = await t.run('cat img.png')
    assert.deepEqual(printed.unsupported.map((u) => u.detail), ['partial UTF-8 byte sequence'])
    assert.equal(printed.stderr, NOT_TEXT('cat'))
    assert.equal((await t.run('cat img.gz | gzip -d')).stderr, NOT_TEXT('gzip'))
    // A file takes them, so a redirect is not that.
    assert.deepEqual(await t.run('cat img.png > /tmp/copy && base64 /tmp/copy'), result('iVBOR/8K\n'))
    assert.deepEqual(await t.run('cat img.gz | gzip -d > /tmp/out && wc -c /tmp/out'), result('6 /tmp/out\n'))
  })

  it('leaves a pipe of text exactly as it was', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('cat a.txt | wc -c'), result('6\n'))
    assert.deepEqual(await t.run('echo hi | cat | cat'), result('hi\n'))
    assert.deepEqual(await t.run('cat a.txt | tr a-z A-Z | sed -n 1p'), result('ALPHA\n'))
  })
})
