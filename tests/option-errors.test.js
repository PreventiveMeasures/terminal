// A command line getopt could not finish reading is answered in the words
// of the tool it was handed to: getopt's own line naming the program by what
// it was run as, then whatever that tool adds. Every expectation here is what
// coreutils 9.4, grep 3.11, gzip 1.12, diffutils 3.10, patch 2.7.6 and
// tree 2.1.1 printed.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = { a: '1\n' }
const run = (command) => createTerminal(FILES).run(command)
const failed = (stderr, exitCode = 1) => ({ stdout: '', stderr, exitCode, cwd: '/', notes: [], unsupported: [] })
const coreutils = (name, line, exitCode = 1) => failed(`${name}: ${line}\nTry '${name} --help' for more information.\n`, exitCode)

describe('missing option arguments and arguments to flags', () => {
  for (const [command, name, line, exitCode] of [
    ['head -n', 'head', "option requires an argument -- 'n'"],
    ['tail -c', 'tail', "option requires an argument -- 'c'"],
    ['cut -f', 'cut', "option requires an argument -- 'f'"],
    ['uniq -w', 'uniq', "option requires an argument -- 'w'"],
    ['nl --starting-line-number', 'nl', "option '--starting-line-number' requires an argument"],
    ['seq -s', 'seq', "option requires an argument -- 's'"],
    ['xargs -I', 'xargs', "option requires an argument -- 'I'"],
    ['base64 --decode=x', 'base64', "option '--decode' doesn't allow an argument"],
    ['tee --append=1', 'tee', "option '--append' doesn't allow an argument"],
    ['/usr/bin/head -n', '/usr/bin/head', "option requires an argument -- 'n'"],
    ['sort -k', 'sort', "option requires an argument -- 'k'", 2],
    ['sort --output', 'sort', "option '--output' requires an argument", 2],
  ]) {
    it(command, async () => assert.deepEqual(await run(command), coreutils(name, line, exitCode)))
  }

  it('names the command xargs ran', async () => {
    assert.deepEqual(await run('xargs head -n < /dev/null'), coreutils('head', "option requires an argument -- 'n'", 123))
  })

  it('in the words of the tools that part ways from coreutils', async () => {
    assert.deepEqual(await run('grep -e'), failed("grep: option requires an argument -- 'e'\nUsage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n", 2))
    assert.deepEqual(await run('diff -U'), failed("diff: option requires an argument -- 'U'\ndiff: Try 'diff --help' for more information.\n", 2))
    assert.deepEqual(await run('patch -p'), failed("patch: option requires an argument -- 'p'\npatch: Try 'patch --help' for more information.\n", 2))
    assert.deepEqual(await run('tree -L'), failed('tree: Missing argument to -L option.\n'))
  })

  it('refuses where the tool goes on to print a usage text this does not carry', async () => {
    for (const [command, cmd, detail] of [['awk -F', 'awk', '-F'], ['sed --expression', 'sed', '--expression'], ['xxd -s', 'xxd', '-s']]) {
      const r = await run(command)
      assert.equal(r.exitCode, 1, command)
      assert.deepEqual(r.unsupported.map(({ kind, command: name, detail: what }) => ({ kind, command: name, detail: what })), [{ kind: 'option', command: cmd, detail }], command)
    }
  })
})
