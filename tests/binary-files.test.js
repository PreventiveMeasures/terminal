import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { createFs } from '../src/fs.js'
import { encodeUtf8 } from '../src/util.js'
import { toBase64 } from '@exodus/bytes/base64.js'

// A file need not be text: a source value that is a `Uint8Array` is the bytes
// themselves, for the files no JS string can spell — an image, a compiled
// object, an archive. The bytes are the file, and text is a reading of them
// that may have no answer: what is measured, copied, encoded or compared is
// answered from the bytes, and what would be read as text says which file it
// could not read rather than mangling it.
// Checked against GNU coreutils 9.4, GNU diff 3.10, GNU grep 3.11 and
// ripgrep 14.1 over the same bytes written to disk.
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0xfe, 0x0a)
// Latin-1 text: invalid UTF-8 holding no NUL, which `diff` and `rg` read as
// text and `grep` calls binary.
const LATIN = Uint8Array.of(0x63, 0x61, 0x66, 0xe9, 0x20, 0x6c, 0x61, 0x74, 0x74, 0x65, 0x0a, 0x6d, 0x6f, 0x72, 0x65, 0x0a)
const SOURCES = {
  'img.png': PNG,
  'latin.bin': LATIN,
  'bytes.txt': encodeUtf8('spelled by bytes\n'),
  'text.txt': 'spelled by a string\n',
  empty: new Uint8Array(),
}

// A tree with a file of bytes in it, a link to one, and an empty one, for
// what a walk reports of each.
const TREE = {
  'img.png': PNG,
  'text.txt': 'text here\n',
  'link.png': { type: 'link', target: 'img.png' },
  'dir/inner.png': Uint8Array.of(0, 1, 2),
  empty: new Uint8Array(),
}

const terminal = (sources = SOURCES, options = {}) => createTerminal(sources, { mount: '/repo', ...options })

async function check(t, command, stdout = '', { stderr = '', exitCode = 0, notes = [], cwd = '/repo' } = {}) {
  assert.deepEqual(await t.run(command), { stdout, stderr, exitCode, cwd, notes, unsupported: [] }, command)
}

// A gap reports on every channel: the command fails, says which file it could
// not read, and the run carries the diagnostic where a redirect cannot hide it.
async function gap(t, command, detail, stderr) {
  const result = await t.run(command)
  assert.deepEqual(result.unsupported.map((u) => u.detail), [detail], command)
  assert.equal(result.stderr, stderr, command)
  assert.notEqual(result.exitCode, 0, command)
  return result
}

const unreadable = (name) => `${JSON.stringify('/repo/' + name)} holds bytes that spell no text, and reading them as text is not supported\n`

