import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { describe, it, mock } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// gzip is the one command here whose work a line does not do for itself:
// deflating and inflating are the runtime's streams, and both answer
// asynchronously. A line waits for them where it meets them, which is what an
// asynchronous `run` is for. Every diagnostic below was recorded from GNU
// gzip 1.12 over the same bytes written to disk.
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
  const r = await t.run(command)
  assert.deepEqual(r.unsupported.map((u) => u.detail), [detail], command)
  assert.equal(r.stderr, stderr, command)
  assert.notEqual(r.exitCode, 0, command)
  return r
}

describe('gzip decompresses what a runtime inflated for it', () => {
  it('writes a member to stdout', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('gzip -dc data.gz'), result('alpha\nbeta\n'))
    assert.deepEqual(await t.run('gzip -d -c data.gz'), result('alpha\nbeta\n'))
    assert.deepEqual(await t.run('gzip --decompress --stdout data.gz'), result('alpha\nbeta\n'))
    // The name says nothing about what the bytes are: `-c` reads the member.
    assert.deepEqual(await t.run('gzip -dc named.dat'), result('alpha\nbeta\n'))
    assert.equal((await t.run('gzip -dc data.gz | wc -l')).stdout, '2\n')
  })

  it('answers under the bin names it is reached by', async () => {
    const t = terminal()
    const bins = ['/usr/bin/gzip', '/bin/gzip', '/usr/local/bin/gzip']
    const answers = await Promise.all(bins.map(async (name) => await t.run(`${name} -dc data.gz`)))
    for (const answer of answers) assert.deepEqual(answer, result('alpha\nbeta\n'))
    // It is not one of the commands this terminal announces, so it is not in
    // the list of them — and is completed all the same, in command position
    // and after a pipe, since the terminal has it.
    const missing = await t.run('nosuchcommand')
    assert.match(missing.stderr, /command not found\. Available: /u)
    assert.doesNotMatch(missing.stderr, /gzip/u)
    assert.deepEqual(t.complete('gzi'), ['gzip'])
    assert.deepEqual(t.complete('cat data.gz | gz'), ['cat data.gz | gzip'])
  })

  it('says what GNU says of what is not a member', async () => {
    const t = terminal()
    // Data errors carry a newline ahead of them, as gzip writes them.
    assert.deepEqual(await t.run('gzip -dc plain.txt'), result('', { stderr: '\ngzip: plain.txt: not in gzip format\n', exitCode: 1 }))
    assert.deepEqual(await t.run('gzip -dc empty.gz'), result('', { stderr: '\ngzip: empty.gz: unexpected end of file\n', exitCode: 1 }))
    // What it inflated before the end it ran into is still written.
    assert.deepEqual(await t.run('gzip -dc trunc.gz'), result('alpha\nbeta\n', { stderr: '\ngzip: trunc.gz: unexpected end of file\n', exitCode: 1 }))
    assert.deepEqual(await t.run('gzip -dc crc.gz'), result('', { stderr: '\ngzip: crc.gz: invalid compressed data--crc error\n', exitCode: 1 }))
    // A file it could not open, and one it passed over, are reported as they
    // stand — and a warning is a status of its own.
    assert.deepEqual(await t.run('gzip -dc missing.gz'), result('', { stderr: 'gzip: missing.gz: No such file or directory\n', exitCode: 1 }))
    assert.deepEqual(await t.run('gzip -dc dir'), result('', { stderr: 'gzip: dir is a directory -- ignored\n', exitCode: 2 }))
  })

  it('reads a pipe the way GNU reads one carrying anything else', async () => {
    // Stdin is text here, and no text spells a member: the second byte of the
    // header begins no character at all.
    const t = terminal()
    assert.deepEqual(await t.run('echo x | gzip -d'), result('', { stderr: '\ngzip: stdin: not in gzip format\n', exitCode: 1 }))
    assert.deepEqual(await t.run('printf "" | gzip -dc'), result('', { stderr: '\ngzip: stdin: unexpected end of file\n', exitCode: 1 }))
  })

  it('takes every operand it was given, and the worst of what they answer', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('gzip -dc data.gz plain.txt'), result('alpha\nbeta\n', { stderr: '\ngzip: plain.txt: not in gzip format\n', exitCode: 1 }))
    // A directory alone is a warning; an error beside it is what is reported.
    assert.deepEqual(await t.run('gzip -dc dir plain.txt'), result('', { stderr: 'gzip: dir is a directory -- ignored\n\ngzip: plain.txt: not in gzip format\n', exitCode: 1 }))
  })

  it('writes the file beside the one it came from, where that can be written', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('cp data.gz /tmp/x.gz && gzip -d /tmp/x.gz && cat /tmp/x'), result('alpha\nbeta\n'))
    // The copy is gone with it, unless `-k` keeps it.
    assert.deepEqual(await t.run('ls /tmp'), result('x\n'))
    assert.deepEqual(await t.run('cp data.gz /tmp/k.gz && gzip -dk /tmp/k.gz && ls /tmp'), result('k\nk.gz\nx\n'))
    // `.tgz` is the one suffix that leaves a name behind rather than taking
    // one off, and a name with no suffix to take off is left alone.
    assert.deepEqual(await t.run('cp arch.tgz /tmp/a.tgz && gzip -d /tmp/a.tgz && cat /tmp/a.tar'), result('alpha\nbeta\n'))
    assert.deepEqual(await t.run('cp named.dat /tmp/n.dat && gzip -d /tmp/n.dat'), result('', { stderr: 'gzip: /tmp/n.dat: unknown suffix -- ignored\n', exitCode: 2 }))
    assert.deepEqual(await t.run('cp data.gz /tmp/x.gz && gzip -d /tmp/x.gz'), result('', { stderr: 'gzip: /tmp/x already exists;\tnot overwritten\n', exitCode: 2 }))
  })

  it('refuses to write where nothing can be written', async () => {
    await gap(terminal(), 'gzip -d data.gz', 'read-only target', 'gzip: data: file system is read-only\n')
  })

  it('carries bytes that spell no text into a file, and refuses to print them', async () => {
    const t = terminal()
    // Written to a file, a member of bytes is those bytes.
    assert.deepEqual(await t.run('cp img.gz /tmp/i.gz && gzip -d /tmp/i.gz && wc -c /tmp/i'), result('6 /tmp/i\n'))
    assert.deepEqual(await t.run('base64 /tmp/i'), result('iVBOR/8K\n'))
    // Printed, they are the output this terminal cannot carry.
    await gap(t, 'gzip -dc img.gz', 'partial UTF-8 byte sequence',
      'gzip: byte output that is not valid UTF-8 cannot be represented by this string-based terminal\n')
  })

  it('refuses what it does not do at all', async () => {
    const t = terminal()
    await gap(t, 'gzip -dl data.gz', '-l', 'gzip: unknown option: -l\n')
    await gap(t, 'gzip -dv data.gz', '-v', 'gzip: unknown option: -v\n')
    // A stream compresses as hard as it compresses, and is told nothing
    // about it, so a level is refused rather than accepted and ignored.
    await gap(t, 'gzip -9 plain.txt', '-9', 'gzip: -9: choosing a compression level is not supported\n')
  })
})

