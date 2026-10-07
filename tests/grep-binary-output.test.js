import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { encodeUtf8 } from '../src/util.js'

// What GNU grep 3.11 does with a file that is not text, in C.UTF-8. Every
// answer here is what it gave over the same bytes on disk.
//
// A NUL in GNU's first read makes the whole file binary: records end at each
// NUL as at a newline, nothing of the file is printed, and a selection only
// says that it matches. A byte that spells no character makes only the lines
// holding one binary: GNU still searches them, holds back each one it would
// print — selected or context — and says the file matches once it is done.
const bytes = (...parts) => Uint8Array.from(parts.flatMap((part) => (typeof part === 'string' ? [...encodeUtf8(part)] : part)))

const FILES = {
  mid: bytes('foo1\ncaf', [0xe9], ' foo2\nfoo3\n'),
  ctx: bytes('foo\nc', [0xe9], '\nbar\nfoo2\n'),
  q1: bytes('a\nfoo', [0xff], '\nb\n'),
  q3: bytes('x\nfoo', [0xff], '\ny\nfoo\nz\n'),
  o1: bytes('ab', [0xff], 'cd ab\n'),
  e9: bytes('a', [0xe9], '\n'),
  x80: bytes('a', [0x80], '\n'),
  e9b: bytes([0xe9], 'b\n'),
  d7b: bytes([0xd7], 'b\n'),
  wfoo: bytes('foo', [0xff], '\n'),
  // U+110000 in four bytes, which glibc reads as a character, and U+D800 in
  // three, which only glibc's regex does.
  long: bytes('a', [0xf4, 0x90, 0x80, 0x80], 'b foo\n'),
  surr: bytes('a', [0xed, 0xa0, 0x80], 'b foo\n'),
  nul: bytes('x\0y\nfoo\n'),
  text: bytes('foo\nbar\n'),
  // GNU reads 96 KiB of a file first, and 64 KiB of a pipe.
  late: bytes('foo\n', 'x'.repeat(100000), '\n\0foo\n'),
  pipe: bytes('foo\n', 'x'.repeat(70000), '\n\0foo\n'),
  straddle: bytes('foo\n', 'x'.repeat(98310), '\nfoo here\n\0foo\n'),
  // A last line no newline ends, and a file of such lines past the first read.
  tail: bytes('foo1\nfoo2 caf', [0xe9], '\nfoo3'),
  big: bytes(...Array.from({ length: 12000 }, (_, i) => (i % 7 === 3 ? ['caf', [0xe9], ` ${i}\n`] : [`line ${i}\n`])).flat()),
}

async function check(command, stdout, stderr = '', exitCode = 0) {
  assert.deepEqual(await createTerminal(FILES).run(command), { stdout, stderr, exitCode, cwd: '/', notes: [], unsupported: [] }, command)
}

async function refuses(command, detail, message) {
  const result = await createTerminal(FILES).run(command)
  assert.deepEqual([result.stdout, result.exitCode, result.unsupported], ['', 2, [{ kind: 'feature', command: 'grep', detail, message }]], command)
}

