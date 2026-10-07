import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Each row was run through ripgrep 14.1 over the same files on disk, and is
// what it printed: stdout, stderr and the exit status. A walk is piped through
// sort, since ripgrep's threads print in the order they finish.
const bytes = (text) => Uint8Array.from(text, (c) => c.codePointAt(0))
const FILES = {
  f: 'foo\nbar\n',
  s1: bytes('foo\0bar\nfoo\n'),
  s2: bytes('a\nfoo\0\n'),
  'd/big': bytes('foo\n' + 'x'.repeat(70000) + '\n\0\nfoo\n'),
  'd/small': bytes('foo\n\0foo\n'),
  'd/t.txt': 'foo text\n',
  'e/u.txt': 'bar\n',
  'u.txt': 'oék\nok\nołk\n',
  'w/long': 'x'.repeat(70000) + '\nfoo\n',
  'w/late': bytes('foo\n' + 'y\n'.repeat(35000) + '\0\n'),
}

async function check(command, stdout, stderr, exitCode) {
  const r = await createTerminal(FILES).run(command)
  const actual = { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, unsupported: r.unsupported }
  assert.deepEqual(actual, { stdout, stderr, exitCode, unsupported: [] }, command)
}

const CASES = {
  'standard input is named <stdin>': [
    [String.raw`echo foo | rg -H foo`, '<stdin>:foo\n', '', 0],
    [String.raw`echo foo | rg -c -H foo`, '<stdin>:1\n', '', 0],
    [String.raw`rg -H foo - < f`, '<stdin>:foo\n', '', 0],
    [String.raw`echo foo | rg -l foo`, '<stdin>\n', '', 0],
    [String.raw`echo foo | rg --files-without-match bar`, '<stdin>\n', '', 0],
    [String.raw`echo foo | rg foo - f`, '<stdin>:foo\nf:foo\n', '', 0],
    [String.raw`echo foo | rg -n --with-filename o`, '<stdin>:1:foo\n', '', 0],
  ],
  'standard input holding a NUL is read as ripgrep converts it': [
    [String.raw`cat s1 | rg foo`, 'binary file matches (found "\\0" byte around offset 3)\n', '', 0],
    [String.raw`cat s1 | rg -H foo`, '<stdin>: binary file matches (found "\\0" byte around offset 3)\n', '', 0],
    [String.raw`cat s1 | rg -c foo`, '2\n', '', 0],
    [String.raw`cat s1 | rg -n foo`, 'binary file matches (found "\\0" byte around offset 3)\n', '', 0],
    [String.raw`cat s1 | rg zzz`, '', '', 1],
    [String.raw`cat s1 | rg -l foo`, '<stdin>\n', '', 0],
    [String.raw`cat s1 | rg -v foo`, 'binary file matches (found "\\0" byte around offset 3)\n', '', 0],
    [String.raw`cat s1 | rg bar`, 'binary file matches (found "\\0" byte around offset 3)\n', '', 0],
    [String.raw`cat s2 | rg a`, 'a\nbinary file matches (found "\\0" byte around offset 5)\n', '', 0],
    [String.raw`cat s2 | rg foo`, 'binary file matches (found "\\0" byte around offset 5)\n', '', 0],
    [String.raw`cat s2 | rg -c foo`, '1\n', '', 0],
    [String.raw`rg foo < s1`, 'binary file matches (found "\\0" byte around offset 3)\n', '', 0],
  ],
  'a walked file holding a NUL is read up to the fill that brings it': [
    [String.raw`{ rg foo d; echo rc=$?; } | sort`, 'd/big: WARNING: stopped searching binary file after match (found "\\0" byte around offset 70005)\nd/big:foo\nd/t.txt:foo text\nrc=0\n', '', 0],
    [String.raw`{ rg -n foo d; echo rc=$?; } | sort`, 'd/big: WARNING: stopped searching binary file after match (found "\\0" byte around offset 70005)\nd/big:1:foo\nd/t.txt:1:foo text\nrc=0\n', '', 0],
    [String.raw`{ rg -c foo d; echo rc=$?; } | sort`, 'd/t.txt:1\nrc=0\n', '', 0],
    [String.raw`{ rg -l foo d; echo rc=$?; } | sort`, 'd/big\nd/t.txt\nrc=0\n', '', 0],
    [String.raw`{ rg x d; echo rc=$?; } | sort`, 'd/t.txt:foo text\nrc=0\n', '', 0],
    [String.raw`rg -q foo d; echo $?`, '0\n', '', 0],
  ],
  '--files-without-match exits 0 where it answered for a file': [
    [String.raw`{ rg --files-without-match foo d e; echo rc=$?; } | sort`, 'e/u.txt\nrc=0\n', '', 0],
    [String.raw`rg --files-without-match bar e; echo $?`, '1\n', '', 0],
    [String.raw`{ rg --files-without-match foo d; echo rc=$?; } | sort`, 'rc=0\n', '', 0],
    [String.raw`rg --files-without-match zzz f; echo $?`, 'f\n0\n', '', 0],
    [String.raw`rg --files-without-match foo f; echo $?`, '1\n', '', 0],
    [String.raw`{ rg --files-without-match zzz d; echo rc=$?; } | sort`, 'd/t.txt\nrc=0\n', '', 0],
  ],
}

describe('rg reads standard input and binary files as ripgrep 14.1 does', () => {
  for (const [title, cases] of Object.entries(CASES)) {
    describe(title, () => {
      for (const [command, stdout, stderr, exitCode] of cases) it(command, () => check(command, stdout, stderr, exitCode))
    })
  }
})

describe('rg keeps a refusal through the output it rewrites', () => {
  // A count and a --files-without-match rewrite what grep printed, and its
  // status; grep's refusal under them is still a refusal, not a plain exit 2.
  // ripgrep reads `.` as any Unicode character, which is not followed here.
  for (const command of [String.raw`rg -c 'o.k' u.txt`, String.raw`rg -c 'o.k' u.txt f`,
    String.raw`rg --files-without-match 'o.k' u.txt f`, String.raw`rg -l 'o.k' u.txt`]) {
    it(command, async () => {
      const r = await createTerminal(FILES).run(command)
      assert.deepEqual(r.unsupported.map((u) => u.detail), ['non-ASCII matching'], command)
      assert.equal(r.exitCode, 2)
      assert.equal(r.stdout, '')
    })
  }
})

describe('rg refuses a binary read that turns on the order ripgrep searched in', () => {
  // A line over 64 KiB grows the buffer a thread reads with, and a NUL past
  // the first 64 KiB of a file that thread searches later is then met a fill
  // sooner. A count and a --files-without-match read every such file to its
  // NUL whatever the buffer, and are answered.
  it('refuses a search that would print from the late binary file', async () => {
    for (const command of ['rg foo w', 'rg -l foo w', 'rg -q foo w']) {
      const r = await createTerminal(FILES).run(command)
      assert.deepEqual(r.unsupported.map((u) => u.detail), ['binary file search order'], command)
    }
  })
  it('answers a count and a --files-without-match', async () => {
    await check('rg -c foo w', 'w/long:1\n', '', 0)
    await check('rg --files-without-match foo w', '', '', 0)
  })
})