// The member GNU writes for a file named `f` holding `alpha\nbeta\n`, whose
// modification time is MADE: `touch -d @1789710720 f && gzip -c f`. The name
// and the moment are in the header, which is why the clock is stopped for it.
const MADE = Date.UTC(2026, 8, 18, 5, 52)
const MEMBER = Uint8Array.of(
  0x1f, 0x8b, 0x08, 0x08, 0x80, 0xd1, 0xac, 0x6a, 0x00, 0x03, 0x66, 0x00, 0x4b, 0xcc, 0x29, 0xc8, 0x48,
  0xe4, 0x4a, 0x4a, 0x2d, 0x49, 0xe4, 0x02, 0x00, 0x6e, 0x50, 0x30, 0x6e, 0x0b, 0x00, 0x00, 0x00,
)
const bytesOf = (base64) => Uint8Array.from(Buffer.from(base64.trim(), 'base64'))

describe('gzip compresses with the stream the runtime has', () => {
  const stopped = async (fn) => {
    mock.timers.enable({ apis: ['Date'], now: MADE })
    try { return await fn() } finally { mock.timers.reset() }
  }

  it('writes what GNU writes, header and all', async () => {
    // The tree has no clock of its own, so the moment it was made stands in —
    // the one `ls -l` dates its files to — and the name is the file's own.
    const r = await stopped(() => {
      const t = createTerminal({ f: 'alpha\nbeta\n' }, { mount: '/repo', writable: '/tmp/' })
      return t.run('cp f /tmp/f && gzip /tmp/f && base64 /tmp/f.gz')
    })
    assert.equal(r.stderr, '')
    assert.deepEqual(bytesOf(r.stdout), MEMBER)
  })

  it('writes the member beside the file it came from, and takes that file with it', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('cp plain.txt /tmp/p && gzip /tmp/p && ls /tmp'), result('p.gz\n'))
    assert.deepEqual(await t.run('cp plain.txt /tmp/k && gzip -k /tmp/k && ls /tmp'), result('k\nk.gz\np.gz\n'))
    // And what it wrote is what it reads back.
    assert.deepEqual(await t.run('gzip -dc /tmp/k.gz'), result('not compressed\n'))
    assert.deepEqual(await t.run('gzip -d /tmp/p.gz && cat /tmp/p'), result('not compressed\n'))
  })

  it('carries bytes that spell no text through the round trip', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('cp img.gz /tmp/i.gz && gzip -d /tmp/i.gz && gzip /tmp/i && gzip -d /tmp/i.gz && base64 /tmp/i'), result('iVBOR/8K\n'))
  })

  it('cannot hand back a member, because no string spells one', async () => {
    // The second byte of the header begins no character at all, so `-c` is
    // the output this terminal cannot carry — and a pipe is the same answer.
    const t = terminal()
    const message = 'gzip: byte output that is not valid UTF-8 cannot be represented by this string-based terminal\n'
    await gap(t, 'gzip -c plain.txt', 'partial UTF-8 byte sequence', message)
    await gap(t, 'echo hi | gzip', 'partial UTF-8 byte sequence', message)
  })

  it('refuses to write where nothing can be written', async () => {
    await gap(terminal(), 'gzip plain.txt', 'read-only target', 'gzip: plain.txt.gz: file system is read-only\n')
  })

  it('says what GNU says of a file it will not compress', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('gzip missing.txt'), result('', { stderr: 'gzip: missing.txt: No such file or directory\n', exitCode: 1 }))
    assert.deepEqual(await t.run('gzip dir'), result('', { stderr: 'gzip: dir is a directory -- ignored\n', exitCode: 2 }))
    // A file already named as a member is left alone, and GNU makes nothing
    // of it: it says so and the status stays what it was.
    assert.deepEqual(await t.run('gzip data.gz'), result('', { stderr: 'gzip: data.gz already has .gz suffix -- unchanged\n' }))
    assert.deepEqual(await t.run('gzip arch.tgz'), result('', { stderr: 'gzip: arch.tgz already has .tgz suffix -- unchanged\n' }))
    // With `-c` there is no name to write, so there is nothing to object to.
    await gap(t, 'gzip -c data.gz', 'partial UTF-8 byte sequence',
      'gzip: byte output that is not valid UTF-8 cannot be represented by this string-based terminal\n')
    assert.deepEqual(await t.run('cp plain.txt /tmp/t && cp plain.txt /tmp/t.gz && gzip /tmp/t'),
      result('', { stderr: 'gzip: /tmp/t.gz already exists;\tnot overwritten\n', exitCode: 2 }))
  })
})