describe('grep over a file that is not text', () => {
  it('prints the lines that are text and holds back the rest, saying so once it is done', async () => {
    await check('grep foo mid', 'foo1\nfoo3\n', 'grep: mid: binary file matches\n')
    await check('grep -n foo mid', '1:foo1\n3:foo3\n', 'grep: mid: binary file matches\n')
    await check('grep -v zzz mid', 'foo1\nfoo3\n', 'grep: mid: binary file matches\n')
    await check('grep foo3 mid', 'foo3\n')
    await check('grep -m1 foo mid', 'foo1\n')
  })

  it('counts, lists and prints matches without holding anything back', async () => {
    await check('grep -c foo mid', '3\n')
    await check('grep -l foo mid', 'mid\n')
    await check('grep -o foo mid', 'foo\nfoo\nfoo\n')
  })

  it('holds the same lines back silently under -I, and none under -a', async () => {
    await check('grep -I foo mid', 'foo1\nfoo3\n')
    await check('grep -a foo mid | base64', 'Zm9vMQpjYWbpIGZvbzIKZm9vMwo=\n')
  })

  it('goes on with context as if a held-back line had not been there', async () => {
    await check('grep -B1 bar ctx', 'bar\n', 'grep: ctx: binary file matches\n')
    await check('grep -B2 bar ctx', 'foo\nbar\n', 'grep: ctx: binary file matches\n')
    await check('grep -A1 foo ctx', 'foo\n--\nfoo2\n', 'grep: ctx: binary file matches\n')
    await check('grep -A2 foo ctx', 'foo\n--\nfoo2\n', 'grep: ctx: binary file matches\n')
  })

  it('owes trailing context from the top of a file nothing of which was printed yet', async () => {
    await check('grep -A1 foo q1', 'a\n', 'grep: q1: binary file matches\n')
    await check('grep -A1 foo q3', 'x\n--\nfoo\nz\n', 'grep: q3: binary file matches\n')
    await check('grep -C1 foo q3', 'x\n--\ny\nfoo\nz\n', 'grep: q3: binary file matches\n')
  })

  it('takes such a byte for no character, and reads a word edge beside it as glibc does', async () => {
    await check('grep -c \'b.c\' o1', '0\n', '', 1)
    await check('grep -o \'b.*\' o1', 'b\nb\n')
    await check('grep -o \'[a-d]*\' o1', 'ab\ncd\nab\n')
    await check('grep \'a\\>\' e9', '', '', 1)
    await check('grep \'a\\>\' x80', '', 'grep: x80: binary file matches\n')
    await check('grep \'\\<b\' e9b', '', '', 1)
    await check('grep \'\\<b\' d7b', '', 'grep: d7b: binary file matches\n')
    await check('grep \'foo\\>\' wfoo', '', '', 1)
    await check('grep -w foo wfoo', '', 'grep: wfoo: binary file matches\n')
  })

  it('prints a line whose only such run glibc reads as a character past U+10FFFF', async () => {
    await check('grep foo long | base64', 'YfSQgIBiIGZvbwo=\n')
    await check('grep -c a.b long', '0\n', '', 1)
  })

  it('says a file holding a NUL matches and prints none of it', async () => {
    await check('grep foo nul', '', 'grep: nul: binary file matches\n')
    await check('grep -n foo nul', '', 'grep: nul: binary file matches\n')
    await check('grep -o foo nul', '', 'grep: nul: binary file matches\n')
    await check('grep -v zzz nul', '', 'grep: nul: binary file matches\n')
  })

  it('ends records at a NUL in the modes that print no line', async () => {
    await check('grep -c y nul', '1\n')
    await check('grep -c \'^y\' nul', '1\n')
    await check('grep -cx y nul', '1\n')
    await check('grep -l y nul', 'nul\n')
    await check('grep -L y nul', '')
  })

  it('separates the next file\'s context from a binary match', async () => {
    await check('grep -A1 foo nul text', '--\ntext:foo\ntext-bar\n', 'grep: nul: binary file matches\n')
    await check('grep -A0 foo nul text', '--\ntext:foo\n', 'grep: nul: binary file matches\n')
  })

  it('writes each file\'s lines and what it says of the file in order', async () => {
    await check('grep foo text nul text 2>&1', 'text:foo\ngrep: nul: binary file matches\ntext:foo\n')
    await check('grep -c foo text nul 2>&1', 'text:1\nnul:1\n')
  })

  it('names standard input as GNU does', async () => {
    await check('cat nul | grep foo', '', 'grep: (standard input): binary file matches\n')
    await check('grep foo < nul', '', 'grep: (standard input): binary file matches\n')
  })

  it('prints what GNU\'s first read held before a NUL found past it', async () => {
    await check('grep foo late', 'foo\n', 'grep: late: binary file matches\n')
    await check('grep -c foo late', '2\n')
    await check('grep foo pipe', '', 'grep: pipe: binary file matches\n')
    await check('cat pipe | grep foo', 'foo\n', 'grep: (standard input): binary file matches\n')
  })

  it('searches a last line no newline ends on its own, after the rest', async () => {
    // GNU forgets where it last printed before that line unless the context
    // it keeps for it begins there, so a held-back line before it shows as a
    // group separator with -A and as nothing with -C.
    await check('grep -vA1 zzz tail', 'foo1\n--\nfoo3\n', 'grep: tail: binary file matches\n')
    await check('grep -vC1 zzz tail', 'foo1\nfoo3\n', 'grep: tail: binary file matches\n')
  })

  it('refuses context around held-back lines past the first read, which later reads decide', async () => {
    await refuses('grep -A1 line big', 'binary context across reads', 'grep: context around lines held back past the first read is not supported')
    await check('grep -c caf big', '1714\n')
  })

  it('refuses where what GNU prints depends on how much it reads at a time', async () => {
    // `foo here` ends past the first read and before the NUL's line.
    await refuses('grep foo straddle', 'late binary detection', 'grep: binary detection after the initial input buffer is not supported')
    await check('grep -c foo straddle', '3\n')
  })

  it('refuses where glibc and GNU\'s own matcher read a run differently', async () => {
    // A set spelt by what it leaves out takes U+110000 for a character, and
    // what -o prints is glibc's regex reading, which takes U+D800 for one.
    const message = 'grep: matching this pattern beside bytes glibc reads as a character is not supported'
    await refuses("grep 'a[^x]b' long", 'binary input', message)
    await refuses("grep -o 'a.*' surr", 'binary input', message)
    await check('grep -o foo surr', 'foo\n')
  })

  it('refuses PCRE over bytes that are not UTF-8, which PCRE reads by its own rules', async () => {
    await refuses('grep -P foo mid', 'binary input', 'grep: PCRE matching over bytes that spell no text is not supported')
  })

  it('refuses a pattern holding an unpaired surrogate over bytes, which no bytes spell', async () => {
    // A byte that spells no character is read as such a surrogate, and must
    // not be taken for one a pattern names.
    for (const command of ["grep -cF '\uDCFF' x80", "grep -c 'a\uDCE9' e9"]) {
      await refuses(command, 'unpaired surrogate', 'grep: a pattern holding an unpaired UTF-16 surrogate cannot be matched against bytes')
    }
  })

  it('writes the name in front of a line of bytes as text, whatever it holds', async () => {
    // A name holding an unpaired surrogate is refused where it is written as
    // bytes, as it is beside a file of text, rather than spelt as a byte.
    const name = 'n\uDCFF'
    const t = createTerminal({ [name]: bytes('foo', [0xe9], '\nfoo\n'), text: 'foo\n' })
    const asText = await t.run('grep -H foo n* | base64')
    assert.deepEqual([asText.stdout, asText.unsupported.map((u) => u.detail)], ['', ['unpaired surrogate']])
    const asBytes = await t.run('grep -aH foo n* | base64')
    assert.deepEqual([asBytes.stdout, asBytes.stderr, asBytes.unsupported.map((u) => u.detail)], ['', 'grep: unpaired UTF-16 surrogates cannot be encoded as UTF-8\n', ['unpaired surrogate']])
    // An ordinary name in front of such a line is the name's own UTF-8.
    await check('grep -aH foo mid | base64', 'bWlkOmZvbzEKbWlkOmNhZukgZm9vMgptaWQ6Zm9vMwo=\n')
  })
})