describe('a source entry can be the bytes of a file', () => {
  it('holds the bytes as given, copied away from the caller', async () => {
    const live = Uint8Array.of(1, 2, 3)
    const t = terminal({ f: live })
    live[0] = 9
    await check(t, 'wc -c f', '3 f\n')
    await check(t, 'base64 f', 'AQID\n')
  })

  it('takes any one-byte view, and refuses what is not one', async () => {
    // Every one-byte view is the bytes it holds, `Buffer` — a `Uint8Array`
    // of its own — among them, and a view into a larger buffer is the part
    // of it the view is over.
    for (const view of [new Int8Array([-1, 10]), new Uint8ClampedArray([255, 10]), Uint8Array.of(0, 0xff, 0x0a, 0).subarray(1, 3)]) {
      await check(terminal({ f: view }), 'wc -c f', '2 f\n')
    }
    assert.throws(() => terminal({ f: new Uint16Array([1, 2]) }), /source "f" is a Uint16Array; declare a file's bytes as a Uint8Array/u)
    assert.throws(() => terminal({ f: new DataView(new ArrayBuffer(4)) }), /source "f" is a DataView; declare a file's bytes as a Uint8Array/u)
    assert.throws(() => terminal({ f: new ArrayBuffer(4) }), /source "f" is an ArrayBuffer; declare a file's bytes as a Uint8Array over it/u)
  })

  it('is a file like any other to the filesystem itself', () => {
    const fs = createFs({ 'a/img.png': PNG, 'a/text.txt': 'x\n' }, '/repo')
    assert.deepEqual(fs.listDir('/repo/a'), { dirs: [], files: ['img.png', 'text.txt'], links: [] })
    assert.equal(fs.isFile('/repo/a/img.png'), true)
    assert.equal(fs.fileSize('/repo/a/img.png'), PNG.length)
    assert.deepEqual(fs.readBytes('/repo/a/img.png'), PNG)
    assert.equal(fs.isBytes('/repo/a/img.png'), true)
    assert.equal(fs.isBytes('/repo/a/text.txt'), false)
    // Bytes the sources declare are the file's own, and a reader that works
    // in them gets them without going through text at all.
    assert.deepEqual(fs.readBytes('/repo/a/text.txt'), Uint8Array.of(0x78, 0x0a))
  })

  it('reads as the text its bytes spell, where they spell one', async () => {
    const t = terminal()
    await check(t, 'cat bytes.txt', 'spelled by bytes\n')
    await check(t, 'grep -c spelled bytes.txt text.txt', 'bytes.txt:1\ntext.txt:1\n')
    await check(t, 'sed s/bytes/BYTES/ bytes.txt', 'spelled by BYTES\n')
    await check(t, 'wc bytes.txt', ' 1  3 17 bytes.txt\n')
    await check(t, 'diff bytes.txt bytes.txt')
  })

  it('is read by every filter as the text it spells', async () => {
    const t = terminal({ 'lines.bin': encodeUtf8('beta\nalpha\nbeta\n') })
    await check(t, 'head -c4 lines.bin', 'beta', { notes: ['head: selected 4 of 16 bytes from "/repo/lines.bin".'] })
    await check(t, 'sort lines.bin', 'alpha\nbeta\nbeta\n')
    await check(t, 'sort -u lines.bin', 'alpha\nbeta\n')
    await check(t, 'uniq lines.bin', 'beta\nalpha\nbeta\n')
    await check(t, 'cut -c1-3 lines.bin', 'bet\nalp\nbet\n')
    await check(t, 'tr a-z A-Z < lines.bin', 'BETA\nALPHA\nBETA\n')
    await check(t, 'sed s/beta/BETA/ lines.bin', 'BETA\nalpha\nBETA\n')
    await check(t, 'nl lines.bin', '     1\tbeta\n     2\talpha\n     3\tbeta\n')
    await check(t, 'tac lines.bin', 'beta\nalpha\nbeta\n')
    await check(t, 'awk "{ print NR }" lines.bin', '1\n2\n3\n')
    await check(t, 'wc -m lines.bin', '16 lines.bin\n')
  })

  it('is the same file as the string that spells it', async () => {
    const t = terminal({ 'same.txt': 'twinned\n', 'twin.bin': encodeUtf8('twinned\n') })
    await check(t, 'cat twin.bin', 'twinned\n')
    await check(t, 'diff same.txt twin.bin')
    await check(t, 'diff -s same.txt twin.bin', 'Files same.txt and twin.bin are identical\n')
  })

  it('takes a Map of sources as readily as an object', async () => {
    const t = terminal(new Map([['img.png', PNG], ['a/b.txt', 'x\n']]))
    await check(t, 'wc -c img.png a/b.txt', '19 img.png\n 2 a/b.txt\n21 total\n')
  })
})

// The same file, spelt in base64: what a tree serialized as text carries. It
// is checked for its spelling when the terminal is made and decoded the first
// time it is read, and from then on it is the bytes it spells.
describe('a source entry can be the bytes of a file spelt in base64', () => {
  const encoded = (bytes) => ({ format: 'base64', data: toBase64(bytes) })
  const B64 = { 'img.png': encoded(PNG), 'latin.bin': encoded(LATIN), 'bytes.txt': encoded(encodeUtf8('spelled by bytes\n')), empty: encoded(new Uint8Array()) }

  it('is the file its bytes are, to everything that reads, measures or copies one', async () => {
    const t = terminal(B64, { writable: '/tmp/' })
    await check(t, 'base64 img.png', 'iVBORw0KGgoAAAANSUhEUv/+Cg==\n')
    await check(t, 'wc -c img.png latin.bin bytes.txt empty', '19 img.png\n16 latin.bin\n17 bytes.txt\n 0 empty\n52 total\n')
    await check(t, 'cat bytes.txt', 'spelled by bytes\n')
    await check(t, 'xxd -l 4 img.png', '00000000: 8950 4e47                                .PNG\n')
    await check(t, 'stat -c %s img.png; du -b img.png; find . -empty', '19\n19\timg.png\n./empty\n')
    await check(t, 'cp img.png /tmp/copy.png; diff img.png /tmp/copy.png && echo same', 'same\n')
    // cat hands the bytes on: a pipe and a file take them, and only this
    // terminal's own output, which is a string, cannot.
    await check(t, 'cat img.png | base64', 'iVBORw0KGgoAAAANSUhEUv/+Cg==\n')
    await gap(t, 'cat img.png', 'partial UTF-8 byte sequence', 'cat: byte output that is not valid UTF-8 cannot be represented by this string-based terminal\n')
    await check(t, 'grep -c oak img.png latin.bin', 'img.png:0\nlatin.bin:0\n', { exitCode: 1 })
  })

  it('is the same file as the bytes, and as the string, that spell it', async () => {
    const t = createTerminal({ 'a.png': PNG, 'b.png': encoded(PNG), 'c.txt': 'spelled\n', 'd.txt': encoded(encodeUtf8('spelled\n')) }, { mount: '/repo' })
    await check(t, 'diff a.png b.png && diff c.txt d.txt && echo same', 'same\n')
    await check(t, 'cp b.png b.png', '', { stderr: "cp: 'b.png' and 'b.png' are the same file\n", exitCode: 1 })
    assert.equal(createFs({ b: encoded(PNG) }).sameFileContents('/b', '/b'), true)
  })

  it('is sized by its spelling, padded or not, before it is ever decoded', () => {
    const fs = createFs({ one: { format: 'base64', data: 'AQ==' }, bare: { format: 'base64', data: 'AQI' }, three: { format: 'base64', data: 'AQID' }, none: { format: 'base64', data: '' } })
    assert.deepEqual(['/one', '/bare', '/three', '/none'].map((p) => fs.fileSize(p)), [1, 2, 3, 0])
    assert.deepEqual(['/one', '/none'].map((p) => fs.isEmptyFile(p)), [false, true])
    assert.equal(fs.isBytes('/one'), true)
    assert.deepEqual(Array.from(fs.readBytes('/bare')), [1, 2])
    assert.deepEqual(Array.from(fs.readBytes('/one')), [1])
  })

  it('takes a Map of sources, and reads through a link', async () => {
    const t = createTerminal(new Map([['img.png', encoded(PNG)], ['link.png', { type: 'link', target: 'img.png' }]]), { mount: '/repo' })
    await check(t, 'wc -c link.png; base64 link.png', '19 link.png\niVBORw0KGgoAAAANSUhEUv/+Cg==\n')
  })

  it('reports a spelling that does not decode to the first reader, not when the terminal is made', async () => {
    // Checking a spelling costs more than decoding it, so nothing is checked
    // until a reader needs the bytes; what needs none — the listing, the size
    // from the spelling's length — is answered as ever, and a reader is told
    // which file it is, on stderr and on the feed, as for a binary file.
    for (const data of ['AQ ID', 'AQID\n', 'AQ=D', 'AR==', 'AQI=x', '!!!!', 'AQID====', 'A']) {
      const t = terminal({ f: { format: 'base64', data }, 'ok.txt': 'fine\n' }, { writable: '/tmp/' })
      await check(t, 'ls; cat ok.txt', 'f\nok.txt\nfine\n')
      const message = '"/repo/f" declares base64 that does not decode, so its bytes cannot be read'
      await gap(t, 'cat f', 'base64 source', `cat: ${message}\n`)
      for (const command of ['base64 f', 'wc -c f', 'cp f /tmp/copy', 'diff f ok.txt', 'grep -c x f']) {
        const result = await t.run(command)
        assert.deepEqual(result.unsupported.map((u) => u.detail), ['base64 source'], `${command} for ${JSON.stringify(data)}`)
        assert.match(result.stderr, /declares base64 that does not decode/u, command)
        assert.notEqual(result.exitCode, 0, command)
      }
      await check(t, 'ls /tmp')
    }
    assert.throws(() => terminal({ f: { format: 'hex', data: '01' } }), /source "f" declares format "hex"; the only format is \{ format: 'base64', data \}/u)
    // A comparison never throws: where a hint weighs two paths a missing name
    // could have meant, a spelling that does not decode is a file no other is
    // the same as, and the command's own error is the one reported.
    const weighed = { file: { format: 'base64', data: '!!!!' }, 'home/file': 'x\n', 'sub/keep': '' }
    const note = 'cat: relative path "file" was not found from cwd "/repo/sub". Both of "/repo/file" and "/repo/home/file" exist, and they differ in contents.'
    for (const writable of [undefined, '/tmp/']) {
      const t = createTerminal(weighed, { mount: '/repo', home: '/repo/home', cwd: '/repo/sub', writable })
      await check(t, 'cat file', '', { stderr: 'cat: file: No such file or directory\n', exitCode: 1, cwd: '/repo/sub', notes: [note] })
    }
    // `data` alone is a declaration with its format left off, not a value to
    // pass over: the file would otherwise simply not be there.
    assert.throws(() => terminal({ f: { data: 'AQ==' } }), /source "f" declares format null; the only format is \{ format: 'base64', data \}/u)
    assert.throws(() => terminal({ f: { format: 'base64', data: PNG } }), /source "f" must declare its base64 as a string in `data`/u)
    assert.throws(() => terminal({ f: { format: 'base64' } }), /source "f" must declare its base64 as a string in `data`/u)
  })
})

describe('what a file of bytes answers without being read as text', () => {
  it('measures, sizes and lists it', async () => {
    const t = terminal()
    await check(t, 'wc -c img.png latin.bin', '19 img.png\n16 latin.bin\n35 total\n')
    await check(t, 'wc img.png', ' 3  2 19 img.png\n')
    await check(t, 'stat -c "%s %F" img.png', '19 regular file\n')
    await check(t, 'du -b img.png', '19\timg.png\n')
    await check(t, 'find . -empty', './empty\n')
    await check(t, 'test -e img.png && echo yes', 'yes\n')
    await check(t, 'test -f img.png && echo yes', 'yes\n')
    await check(t, 'ls', 'bytes.txt\nempty\nimg.png\nlatin.bin\ntext.txt\n')
    await check(t, 'stat -c "%s %n" img.png empty', '19 img.png\n0 empty\n')
    await check(t, 'find . -type f -name "*.bin"', './latin.bin\n')
    await check(t, 'wc -c img.png text.txt empty', '19 img.png\n20 text.txt\n 0 empty\n39 total\n')
  })

  it('slices its bytes for a dump and wraps them for base64', async () => {
    const t = terminal()
    await check(t, 'xxd -s 4 -l 4 img.png', '00000004: 0d0a 1a0a                                ....\n')
    await check(t, 'xxd -l 3 img.png', '00000000: 8950 4e                                  .PN\n')
    await check(t, 'hexdump -n 4 -C img.png', '00000000  89 50 4e 47                                       |.PNG|\n00000004\n')
    await check(t, 'hexdump -s 16 -C img.png', '00000010  ff fe 0a                                          |...|\n00000013\n')
    await check(t, 'base64 -w 8 img.png', 'iVBORw0K\nGgoAAAAN\nSUhEUv/+\nCg==\n')
    await check(t, 'base64 empty')
  })

  it('answers a walk of a tree that holds one', async () => {
    const t = terminal({
      'dir/inner.png': Uint8Array.of(0, 1, 2), 'dir/inner.txt': 'inner\n',
      'other/inner.png': Uint8Array.of(0, 1, 3), 'other/inner.txt': 'inner\n',
    })
    await check(t, 'diff -r dir other', 'Binary files dir/inner.png and other/inner.png differ\n', { exitCode: 1 })
    await check(t, 'diff -q -r dir other', 'Files dir/inner.png and other/inner.png differ\n', { exitCode: 1 })
    await check(t, 'du -b .', '9\t./dir\n9\t./other\n18\t.\n')
    await check(t, 'du -bs dir', '9\tdir\n')
  })

  it('counts its lines, words and characters as GNU does', async () => {
    const t = terminal()
    await check(t, 'wc -l img.png', '3 img.png\n')
    await check(t, 'wc -w img.png', '2 img.png\n')
    await check(t, 'wc -w latin.bin', '3 latin.bin\n')
    // A byte that spells no character is a byte and not a character, which is
    // what wc counts of one as well: the PNG holds 19 bytes and 16 characters.
    check(t, 'wc -mc img.png', '16 19 img.png\n')
    await check(t, 'wc -mc latin.bin', '15 16 latin.bin\n')
    // A sequence cut short at the end spells no character either.
    check(terminal({ 'short.bin': Uint8Array.of(0x61, 0x62, 0xe2, 0x81) }), 'wc -mc short.bin', '2 4 short.bin\n')
  })

  it('prints its bytes where the printing is text', async () => {
    const t = terminal()
    await check(t, 'base64 img.png', 'iVBORw0KGgoAAAANSUhEUv/+Cg==\n')
    await check(t, 'hexdump -C latin.bin', '00000000  63 61 66 e9 20 6c 61 74  74 65 0a 6d 6f 72 65 0a  |caf. latte.more.|\n00000010\n')
    await check(t, 'xxd img.png', '00000000: 8950 4e47 0d0a 1a0a 0000 000d 4948 4452  .PNG........IHDR\n00000010: fffe 0a                                  ...\n')
    await check(t, 'hexdump -C empty')
  })

  it('is weighed by du as the bytes it takes up', async () => {
    const t = terminal(TREE)
    // A file's size is its bytes; what it takes up on disk is the blocks
    // holding them, which is what `du` reports without `--apparent-size`.
    check(t, 'du -b img.png', '19\timg.png\n')
    await check(t, 'du img.png', '4\timg.png\n')
    await check(t, 'du -h img.png', '4.0K\timg.png\n')
    await check(t, 'du --apparent-size img.png', '1\timg.png\n')
    await check(t, 'du -bs .', '39\t.\n')
    await check(t, 'du -s .', '20\t.\n')
    await check(t, 'du dir', '8\tdir\n')
    await check(t, 'du --inodes .', '2\t./dir\n7\t.\n')
  })

  it('is read through a link to it, and measured apart from one', async () => {
    const t = terminal(TREE)
    await check(t, 'wc -c link.png', '19 link.png\n')
    await check(t, 'base64 link.png', 'iVBORw0KGgoAAAANSUhEUv/+Cg==\n')
    await check(t, 'stat -c "%s" link.png', '7\n')
    await check(t, 'du -b link.png', '7\tlink.png\n')
    await check(t, 'find . -type l', './link.png\n')
    // The file it leads to is the file that cannot be read as text, and the
    // one the refusal names.
    await gap(t, 'cat link.png', 'partial UTF-8 byte sequence', 'cat: byte output that is not valid UTF-8 cannot be represented by this string-based terminal\n')
  })

  it('is what a link made by ln -s leads to', async () => {
    const t = () => terminal(TREE, { writable: '/tmp/' })
    await check(t(), 'ln -s /repo/img.png /tmp/l && wc -c /tmp/l', '19 /tmp/l\n')
    await check(t(), 'ln -s /repo/img.png /tmp/l && base64 /tmp/l', 'iVBORw0KGgoAAAANSUhEUv/+Cg==\n')
    await check(t(), 'ln -s /repo/img.png /tmp/l && cp /tmp/l /tmp/copy && wc -c /tmp/copy', '19 /tmp/copy\n')
    // The link is as long as the path it holds, whatever it leads to.
    check(t(), 'ln -s /repo/img.png /tmp/l && du -b /tmp/l', '13\t/tmp/l\n')
    await check(t(), 'ln -s /repo/img.png /tmp/l && cat /tmp/l | base64', 'iVBORw0KGgoAAAANSUhEUv/+Cg==\n')
    await gap(t(), 'ln -s /repo/img.png /tmp/l && cat /tmp/l', 'partial UTF-8 byte sequence', 'cat: byte output that is not valid UTF-8 cannot be represented by this string-based terminal\n')
  })

  it('compares as the bytes it is, which is what diff does with a binary file', async () => {
    const t = terminal()
    await check(t, 'diff img.png img.png')
    await check(t, 'diff img.png latin.bin', 'Binary files img.png and latin.bin differ\n', { exitCode: 1 })
    await check(t, 'diff img.png text.txt', 'Binary files img.png and text.txt differ\n', { exitCode: 1 })
    await check(t, 'diff -q img.png text.txt', 'Files img.png and text.txt differ\n', { exitCode: 1 })
    await check(t, 'diff -s img.png img.png', 'Files img.png and img.png are identical\n')
    // Two files GNU reads as text because they hold no NUL, and prints as the
    // bytes they are: what it says of them without printing them — that they
    // are the same file, or, under `-q`, that they differ — is said here too.
    const pair = terminal({
      'a.bin': LATIN, 'b.bin': LATIN, 'c.bin': Uint8Array.of(0x63, 0x61, 0x66, 0xe9, 0x0a), 'text.txt': 'caf\u00E9 latte\nmore\n',
    })
    await check(pair, 'diff a.bin b.bin')
    await check(pair, 'diff -s a.bin b.bin', 'Files a.bin and b.bin are identical\n')
    await check(pair, 'diff -q a.bin c.bin', 'Files a.bin and c.bin differ\n', { exitCode: 1 })
    // The same characters spelled in other bytes are another file.
    check(pair, 'diff -q a.bin text.txt', 'Files a.bin and text.txt differ\n', { exitCode: 1 })
    // Printing the difference is printing those bytes, and an option that
    // reads text more loosely than its bytes answers for neither.
    gap(pair, 'diff a.bin c.bin', 'binary file', `diff: ${JSON.stringify('a.bin')} holds bytes that spell no text, and reading them as text is not supported\n`)
    await gap(pair, 'diff -q -i a.bin c.bin', 'binary file', `diff: ${JSON.stringify('a.bin')} holds bytes that spell no text, and reading them as text is not supported\n`)
    // `-N` stands the empty file in for a name that is not there, and a file
    // of bytes differs from it as it does from any other.
    check(t, 'diff -N img.png missing.png', 'Binary files img.png and missing.png differ\n', { exitCode: 1 })
    // `-a` asks for the bytes themselves as the diff, which is the printing
    // this terminal cannot do.
    gap(t, 'diff -a img.png text.txt', 'binary file', `diff: ${JSON.stringify('img.png')} holds bytes that spell no text, and reading them as text is not supported\n`)
  })

  it('copies into the overlay as the bytes it is', async () => {
    const t = terminal(SOURCES, { writable: '/tmp/' })
    await check(t, 'cp img.png /tmp/copy && base64 /tmp/copy', 'iVBORw0KGgoAAAANSUhEUv/+Cg==\n')
    await check(t, 'cp img.png /tmp/c2 && wc -c /tmp/c2', '19 /tmp/c2\n')
    await check(t, 'cp img.png /tmp/c3 && diff img.png /tmp/c3')
    const tree = terminal(SOURCES, { writable: '/tmp/' })
    await check(tree, 'cp -r . /tmp/all && hexdump -C /tmp/all/latin.bin', '00000000  63 61 66 e9 20 6c 61 74  74 65 0a 6d 6f 72 65 0a  |caf. latte.more.|\n00000010\n')
  })
})

describe('what a file of bytes cannot be read as', () => {
  it('says which file it is, wherever text is what a command reads', async () => {
    for (const command of ['head img.png', 'head -c4 img.png', 'tail img.png', 'tac img.png', 'nl img.png', 'uniq img.png', 'sort img.png', 'cut -c1 img.png', 'sed -n p img.png', 'tr a b < img.png']) {
      const cmd = command.split(' ')[0]
      const result = await gap(terminal(), command, 'binary file', `${command.includes('<') ? 'error' : cmd}: ${unreadable('img.png')}`)
      assert.equal(result.stdout, '', command)
    }
    await gap(terminal(), 'awk "{print}" img.png', 'binary file', `awk: ${unreadable('img.png')}`)
  })

  it('reaches a redirection the same way', async () => {
    await gap(terminal(), 'wc -c < img.png', 'binary file', `error: ${unreadable('img.png')}`)
  })

  it('carries a file of bytes down a pipe, and refuses only where a string is what is left', async () => {
    const t = terminal()
    // A pipe takes the bytes, so what follows reads the file itself.
    const piped = await t.run('cat img.png | wc -c')
    assert.deepEqual(piped.unsupported, [])
    assert.equal(piped.stdout, '19\n')
    // The gap is this terminal's own output, which is a string: the command
    // that wrote the bytes is the one that reports it.
    const printed = await t.run('cat img.png | cat')
    assert.deepEqual(printed.unsupported.map((u) => u.detail), ['partial UTF-8 byte sequence'])
    assert.equal(printed.stdout, '')
  })

  it('is what a custom command reads as bytes rather than text', async () => {
    const commands = {
      probe: (io) => io.args.map((p) => `${p} ${io.fs.isBytes(p)} ${io.fs.readBytes(p)?.length}`).join('\n') + '\n',
      show: (io) => io.fs.readFile(io.args[0]),
    }
    const t = terminal(SOURCES, { commands })
    await check(t, 'probe img.png text.txt missing', 'img.png true 19\ntext.txt false 20\nmissing false undefined\n')
    await gap(t, 'show img.png', 'binary file', `show: ${unreadable('img.png')}`)
    // The bytes are the handler's own copy: this view is read-only, so what
    // it does with them cannot reach the tree behind it.
    const poke = terminal(SOURCES, { commands: { poke: (io) => { io.fs.readBytes(io.args[0])[0] = 0x7a; return '' } } })
    await check(poke, 'poke img.png && base64 img.png', 'iVBORw0KGgoAAAANSUhEUv/+Cg==\n')
    // Reading operands the ordinary way reads them as text, which such a file
    // refuses as it refuses every other reader.
    const reader = terminal(SOURCES, { commands: { read: (io) => io.readInputs(io.args).inputs.map((input) => input.content).join('') } })
    await check(reader, 'read text.txt', 'spelled by a string\n')
    await gap(reader, 'read img.png', 'binary file', `read: ${unreadable('img.png')}`)
  })
})

describe('searching a tree that holds files of bytes', () => {
  it('searches past a file a literal cannot be in, as GNU prints nothing for one', async () => {
    const t = terminal()
    await check(t, 'grep -rn spelled .', './bytes.txt:1:spelled by bytes\n./text.txt:1:spelled by a string\n')
    await check(t, 'grep spelled text.txt img.png', 'text.txt:spelled by a string\n')
    await check(t, 'grep -c spelled text.txt img.png', 'text.txt:1\nimg.png:0\n')
    await check(t, 'grep -L spelled text.txt img.png', 'img.png\n')
    await check(t, 'grep -l spelled text.txt img.png', 'text.txt\n')
    // A fold that stays within ASCII answers for the bytes too, and `-w`
    // and `-x` only narrow what being there would select.
    check(t, 'grep -i SPELLED text.txt img.png', 'text.txt:spelled by a string\n')
    await check(t, 'grep -w spelled text.txt img.png', 'text.txt:spelled by a string\n')
    await check(t, 'grep -x spelled text.txt img.png', '', { exitCode: 1 })
  })

  it('answers every output mode for a file a literal cannot be in', async () => {
    const t = terminal()
    await check(t, 'grep -q spelled text.txt img.png')
    await check(t, 'grep -o spelled text.txt img.png', 'text.txt:spelled\n')
    await check(t, 'grep -m1 spelled text.txt img.png', 'text.txt:spelled by a string\n')
    await check(t, 'grep -A1 spelled text.txt img.png', 'text.txt:spelled by a string\n')
    await check(t, 'grep -e spelled -e zzz text.txt img.png', 'text.txt:spelled by a string\n')
    await check(t, 'grep -h spelled text.txt img.png', 'spelled by a string\n')
    await check(t, 'grep -rc spelled .', './bytes.txt:1\n./empty:0\n./img.png:0\n./latin.bin:0\n./text.txt:1\n')
    const excluded = (n, ...paths) => [`grep: excluded ${n} entries by --include/--exclude/--exclude-dir rules: ${paths.map((path) => JSON.stringify('/repo/' + path)).join(', ')}.`]
    await check(t, "grep --include='*.txt' -r spelled .", './bytes.txt:spelled by bytes\n./text.txt:spelled by a string\n', { notes: excluded(3, 'empty', 'img.png', 'latin.bin') })
    await check(t, "grep -rn --exclude='*.png' --exclude='*.bin' spelled .", './bytes.txt:1:spelled by bytes\n./text.txt:1:spelled by a string\n', { notes: excluded(2, 'img.png', 'latin.bin') })
  })

  it('refuses where the bytes could hold what was asked for', async () => {
    const t = terminal()
    const message = 'grep: binary input detection and output are not supported\n'
    await gap(t, 'grep IHDR img.png', 'binary input', message)
    await gap(t, 'grep -r IHDR .', 'binary input', message)
    // A pattern that is not a plain literal has to read the file to know,
    // and `-v` selects the lines a pattern does not, which is all of them.
    gap(t, 'grep "IH.R" img.png', 'binary input', message)
    await gap(t, 'grep -v zzz img.png', 'binary input', message)
  })

  it('is passed over by -I, as any other binary file is', async () => {
    const t = terminal()
    const skipped = ['grep: skipped 1 binary file: "/repo/img.png". Binary input is treated as text with -a.']
    await check(t, 'grep -I IHDR img.png text.txt', '', { exitCode: 1, notes: skipped })
    await check(t, 'grep -Ic IHDR img.png text.txt', 'img.png:0\ntext.txt:0\n', { exitCode: 1, notes: skipped })
  })

  it('is left out of an rg walk where ripgrep would not open it', async () => {
    // A hidden file is neither searched nor refused over: ripgrep never opens
    // one without `--hidden`, and what it never opens it never answers for.
    const files = { '.hidden.bin': LATIN, '.git/index': LATIN, 'a.txt': 'hello there\n', 'sub/b.txt': 'hello again\n' }
    const t = terminal(files)
    await check(t, 'rg hello .', './a.txt:hello there\n./sub/b.txt:hello again\n', {
      notes: ['rg: skipped 2 hidden entries: "/repo/.git", "/repo/.hidden.bin". Hidden entries are searched with --hidden.'],
    })
    await check(t, 'rg hello sub', 'sub/b.txt:hello again\n')
    // Opened, it is read, and a literal that is not in its bytes is one
    // ripgrep finds nothing of there either.
    check(t, 'rg --hidden hello .', './a.txt:hello there\n./sub/b.txt:hello again\n')
    await check(t, 'rg hello .hidden.bin', '', { exitCode: 1 })
    // One that is in them is a line ripgrep prints as the bytes it is.
    gap(t, 'rg --hidden caf .', 'unreadable bytes', `rg: ${JSON.stringify('.git/index')} holds bytes that are not text, and searching them is not supported\n`)
    await gap(t, 'rg caf .hidden.bin', 'unreadable bytes', `rg: ${JSON.stringify('.hidden.bin')} holds bytes that are not text, and searching them is not supported\n`)
  })

  it('is passed over by an rg walk where ripgrep calls it binary', async () => {
    // A NUL is what ripgrep calls binary: it stops there, prints nothing for
    // the file, and searches the rest of the tree, which is what a walk does
    // here. `--text` asks for those bytes instead, and a named one draws the
    // line ripgrep prints about a binary match.
    const files = { 'img.png': PNG, 'text.txt': 'spelled by a string\n' }
    const t = terminal(files)
    const skipped = ['grep: skipped 1 binary file: "/repo/img.png". Binary input is treated as text with -a.']
    await check(t, 'rg spelled .', './text.txt:spelled by a string\n')
    await check(t, 'rg IHDR .', '', { exitCode: 1, notes: skipped })
    await check(t, 'rg -l spelled .', './text.txt\n')
    await check(t, 'rg -c spelled .', './text.txt:1\n')
    // `--text` reads it as text, where a literal that is in its bytes is a
    // line ripgrep prints as those bytes, and one that is not changes nothing.
    check(t, 'rg -a spelled .', './text.txt:spelled by a string\n')
    await gap(t, 'rg -a IHDR .', 'unreadable bytes', `rg: ${JSON.stringify('img.png')} holds bytes that are not text, and searching them is not supported\n`)
    await gap(t, 'rg spelled img.png', 'named binary file', `rg: ${JSON.stringify('img.png')} is binary, and reporting a binary match is not supported\n`)
  })

  it('is what rg reads as neither text nor a binary match', async () => {
    const t = terminal()
    // A NUL is what ripgrep calls binary, and an encoding it cannot read is
    // what this terminal cannot search: the two are answered apart.
    gap(t, 'rg spelled img.png', 'named binary file', `rg: ${JSON.stringify('img.png')} is binary, and reporting a binary match is not supported\n`)
    await gap(t, 'rg latte latin.bin', 'unreadable bytes', `rg: ${JSON.stringify('latin.bin')} holds bytes that are not text, and searching them is not supported\n`)
    // Only a literal read as written says a file holds no match: ripgrep
    // folds case and reads a regex by its own tables, so neither answers here.
    gap(t, 'rg "l.tte" latin.bin', 'unreadable bytes', `rg: ${JSON.stringify('latin.bin')} holds bytes that are not text, and searching them is not supported\n`)
    await gap(t, 'rg -i SPELLED latin.bin', 'unreadable bytes', `rg: ${JSON.stringify('latin.bin')} holds bytes that are not text, and searching them is not supported\n`)
    // `-v` selects the lines a pattern does not, which is every line there is.
    gap(t, 'rg -v zzz latin.bin', 'unreadable bytes', `rg: ${JSON.stringify('latin.bin')} holds bytes that are not text, and searching them is not supported\n`)
    await check(t, 'rg zzz latin.bin', '', { exitCode: 1 })
  })
})

describe('a file of bytes and the writable overlay', () => {
  const overlay = () => terminal(SOURCES, { writable: '/tmp/' })

  it('copies its bytes in, and takes writes on top of them', async () => {
    const t = overlay()
    await check(t, 'cp img.png /tmp/copy')
    await check(t, 'wc -c /tmp/copy', '19 /tmp/copy\n')
    await check(t, 'base64 /tmp/copy', 'iVBORw0KGgoAAAANSUhEUv/+Cg==\n')
    await check(t, 'cat text.txt >> /tmp/copy')
    await check(t, 'wc -c /tmp/copy', '39 /tmp/copy\n')
    // What was written is still bytes that spell no text, and says so.
    await gap(t, 'cat /tmp/copy', 'partial UTF-8 byte sequence', 'cat: byte output that is not valid UTF-8 cannot be represented by this string-based terminal\n')
    await check(t, 'rm /tmp/copy && ls /tmp')
  })

  it('replaces what a name held, and refuses to copy a file onto itself', async () => {
    const t = overlay()
    await check(t, 'cp text.txt /tmp/one && wc -c /tmp/one', '20 /tmp/one\n')
    await check(t, 'cp img.png /tmp/one && wc -c /tmp/one', '19 /tmp/one\n')
    await check(t, 'cp -n bytes.txt /tmp/one && wc -c /tmp/one', '19 /tmp/one\n')
    await check(t, 'cp img.png img.png', '', { stderr: "cp: 'img.png' and 'img.png' are the same file\n", exitCode: 1 })
  })

  it('is text again in the overlay where its bytes spell text', async () => {
    const t = overlay()
    await check(t, 'cp bytes.txt /tmp/b && cat /tmp/b', 'spelled by bytes\n')
    await check(t, 'cp bytes.txt /tmp/c && sed -i s/bytes/BYTES/ /tmp/c && cat /tmp/c', 'spelled by BYTES\n')
  })

  it('is compared by its bytes where a hint weighs two paths', async () => {
    // The hint that names both paths says whether they differ, which it must
    // answer without reading either as text — a file of bytes has none.
    const note = (differ) => [`cat: relative path "tmp/file" was not found from cwd "/repo/sub". Both of "/repo/tmp/file" and "/tmp/file" exist${differ ? ', and they differ in contents' : ''}.`]
    for (const [mounted, copied, differ] of [
      [PNG, PNG, false],
      [PNG, LATIN, true],
      [encodeUtf8('same\n'), 'same\n', false],
      [encodeUtf8('same\n'), 'other\n', true],
    ]) {
      const t = createTerminal({ 'tmp/file': mounted, 'sub/keep': '', overlay: copied }, { mount: '/repo', cwd: '/repo/sub', writable: '/tmp/' })
      assert.equal((await t.run('cp /repo/overlay /tmp/file')).exitCode, 0)
      assert.deepEqual((await t.run('cat tmp/file')).notes, note(differ))
    }
  })
})
