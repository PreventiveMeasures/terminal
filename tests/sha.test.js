import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// The digest itself is the runtime's work rather than this code's:
// `crypto.subtle` does it, and it answers asynchronously, which a line waits
// for where it meets it. Every digest and diagnostic below was recorded from
// coreutils 9.4 (`sha256sum`, `sha1sum`) and Digest::SHA 6.02 (`shasum`) over
// the same bytes written to disk.
const ALPHA = 'alpha\nbeta\n'
const DIGESTS = {
  1: '9269a71477ce057095d7e6bb5238b4bd6e13c051',
  256: 'e49c81e2d2f84e259d40e2fb8192f3bcd198b355184845d76d8f58807d0d78ee',
  384: '9670abb09c68f1b685428bb8bde79740b5824ebf1eb5428d1ec8703a412fb95724c9df2605d8254d8b074e80d760b86b',
  512: '5d952a712d58cb49eebe1bdfbe51d263e85067e140d9ed7bba2a122a62074ecff26ef880184e70bdcbe61ecf9e42dffb51ab1718d2b1da2fd12b4c5814cebe14',
}
const EMPTY_256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
// The six bytes of `\x89PNG\xff\n`, which spell no text.
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0xff, 0x0a)
const PNG_256 = '679ae6a4120cc43d94e6462f34fa9fef218ba7de581f7e509e5bc5f924338b34'

const SOURCES = { 'a.txt': ALPHA, empty: '', 'img.png': PNG, 'dir/inner.txt': 'inner\n' }
const terminal = () => createTerminal(SOURCES, { mount: '/repo', writable: '/tmp/' })
const result = (stdout = '', { stderr = '', exitCode = 0, notes = [], unsupported = [] } = {}) =>
  ({ stdout, stderr, exitCode, cwd: '/repo', notes, unsupported })

describe('the digest commands are the ones coreutils and shasum write', () => {
  it('writes the digest, the mode and the name', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('sha256sum a.txt'), result(`${DIGESTS[256]}  a.txt\n`))
    assert.deepEqual(await t.run('sha1sum a.txt'), result(`${DIGESTS[1]}  a.txt\n`))
    assert.deepEqual(await t.run('sha384sum a.txt'), result(`${DIGESTS[384]}  a.txt\n`))
    assert.deepEqual(await t.run('sha512sum a.txt'), result(`${DIGESTS[512]}  a.txt\n`))
    // `-b` marks the mode with a star, where text mode is two spaces.
    assert.deepEqual(await t.run('sha256sum -b a.txt'), result(`${DIGESTS[256]} *a.txt\n`))
    // `--tag` says which digest it is instead, and marks nothing.
    assert.deepEqual(await t.run('sha256sum --tag -b a.txt'), result(`SHA256 (a.txt) = ${DIGESTS[256]}\n`))
    // One line per operand, in operand order, and `-z` ends them with NUL.
    assert.deepEqual(await t.run('sha256sum a.txt empty'), result(`${DIGESTS[256]}  a.txt\n${EMPTY_256}  empty\n`))
    assert.deepEqual(await t.run('sha256sum -z a.txt empty'), result(`${DIGESTS[256]}  a.txt\0${EMPTY_256}  empty\0`))
  })

  it('digests what came in on a pipe, naming it `-`', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('cat a.txt | sha256sum'), result(`${DIGESTS[256]}  -\n`))
    assert.deepEqual(await t.run('printf "" | sha256sum'), result(`${EMPTY_256}  -\n`))
    // The bytes of a pipe are the bytes, whether or not they spell text.
    assert.deepEqual(await t.run('cat img.png | sha256sum'), result(`${PNG_256}  -\n`))
    assert.deepEqual(await t.run('sha256sum img.png'), result(`${PNG_256}  img.png\n`))
  })

  it('takes the algorithm shasum takes, and is SHA-1 without one', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('shasum a.txt'), result(`${DIGESTS[1]}  a.txt\n`))
    assert.deepEqual(await t.run('shasum -a 256 a.txt'), result(`${DIGESTS[256]}  a.txt\n`))
    assert.deepEqual(await t.run('shasum -a 512 a.txt'), result(`${DIGESTS[512]}  a.txt\n`))
    assert.deepEqual(await t.run('shasum --tag a.txt'), result(`SHA1 (a.txt) = ${DIGESTS[1]}\n`))
    // A number shasum does not know is its own error, not a gap.
    const unknown = await t.run('shasum -a 7 a.txt')
    assert.deepEqual(unknown, result('', { stderr: 'shasum: Unrecognized algorithm\nType shasum -h for help\n', exitCode: 1 }))
    // One it knows that this runtime's crypto does not do is a gap.
    const missing = await t.run('shasum -a 224 a.txt')
    assert.deepEqual(missing.unsupported.map((u) => u.detail), ['SHA-224'])
    assert.equal(missing.stderr, "shasum: this runtime's crypto does not digest SHA-224\n")
  })

  it('says what coreutils says of what it could not read', async () => {
    const t = terminal()
    // A missing operand is reported and the rest are still digested.
    assert.deepEqual(await t.run('sha256sum missing a.txt'),
      result(`${DIGESTS[256]}  a.txt\n`, { stderr: 'sha256sum: missing: No such file or directory\n', exitCode: 1 }))
    assert.deepEqual(await t.run('sha256sum dir'), result('', { stderr: 'sha256sum: dir: Is a directory\n', exitCode: 1 }))
    assert.deepEqual(await t.run('shasum missing'), result('', { stderr: 'shasum: missing: No such file or directory\n', exitCode: 1 }))
  })

  it('refuses what it does not do', async () => {
    const t = terminal()
    // Reading a list of digests back is a command of its own inside this one.
    const check = await t.run('sha256sum -c a.txt')
    assert.deepEqual(check.unsupported.map((u) => u.detail), ['-c'])
    assert.equal(check.stderr, 'sha256sum: reading a list of digests back is not supported\n')
    const unknown = await t.run('sha256sum --quiet a.txt')
    assert.deepEqual(unknown.unsupported.map((u) => u.detail), ['--quiet'])
  })

  it('is there without being announced, and completes like the rest', async () => {
    const t = terminal()
    // Reachable under the bin names, as the other commands are.
    assert.deepEqual(await t.run('/usr/bin/sha256sum a.txt'), result(`${DIGESTS[256]}  a.txt\n`))
    assert.equal((await t.run('which shasum')).stdout, '/usr/bin/shasum\n')
    // Completed in command position and after a pipe…
    assert.deepEqual(t.complete('sha2'), ['sha256sum'])
    assert.deepEqual(t.complete('cat a.txt | sha5'), ['cat a.txt | sha512sum'])
    // …and absent from the list of what the terminal announces.
    assert.doesNotMatch((await t.run('frobnicate')).stderr, /sha|shasum/u)
  })
})

