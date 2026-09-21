import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// RFC 4648 base32, which is coreutils' own: five bytes to eight characters,
// padded to eight with `=`, wrapped at 76. Every case below was recorded from
// base32 (GNU coreutils) 9.4 over the same bytes.
const SOURCES = {
  'a.txt': 'alpha\nbeta\n',
  'hello': 'hello',
  'img.png': Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0xff, 0x0a),
  'encoded': 'NBSWY3DPBI======\n',
}
const terminal = () => createTerminal(SOURCES, { mount: '/repo', writable: '/tmp/' })
const result = (stdout = '', { stderr = '', exitCode = 0, notes = [], unsupported = [] } = {}) =>
  ({ stdout, stderr, exitCode, cwd: '/repo', notes, unsupported })
const INVALID = 'base32: invalid input\n'

describe('base32 writes what coreutils writes', () => {
  it('encodes a file and a pipe alike', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('base32 hello'), result('NBSWY3DP\n'))
    assert.deepEqual(await t.run('printf %s hi | base32'), result('NBUQ====\n'))
    assert.deepEqual(await t.run('printf %s abc | base32'), result('MFRGG===\n'))
    assert.deepEqual(await t.run('printf %s abcd | base32'), result('MFRGGZA=\n'))
    assert.deepEqual(await t.run('printf %s abcde | base32'), result('MFRGGZDF\n'))
    // Nothing in, nothing out — not even the newline a wrap would end on.
    assert.deepEqual(await t.run('printf "" | base32'), result(''))
    assert.deepEqual(await t.run('base32 a.txt'), result('MFWHA2DBBJRGK5DBBI======\n'))
  })

  it('wraps where coreutils wraps, and where it is told to', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('base32 -w 4 hello'), result('NBSW\nY3DP\n'))
    assert.deepEqual(await t.run('base32 -w 0 hello'), result('NBSWY3DP'))
    assert.deepEqual(await t.run('base32 --wrap=0 hello'), result('NBSWY3DP'))
    // The default is 76, so a line long enough to need it is broken there.
    const long = await t.run('printf "%s" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | base32')
    assert.deepEqual(long.stdout.split('\n').map((line) => line.length), [76, 4, 0])
    assert.deepEqual(await t.run('base32 -w x hello'), result('', { stderr: 'base32: invalid wrap size: x\n', exitCode: 1 }))
  })

  it('encodes bytes that spell no text, which is what it is for', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('base32 img.png'), result('RFIE4R77BI======\n'))
    assert.deepEqual(await t.run('cat img.png | base32'), result('RFIE4R77BI======\n'))
  })
})

describe('base32 reads back what coreutils reads back', () => {
  it('decodes a padded group, and the groups after it', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('base32 -d encoded'), result('hello\n'))
    assert.deepEqual(await t.run('echo NBUQ==== | base32 -d'), result('hi'))
    assert.deepEqual(await t.run('echo NBSWY3DP | base32 -d'), result('hello'))
    assert.deepEqual(await t.run('echo MF======MFRGGZDF | base32 -d'), result('aabcde'))
    // The bits past the last whole byte are not read, so spelling them
    // differently spells the same bytes.
    assert.deepEqual(await t.run('echo MFRGGZB= | base32 -d'), result('abcd'))
  })

  it('writes what it recovered before saying the rest was not its alphabet', async () => {
    const t = terminal()
    // A group short of eight is not a group yet: nothing of it is written.
    assert.deepEqual(await t.run('echo NBSWY3DPBI | base32 -d'), result('hello', { stderr: INVALID, exitCode: 1 }))
    assert.deepEqual(await t.run('echo NBSWY3DP= | base32 -d'), result('hello', { stderr: INVALID, exitCode: 1 }))
    assert.deepEqual(await t.run('echo NBUQ | base32 -d'), result('', { stderr: INVALID, exitCode: 1 }))
    // A whole group whose padding is not one of the counts it may have is
    // read for the bytes it spells in full, and then called invalid.
    assert.deepEqual(await t.run('echo MFRGGZ== | base32 -d'), result('abc', { stderr: INVALID, exitCode: 1 }))
    assert.deepEqual(await t.run('echo MFR===== | base32 -d'), result('a', { stderr: INVALID, exitCode: 1 }))
    assert.deepEqual(await t.run('echo M======= | base32 -d'), result('', { stderr: INVALID, exitCode: 1 }))
    assert.deepEqual(await t.run('echo ======== | base32 -d'), result('', { stderr: INVALID, exitCode: 1 }))
    assert.deepEqual(await t.run('echo NBUQ===== | base32 -d'), result('hi', { stderr: INVALID, exitCode: 1 }))
    assert.deepEqual(await t.run('echo MFRGGZA=X | base32 -d'), result('abcd', { stderr: INVALID, exitCode: 1 }))
  })

  it('takes its own alphabet and no other, unless told to ignore the rest', async () => {
    const t = terminal()
    // Lowercase is not the alphabet, and coreutils does not fold it.
    assert.deepEqual(await t.run('echo nbswy3dp | base32 -d'), result('', { stderr: INVALID, exitCode: 1 }))
    assert.deepEqual(await t.run('echo @NBUQ==== | base32 -d'), result('', { stderr: INVALID, exitCode: 1 }))
    assert.deepEqual(await t.run('echo "@NB!UQ====" | base32 -di'), result('hi'))
    assert.deepEqual(await t.run('echo "@NB!UQ====" | base32 -d --ignore-garbage'), result('hi'))
  })

  it('hands the bytes it decoded on, since bytes are what it decoded', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('base32 img.png | base32 -d | hexdump -C'), result('00000000  89 50 4e 47 ff 0a                                 |.PNG..|\n00000006\n'))
    assert.deepEqual(await t.run('base32 img.png | base32 -d | base64'), result('iVBOR/8K\n'))
    // The terminal's own answer is a string, so that is where it cannot go.
    const r = await t.run('base32 img.png | base32 -d')
    assert.deepEqual(r.unsupported.map((u) => u.detail), ['partial UTF-8 byte sequence'])
    assert.equal(r.exitCode, 1)
  })
})

describe('base32 is a command this terminal has without announcing it', () => {
  it('completes, and is a pipe target, without joining the hint', async () => {
    const t = terminal()
    assert.deepEqual(t.complete('base3'), ['base32'])
    assert.ok(t.complete('base').includes('base32'))
    assert.ok(t.complete('base').includes('base64'))
    assert.ok(t.complete('cat | ').includes('cat | base32'))
    const hint = (await t.run('nope')).unsupported[0].message
    assert.ok(!hint.includes('base32'))
    assert.ok(hint.includes('base64'))
  })
})