// GNU ships one program under three names: `gunzip` is gzip decompressing and
// `zcat` is gzip decompressing to stdout. Both say `gzip:` of what they cannot
// read, because that is the program saying it. Recorded from gzip 1.12, whose
// gunzip and zcat are that binary reached by another name.
describe('gunzip and zcat are gzip under the names it also answers to', () => {
  it('decompresses a member to stdout under either name', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('gunzip -c data.gz'), result('alpha\nbeta\n'))
    assert.deepEqual(await t.run('zcat data.gz'), result('alpha\nbeta\n'))
    assert.deepEqual(await t.run('cat data.gz | gunzip'), result('alpha\nbeta\n'))
    assert.deepEqual(await t.run('cat data.gz | zcat'), result('alpha\nbeta\n'))
    // zcat takes the operands gzip does, one after another.
    assert.deepEqual(await t.run('zcat data.gz data.gz'), result('alpha\nbeta\n'.repeat(2)))
    assert.deepEqual(await t.run('zcat data.gz | wc -c'), result('11\n'))
  })

  it('hands the bytes of a member on, as gzip does', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('zcat img.gz | hexdump -C'), result('00000000  89 50 4e 47 ff 0a                                 |.PNG..|\n00000006\n'))
    assert.deepEqual(await t.run('cat img.gz | gunzip | base64'), result('iVBOR/8K\n'))
  })

  it('reports as the program it is, which is gzip', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('gunzip -c missing.gz'), result('', { stderr: 'gzip: missing.gz: No such file or directory\n', exitCode: 1 }))
    assert.deepEqual(await t.run('zcat missing.gz'), result('', { stderr: 'gzip: missing.gz: No such file or directory\n', exitCode: 1 }))
    // The blank line before those two is GNU's own, and so is theirs.
    assert.deepEqual(await t.run('zcat plain.txt'), result('', { stderr: '\ngzip: plain.txt: not in gzip format\n', exitCode: 1 }))
    // GNU writes what it inflated before it ran out, and then says so.
    assert.deepEqual(await t.run('zcat trunc.gz'), result('alpha\nbeta\n', { stderr: '\ngzip: trunc.gz: unexpected end of file\n', exitCode: 1 }))
  })

  it('completes as gzip does, and is announced as little as gzip is', async () => {
    const t = terminal()
    assert.deepEqual(t.complete('gun'), ['gunzip'])
    assert.deepEqual(t.complete('zc'), ['zcat'])
    assert.deepEqual(t.complete('gz'), ['gzip'])
    // Readers, so pipe targets, as gzip is.
    for (const name of ['gzip', 'gunzip', 'zcat']) {
      assert.ok(t.complete('cat | ').includes(`cat | ${name}`), name)
    }
    // None of the three is announced: the hint stays the everyday list.
    const hint = (await t.run('nope')).unsupported[0].message
    for (const name of ['gzip', 'gunzip', 'zcat']) {
      assert.ok(!hint.includes(name), name)
    }
  })
})