// How the file was read is one setting for coreutils, written over by each of
// `-b`, `-t` and `--tag` in turn, and two separate ones for shasum, which
// calls having both ambiguous. Either way, asking for `--tag` and for text is
// asking for both of two things, which both tools refuse. Recorded from
// sha256sum 9.4 and shasum 6.04.
describe('the file mode is the last thing said about it, and --tag says binary', () => {
  const HELP = { sha256sum: "Try 'sha256sum --help' for more information.\n", shasum: 'Type shasum -h for help\n' }
  const refused = (cmd, why) => result('', { stderr: `${cmd}: ${why}\n${HELP[cmd]}`, exitCode: 1 })

  it('writes over the mode in the order coreutils reads it', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('sha256sum -b a.txt'), result(`${DIGESTS[256]} *a.txt\n`))
    assert.deepEqual(await t.run('sha256sum -t a.txt'), result(`${DIGESTS[256]}  a.txt\n`))
    // The last of them wins, which is what writing over means.
    assert.deepEqual(await t.run('sha256sum -b -t a.txt'), result(`${DIGESTS[256]}  a.txt\n`))
    assert.deepEqual(await t.run('sha256sum -t -b a.txt'), result(`${DIGESTS[256]} *a.txt\n`))
    assert.deepEqual(await t.run('sha256sum --binary --text a.txt'), result(`${DIGESTS[256]}  a.txt\n`))
  })

  it('refuses --tag with text, where text is what was said last', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('sha256sum --tag -t a.txt'), refused('sha256sum', '--tag does not support --text mode'))
    assert.deepEqual(await t.run('sha256sum --tag --text a.txt'), refused('sha256sum', '--tag does not support --text mode'))
    assert.deepEqual(await t.run('sha256sum --tag -b -t a.txt'), refused('sha256sum', '--tag does not support --text mode'))
    // `--tag` says binary itself, so text said before it is written over.
    assert.deepEqual(await t.run('sha256sum -t --tag a.txt'), result(`SHA256 (a.txt) = ${DIGESTS[256]}\n`))
    assert.deepEqual(await t.run('sha256sum --text --tag a.txt'), result(`SHA256 (a.txt) = ${DIGESTS[256]}\n`))
    assert.deepEqual(await t.run('sha256sum --tag -t -b a.txt'), result(`SHA256 (a.txt) = ${DIGESTS[256]}\n`))
  })

  it('keeps the two apart for shasum, which calls having both ambiguous', async () => {
    const t = terminal()
    // Order does not settle it there: either way round is the same refusal.
    assert.deepEqual(await t.run('shasum -b -t a.txt'), refused('shasum', 'Ambiguous file mode'))
    assert.deepEqual(await t.run('shasum -t -b a.txt'), refused('shasum', 'Ambiguous file mode'))
    assert.deepEqual(await t.run('shasum --tag -t -b a.txt'), refused('shasum', 'Ambiguous file mode'))
    // And `--tag` with text is refused whichever order they came in.
    assert.deepEqual(await t.run('shasum --tag -t a.txt'), refused('shasum', '--tag does not support --text mode'))
    assert.deepEqual(await t.run('shasum -t --tag a.txt'), refused('shasum', '--tag does not support --text mode'))
    assert.deepEqual(await t.run('shasum --tag -a 256 -t a.txt'), refused('shasum', '--tag does not support --text mode'))
    assert.deepEqual(await t.run('shasum --tag -b a.txt'), result(`SHA1 (a.txt) = ${DIGESTS[1]}\n`))
  })
})
