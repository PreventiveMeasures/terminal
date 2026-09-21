import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { createFs } from '../src/fs.js'
import { encodeUtf8 } from '../src/util.js'

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

const terminal = (sources = SOURCES, options = {}) => createTerminal(sources, { mount: '/repo', ...options })

function check(t, command, stdout = '', { stderr = '', exitCode = 0, notes = [], cwd = '/repo' } = {}) {
  assert.deepEqual(t.run(command), { stdout, stderr, exitCode, cwd, notes, unsupported: [] }, command)
}

// A gap reports on every channel: the command fails, says which file it could
// not read, and the run carries the diagnostic where a redirect cannot hide it.
function gap(t, command, detail, stderr) {
  const result = t.run(command)
  assert.deepEqual(result.unsupported.map((u) => u.detail), [detail], command)
  assert.equal(result.stderr, stderr, command)
  assert.notEqual(result.exitCode, 0, command)
  return result
}

const unreadable = (name) => `${JSON.stringify('/repo/' + name)} holds bytes that spell no text, and reading them as text is not supported\n`

describe('a source entry can be the bytes of a file', () => {
  it('holds the bytes as given, copied away from the caller', () => {
    const live = Uint8Array.of(1, 2, 3)
    const t = terminal({ f: live })
    live[0] = 9
    check(t, 'wc -c f', '3 f\n')
    check(t, 'base64 f', 'AQID\n')
  })

  it('takes any one-byte view, and refuses what is not one', () => {
    // Every one-byte view is the bytes it holds, `Buffer` — a `Uint8Array`
    // of its own — among them, and a view into a larger buffer is the part
    // of it the view is over.
    for (const view of [new Int8Array([-1, 10]), new Uint8ClampedArray([255, 10]), Uint8Array.of(0, 0xff, 0x0a, 0).subarray(1, 3)]) {
      check(terminal({ f: view }), 'wc -c f', '2 f\n')
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

  it('reads as the text its bytes spell, where they spell one', () => {
    const t = terminal()
    check(t, 'cat bytes.txt', 'spelled by bytes\n')
    check(t, 'grep -c spelled bytes.txt text.txt', 'bytes.txt:1\ntext.txt:1\n')
    check(t, 'sed s/bytes/BYTES/ bytes.txt', 'spelled by BYTES\n')
    check(t, 'wc bytes.txt', ' 1  3 17 bytes.txt\n')
    check(t, 'diff bytes.txt bytes.txt')
  })
})

describe('what a file of bytes answers without being read as text', () => {
  it('measures, sizes and lists it', () => {
    const t = terminal()
    check(t, 'wc -c img.png latin.bin', '19 img.png\n16 latin.bin\n35 total\n')
    check(t, 'wc img.png', ' 3  2 19 img.png\n')
    check(t, 'stat -c "%s %F" img.png', '19 regular file\n')
    check(t, 'du -b img.png', '19\timg.png\n')
    check(t, 'find . -empty', './empty\n')
    check(t, 'test -e img.png && echo yes', 'yes\n')
    check(t, 'ls', 'bytes.txt\nempty\nimg.png\nlatin.bin\ntext.txt\n')
  })

  it('counts its lines and words as GNU does, and refuses to guess its characters', () => {
    const t = terminal()
    check(t, 'wc -l img.png', '3 img.png\n')
    check(t, 'wc -w img.png', '2 img.png\n')
    check(t, 'wc -w latin.bin', '3 latin.bin\n')
    gap(t, 'wc -m img.png', 'binary file', `wc: ${JSON.stringify('/repo/img.png')} holds bytes that spell no text, and counting their characters is not supported\n`)
  })

  it('prints its bytes where the printing is text', () => {
    const t = terminal()
    check(t, 'base64 img.png', 'iVBORw0KGgoAAAANSUhEUv/+Cg==\n')
    check(t, 'hexdump -C latin.bin', '00000000  63 61 66 e9 20 6c 61 74  74 65 0a 6d 6f 72 65 0a  |caf. latte.more.|\n00000010\n')
    check(t, 'xxd img.png', '00000000: 8950 4e47 0d0a 1a0a 0000 000d 4948 4452  .PNG........IHDR\n00000010: fffe 0a                                  ...\n')
    check(t, 'hexdump -C empty')
  })

  it('compares as the bytes it is, which is what diff does with a binary file', () => {
    const t = terminal()
    check(t, 'diff img.png img.png')
    check(t, 'diff img.png latin.bin', 'Binary files img.png and latin.bin differ\n', { exitCode: 1 })
    check(t, 'diff img.png text.txt', 'Binary files img.png and text.txt differ\n', { exitCode: 1 })
    check(t, 'diff -q img.png text.txt', 'Files img.png and text.txt differ\n', { exitCode: 1 })
    check(t, 'diff -s img.png img.png', 'Files img.png and img.png are identical\n')
    // `-a` asks for the bytes themselves as the diff, which is the printing
    // this terminal cannot do.
    gap(t, 'diff -a img.png text.txt', 'binary file', `diff: ${JSON.stringify('img.png')} holds bytes that spell no text, and reading them as text is not supported\n`)
  })

  it('copies into the overlay as the bytes it is', () => {
    const t = terminal(SOURCES, { writable: '/tmp/' })
    check(t, 'cp img.png /tmp/copy && base64 /tmp/copy', 'iVBORw0KGgoAAAANSUhEUv/+Cg==\n')
    check(t, 'cp img.png /tmp/c2 && wc -c /tmp/c2', '19 /tmp/c2\n')
    check(t, 'cp img.png /tmp/c3 && diff img.png /tmp/c3')
    const tree = terminal(SOURCES, { writable: '/tmp/' })
    check(tree, 'cp -r . /tmp/all && hexdump -C /tmp/all/latin.bin', '00000000  63 61 66 e9 20 6c 61 74  74 65 0a 6d 6f 72 65 0a  |caf. latte.more.|\n00000010\n')
  })
})

describe('what a file of bytes cannot be read as', () => {
  it('says which file it is, wherever text is what a command reads', () => {
    for (const command of ['cat img.png', 'head img.png', 'head -c4 img.png', 'tail img.png', 'tac img.png', 'nl img.png', 'uniq img.png', 'sort img.png', 'cut -c1 img.png', 'sed -n p img.png', 'tr a b < img.png', 'cat img.png text.txt']) {
      const cmd = command.split(' ')[0]
      const result = gap(terminal(), command, 'binary file', `${command.includes('<') ? 'error' : cmd}: ${unreadable('img.png')}`)
      assert.equal(result.stdout, '', command)
    }
    gap(terminal(), 'awk "{print}" img.png', 'binary file', `awk: ${unreadable('img.png')}`)
  })

  it('reaches a redirection the same way', () => {
    gap(terminal(), 'wc -c < img.png', 'binary file', `error: ${unreadable('img.png')}`)
  })

  it('keeps the text files of a run readable beside it', () => {
    const t = terminal()
    // A pipeline is the gap of the command that met the file; what follows
    // reads the nothing that command wrote.
    const result = t.run('cat img.png | wc -c')
    assert.deepEqual(result.unsupported.map((u) => u.detail), ['binary file'])
    assert.equal(result.stdout, '0\n')
  })

  it('is what a custom command reads as bytes rather than text', () => {
    const commands = {
      probe: (io) => io.args.map((p) => `${p} ${io.fs.isBytes(p)} ${io.fs.readBytes(p)?.length}`).join('\n') + '\n',
      show: (io) => io.fs.readFile(io.args[0]),
    }
    const t = terminal(SOURCES, { commands })
    check(t, 'probe img.png text.txt missing', 'img.png true 19\ntext.txt false 20\nmissing false undefined\n')
    gap(t, 'show img.png', 'binary file', `show: ${unreadable('img.png')}`)
  })
})

describe('searching a tree that holds files of bytes', () => {
  it('searches past a file a literal cannot be in, as GNU prints nothing for one', () => {
    const t = terminal()
    check(t, 'grep -rn spelled .', './bytes.txt:1:spelled by bytes\n./text.txt:1:spelled by a string\n')
    check(t, 'grep spelled text.txt img.png', 'text.txt:spelled by a string\n')
    check(t, 'grep -c spelled text.txt img.png', 'text.txt:1\nimg.png:0\n')
    check(t, 'grep -L spelled text.txt img.png', 'img.png\n')
    check(t, 'grep -l spelled text.txt img.png', 'text.txt\n')
    // A fold that stays within ASCII answers for the bytes too, and `-w`
    // and `-x` only narrow what being there would select.
    check(t, 'grep -i SPELLED text.txt img.png', 'text.txt:spelled by a string\n')
    check(t, 'grep -w spelled text.txt img.png', 'text.txt:spelled by a string\n')
    check(t, 'grep -x spelled text.txt img.png', '', { exitCode: 1 })
  })

  it('refuses where the bytes could hold what was asked for', () => {
    const t = terminal()
    const message = 'grep: binary input detection and output are not supported\n'
    gap(t, 'grep IHDR img.png', 'binary input', message)
    gap(t, 'grep -r IHDR .', 'binary input', message)
    // A pattern that is not a plain literal has to read the file to know,
    // and `-v` selects the lines a pattern does not, which is all of them.
    gap(t, 'grep "IH.R" img.png', 'binary input', message)
    gap(t, 'grep -v zzz img.png', 'binary input', message)
  })

  it('is passed over by -I, as any other binary file is', () => {
    const t = terminal()
    const skipped = ['grep: skipped 1 binary file: "/repo/img.png". Binary input is treated as text with -a.']
    check(t, 'grep -I IHDR img.png text.txt', '', { exitCode: 1, notes: skipped })
    check(t, 'grep -Ic IHDR img.png text.txt', 'img.png:0\ntext.txt:0\n', { exitCode: 1, notes: skipped })
  })

  it('is what rg reads as neither text nor a binary match', () => {
    const t = terminal()
    // A NUL is what ripgrep calls binary, and an encoding it cannot read is
    // what this terminal cannot search: the two are answered apart.
    gap(t, 'rg spelled img.png', 'named binary file', `rg: ${JSON.stringify('img.png')} is binary, and reporting a binary match is not supported\n`)
    gap(t, 'rg spelled latin.bin', 'unreadable bytes', `rg: ${JSON.stringify('latin.bin')} holds bytes that are not text, and searching them is not supported\n`)
  })
})
